import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type {
  McpEventTriggerConfig,
  PlannedExecution,
  PlannedExecutionState,
  RunRecord,
  TriggerFirePayload,
} from '@/shared/types/plannedExecution';
import { mcpEventSource } from '@/shared/types/plannedExecution';
import { mcpEventFingerprint, verifyMcpEventSignature } from './triggers/mcpEvent';
import { composeTriggerPrompt } from './triggerPrompt';
import type { EventSteeringOutcome, EventSteeringRequest } from './eventSteering';
import type { McpInboundEvent } from '@/backend/services/mcp/inboundEvents';
import type { ChannelDeliveryOutcome } from './triggers/claudeChannel';

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
  payload: T;
}

const busy = (error: string, retryAfterSeconds: number): McpEventDeliveryResult =>
  ({ status: 503, body: { error }, retryAfterSeconds });

export const GONE: McpEventDeliveryResult = { status: 410, body: { error: 'This subscription is no longer in use' } };

/** The execution, if it still takes events of this kind. */
export function activeMcpEventExecution(
  execution: PlannedExecution | null | undefined,
  source: 'events' | 'claude-channel',
): McpEventExecution | null {
  if (
    !execution
    || execution.trigger.type !== 'mcp-event'
    || !execution.enabled
    || execution.personaRetired
    || execution.personaArchived
    || mcpEventSource(execution.trigger) !== source
  ) return null;
  return execution as McpEventExecution;
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
  const execution = activeMcpEventExecution(await deps.scheduler.get(input.id), 'events');
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

  let event: { eventId?: unknown; name?: unknown; timestamp?: unknown; data?: unknown };
  try {
    event = JSON.parse(input.body);
  } catch {
    return { status: 400, body: { error: 'Body is not valid JSON' } };
  }
  if (event.name !== trigger.eventName) return { status: 400, body: { error: 'Unexpected event name' } };

  return admitMcpEvents(deps, execution, [{ key: webhookId, payload: event }], ([item]) => ({
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
  if (fresh.length === 0) return { status: 200, body: { accepted: true, duplicate: true } };

  if (await scheduler.isPaused()) return busy('Planned executions are paused', PAUSED_RETRY_SECONDS);
  if (scheduler.exclusiveGateFor(execution)) return busy('Another automation holds the scheduler', BUSY_RETRY_SECONDS);

  const keys = fresh.map(item => item.key);
  const digest = createHash('sha256')
    .update(`${execution.id}\0${execution.generationId ?? execution.createdAt}\0${keys.join('\0')}`)
    .digest('hex');
  const { summary, context } = describe(fresh);
  const remember = () => deps.updateState(execution.id, current => ({
    ...current,
    seenIds: [...(current.seenIds ?? []), ...keys].slice(-MAX_SEEN_IDS),
  }));

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
