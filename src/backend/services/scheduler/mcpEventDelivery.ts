import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type {
  McpEventTriggerConfig,
  PlannedExecution,
  PlannedExecutionState,
  RunRecord,
  TriggerFirePayload,
} from '@/shared/types/plannedExecution';
import { mcpEventDelivery, mcpEventSource, type McpEventDeliveryMode } from '@/shared/types/plannedExecution';
import { mcpEventFingerprint, verifyMcpEventSignature } from './triggers/mcpEvent';
import { composeTriggerPrompt } from './triggerPrompt';
import type { EventSteeringOutcome, EventSteeringRequest } from './eventSteering';
import type { McpInboundEvent } from '@/backend/services/mcp/inboundEvents';
import type { ChannelDeliveryOutcome } from './triggers/claudeChannel';
import type { HeldDeliveryOutcome } from './triggers/heldEventQueue';
import type { McpEventOccurrence } from '@/backend/services/mcp/serverEvents';

const MAX_BODY_BYTES = 256 * 1024;
const MAX_SEEN_IDS = 1000;
const BUSY_RETRY_SECONDS = 5;
const PAUSED_RETRY_SECONDS = 30;

export interface McpEventScheduler {
  get(id: string): Promise<PlannedExecution | null | undefined>;
  isPaused(): Promise<boolean>;
  isRunning(id: string): boolean;
  exclusiveGateFor(execution: PlannedExecution): 'queue' | 'skip' | 'error' | null;
  fire(execution: PlannedExecution, payload: TriggerFirePayload, runId?: string): Promise<RunRecord>;
  admitPersonaFire(
    execution: PlannedExecution,
    payload: TriggerFirePayload,
    runId?: string,
  ): Promise<{ runId: string; record?: RunRecord; completion: Promise<unknown> }>;
}

export interface McpEventDeliveryDeps {
  scheduler: McpEventScheduler;
  loadState: (id: string) => Promise<PlannedExecutionState>;
  updateState: (id: string, update: (current: PlannedExecutionState) => PlannedExecutionState) => Promise<unknown>;
  /** Hands an event to a running conversation (#1401). Absent: events always start runs. */
  steer?: (request: EventSteeringRequest) => Promise<EventSteeringOutcome>;
  /** A note for the automation card (skipped events, ended subscription). */
  onNotice?: (executionId: string, message: string) => void;
  onBackgroundError?: (message: string, error: unknown) => void;
  now?: () => number;
}

export interface McpEventDeliveryInput {
  id: string;
  fingerprint: string | null;
  webhookId: string | null;
  webhookTimestamp: string | null;
  webhookSignature: string | null;
  body: string;
}

export interface McpEventDeliveryResult {
  status: number;
  body: Record<string, unknown>;
  retryAfterSeconds?: number;
}

export type McpEventExecution = PlannedExecution & { trigger: McpEventTriggerConfig };

/** One event on its way in, with the key that recognises it again. */
export interface McpEventItem<T = unknown> {
  key: string;
  /** Older keys that also mean "already seen". */
  aliases?: string[];
  /** The server's resume point after this event, saved once it is accepted. */
  cursor?: string;
  payload: T;
}

const busy = (error: string, retryAfterSeconds: number): McpEventDeliveryResult =>
  ({ status: 503, body: { error }, retryAfterSeconds });

export const GONE: McpEventDeliveryResult = { status: 410, body: { error: 'This subscription is no longer in use' } };

/** The execution, if it still takes events of this kind (and, for events, this delivery mode). */
export function activeMcpEventExecution(
  execution: PlannedExecution | null | undefined,
  source: 'events' | 'claude-channel',
  delivery?: McpEventDeliveryMode,
): McpEventExecution | null {
  if (
    !execution
    || execution.trigger.type !== 'mcp-event'
    || !execution.enabled
    || execution.personaRetired
    || execution.personaArchived
    || mcpEventSource(execution.trigger) !== source
    || (delivery !== undefined && mcpEventDelivery(execution.trigger) !== delivery)
  ) return null;
  return execution as McpEventExecution;
}

/**
 * The saved cursor, if it belongs to this subscription. Cursors saved before
 * `eventCursorFor` existed came from webhook subscriptions and are still used.
 */
export function resumeCursor(
  state: PlannedExecutionState,
  trigger: Pick<McpEventTriggerConfig, 'serverName' | 'eventName' | 'arguments'>,
): string | null {
  if (!state.eventCursor) return null;
  if (state.eventCursorFor && state.eventCursorFor !== mcpEventFingerprint(trigger)) return null;
  return state.eventCursor;
}

/** A state update that saves a cursor together with the subscription it belongs to. */
export function withEventCursor(
  state: PlannedExecutionState,
  trigger: Pick<McpEventTriggerConfig, 'serverName' | 'eventName' | 'arguments'>,
  cursor: string,
): PlannedExecutionState {
  return { ...state, eventCursor: cursor, eventCursorFor: mcpEventFingerprint(trigger) };
}

/**
 * Accepts one signed event. The sender keeps a durable log and retries, so this
 * says 503 instead of queueing in memory: anything FLUJO could not start stays
 * safely with the sender. 410 refuses this delivery for good.
 */
export async function receiveMcpEvent(
  deps: McpEventDeliveryDeps,
  input: McpEventDeliveryInput,
): Promise<McpEventDeliveryResult> {
  const execution = activeMcpEventExecution(await deps.scheduler.get(input.id), 'events', 'webhook');
  if (!execution || input.fingerprint !== mcpEventFingerprint(execution.trigger)) return GONE;
  const trigger = execution.trigger;

  if (Buffer.byteLength(input.body) > MAX_BODY_BYTES) return { status: 413, body: { error: 'Payload too large' } };
  const signed = verifyMcpEventSignature(
    trigger.secret,
    { id: input.webhookId, timestamp: input.webhookTimestamp, signature: input.webhookSignature },
    input.body,
    deps.now?.(),
  );
  if (!signed) return { status: 401, body: { error: 'Invalid signature' } };
  const webhookId = input.webhookId!;

  let event: {
    eventId?: unknown;
    name?: unknown;
    timestamp?: unknown;
    data?: unknown;
    cursor?: unknown;
    type?: unknown;
    challenge?: unknown;
  };
  try {
    event = JSON.parse(input.body);
  } catch {
    return { status: 400, body: { error: 'Body is not valid JSON' } };
  }
  if (!event || typeof event !== 'object') return { status: 400, body: { error: 'Body is not an event' } };

  // Control envelopes of the current draft, told apart by a top-level `type`.
  if (event.name === undefined && typeof event.type === 'string') {
    return receiveControlEnvelope(deps, execution, event);
  }
  if (event.name !== trigger.eventName) return { status: 400, body: { error: 'Unexpected event name' } };

  // `eventId` names the event, `webhook-id` one message about it. A server may
  // send the same event again in a new message (a replay from a cursor), so
  // the event id is the key; the message id still counts as seen.
  const eventId = typeof event.eventId === 'string' && event.eventId ? event.eventId : webhookId;
  const cursor = typeof event.cursor === 'string' ? event.cursor : undefined;
  return admitMcpEvents(deps, execution, [{
    key: eventId,
    aliases: eventId === webhookId ? undefined : [webhookId],
    cursor,
    payload: event,
  }], ([item]) => ({
    summary: `${trigger.serverName}: ${trigger.eventName}`,
    context: {
      event: {
        eventId: item.key,
        name: item.payload.name,
        timestamp: item.payload.timestamp,
        data: item.payload.data,
      },
    },
  }));
}

async function receiveControlEnvelope(
  deps: McpEventDeliveryDeps,
  execution: McpEventExecution,
  envelope: { type?: unknown; challenge?: unknown; cursor?: unknown },
): Promise<McpEventDeliveryResult> {
  switch (envelope.type) {
    case 'verification':
      // The server checks that this endpoint is really ours before it delivers.
      if (typeof envelope.challenge !== 'string') return { status: 400, body: { error: 'Missing challenge' } };
      return { status: 200, body: { challenge: envelope.challenge } };
    case 'gap':
      // Events were skipped. Resume after the gap; tell the user.
      if (typeof envelope.cursor === 'string') {
        const cursor = envelope.cursor;
        await deps.updateState(execution.id, current => withEventCursor(current, execution.trigger, cursor));
      }
      deps.onNotice?.(execution.id, 'The server skipped some events. Runs for them did not happen.');
      return { status: 200, body: { accepted: true } };
    case 'terminated':
      deps.onNotice?.(execution.id, 'The server ended the subscription. FLUJO subscribes again within a few minutes.');
      return { status: 200, body: { accepted: true } };
    default:
      return { status: 400, body: { error: 'Unknown control message' } };
  }
}

/**
 * Starts work for events that passed their source's checks: a steered message
 * in a running conversation, a durable Persona admission, or a new run. Seen
 * keys are remembered only after that worked, so nothing is lost on the way.
 */
export async function admitMcpEvents<T>(
  deps: McpEventDeliveryDeps,
  execution: McpEventExecution,
  items: McpEventItem<T>[],
  describe: (fresh: McpEventItem<T>[]) => { summary: string; context: Record<string, unknown> },
): Promise<McpEventDeliveryResult> {
  const { scheduler } = deps;
  const trigger = execution.trigger;
  const state = await deps.loadState(execution.id);
  const seen = new Set(state.seenIds ?? []);
  const fresh = items.filter(item => !seen.has(item.key) && !item.aliases?.some(alias => seen.has(alias)));
  // Every item before the last is either already seen or accepted now, so the
  // last item's resume point is safe to keep.
  const cursor = items.map(item => item.cursor).filter((value): value is string => Boolean(value)).at(-1);
  if (fresh.length === 0) {
    if (cursor) await deps.updateState(execution.id, current => withEventCursor(current, trigger, cursor));
    return { status: 200, body: { accepted: true, duplicate: true } };
  }

  if (await scheduler.isPaused()) return busy('Planned executions are paused', PAUSED_RETRY_SECONDS);
  if (scheduler.exclusiveGateFor(execution)) return busy('Another automation holds the scheduler', BUSY_RETRY_SECONDS);

  const keys = fresh.map(item => item.key);
  const digest = createHash('sha256')
    .update(`${execution.id}\0${execution.generationId ?? execution.createdAt}\0${keys.join('\0')}`)
    .digest('hex');
  const { summary, context } = describe(fresh);
  const remember = () => deps.updateState(execution.id, (current) => {
    const next = { ...current, seenIds: [...(current.seenIds ?? []), ...keys].slice(-MAX_SEEN_IDS) };
    return cursor ? withEventCursor(next, trigger, cursor) : next;
  });

  if (trigger.steerConversationId && deps.steer) {
    const outcome = await deps.steer({
      conversationId: trigger.steerConversationId,
      messageId: `mcp-event-${digest.slice(0, 40)}`,
      content: composeTriggerPrompt(execution.prompt, { context }, {
        executionName: execution.name,
        trigger: 'mcp-event',
        now: new Date(deps.now?.() ?? Date.now()).toISOString(),
      }),
      provenance: {
        executionId: execution.id,
        executionName: execution.name,
        serverName: trigger.serverName,
        source: mcpEventSource(trigger),
      },
    });
    if (outcome.kind === 'delivered') {
      await remember();
      return { status: 200, body: { accepted: true, steered: true, conversationId: trigger.steerConversationId } };
    }
    if (outcome.kind === 'busy') return busy(outcome.reason, BUSY_RETRY_SECONDS);
    // Not running: start a run as usual.
  }

  const payload: TriggerFirePayload = {
    kind: 'mcp-event',
    summary,
    context,
    ...(execution.personaId ? { deliveryId: `mcp-event-${digest}` } : {}),
  };

  if (execution.personaId) {
    try {
      const admitted = await scheduler.admitPersonaFire(execution, payload, `delivery-${digest.slice(0, 48)}`);
      void admitted.completion.catch(error => deps.onBackgroundError?.('Persona event continuation failed', error));
      if (admitted.record && !admitted.record.conditionRejected) return busy('The Persona could not take this event yet', BUSY_RETRY_SECONDS);
      await remember();
      return { status: admitted.record ? 200 : 202, body: { accepted: !admitted.record, runId: admitted.runId } };
    } catch {
      return busy('The event could not be durably admitted', BUSY_RETRY_SECONDS);
    }
  }

  if (scheduler.isRunning(execution.id) && execution.overlapStrategy !== 'parallel') {
    return busy('A previous run is still in progress', BUSY_RETRY_SECONDS);
  }
  const runId = uuidv4();
  void scheduler.fire(execution, payload, runId).catch(error => deps.onBackgroundError?.('Event run failed', error));
  await remember();
  return { status: 202, body: { accepted: true, runId } };
}

/**
 * Claude channel messages for one automation (#1401). Same checks, dedup,
 * steering and run start as webhook events; a burst arrives as one batch and
 * becomes one run. There is no sender to retry, so the caller holds a busy
 * batch briefly (see triggers/claudeChannel.ts).
 */
export async function deliverClaudeChannelEvents(
  deps: McpEventDeliveryDeps,
  executionId: string,
  events: McpInboundEvent[],
): Promise<ChannelDeliveryOutcome> {
  const execution = activeMcpEventExecution(await deps.scheduler.get(executionId), 'claude-channel');
  if (!execution) return 'gone';
  const serverName = execution.trigger.serverName;
  const items = events
    .filter(event => event.serverName === serverName)
    .map(event => ({ key: event.deliveryId, payload: event }));
  if (items.length === 0) return 'gone';
  const result = await admitMcpEvents(deps, execution, items, fresh => ({
    summary: fresh.length === 1 ? `${serverName}: channel message` : `${serverName}: ${fresh.length} channel messages`,
    context: {
      channel: { server: serverName, delivery: 'no guarantee' },
      messages: fresh.map(({ payload }) => ({
        content: payload.content,
        meta: payload.meta,
        receivedAt: payload.receivedAt,
      })),
    },
  }));
  if (result.status === 503) return 'busy';
  if (result.status === 410) return 'gone';
  return result.body.duplicate ? 'duplicate' : 'accepted';
}

/** What a run sees of one event: the same shape webhook events have. */
function eventContext(event: McpEventOccurrence) {
  return { eventId: event.eventId, name: event.name, timestamp: event.timestamp, data: event.data };
}

/**
 * Events from a push stream or a poll for one automation (#1401). Same checks,
 * dedup (by `eventId`), steering and run start as webhook events. A batch
 * becomes one run: `data.event` for a single event, `data.events` for several.
 * The caller holds a busy batch and tries again (see triggers/mcpEventStream.ts
 * and triggers/mcpEventPoll.ts).
 */
export async function deliverMcpEventOccurrences(
  deps: McpEventDeliveryDeps,
  executionId: string,
  delivery: 'push' | 'poll',
  events: McpEventOccurrence[],
): Promise<HeldDeliveryOutcome> {
  const execution = activeMcpEventExecution(await deps.scheduler.get(executionId), 'events', delivery);
  if (!execution) return 'gone';
  const { serverName, eventName } = execution.trigger;
  const items = events
    .filter(event => event.name === eventName)
    .map(event => ({ key: event.eventId, cursor: event.cursor ?? undefined, payload: event }));
  if (items.length === 0) return 'duplicate';
  const result = await admitMcpEvents(deps, execution, items, fresh => ({
    summary: fresh.length === 1 ? `${serverName}: ${eventName}` : `${serverName}: ${fresh.length} ${eventName} events`,
    context: fresh.length === 1
      ? { event: eventContext(fresh[0].payload) }
      : { events: fresh.map(item => eventContext(item.payload)) },
  }));
  if (result.status === 503) return 'busy';
  if (result.status === 410) return 'gone';
  return result.body.duplicate ? 'duplicate' : 'accepted';
}

