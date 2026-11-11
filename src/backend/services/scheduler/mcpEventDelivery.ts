import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type {
  PlannedExecution,
  PlannedExecutionState,
  RunRecord,
  TriggerFirePayload,
} from '@/shared/types/plannedExecution';
import { mcpEventFingerprint, verifyMcpEventSignature } from './triggers/mcpEvent';

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

const busy = (error: string, retryAfterSeconds: number): McpEventDeliveryResult =>
  ({ status: 503, body: { error }, retryAfterSeconds });

/**
 * Accepts one signed event. The sender keeps a durable log and retries, so this
 * says 503 instead of queueing in memory: anything FLUJO could not start stays
 * safely with the sender. 410 tells the sender to stop for good.
 */
export async function receiveMcpEvent(
  deps: McpEventDeliveryDeps,
  input: McpEventDeliveryInput,
): Promise<McpEventDeliveryResult> {
  const { scheduler } = deps;
  const execution = await scheduler.get(input.id);
  if (
    !execution
    || execution.trigger.type !== 'mcp-event'
    || !execution.enabled
    || execution.personaRetired
    || execution.personaArchived
    || input.fingerprint !== mcpEventFingerprint(execution.trigger)
  ) {
    return { status: 410, body: { error: 'This subscription is no longer in use' } };
  }
  const trigger = execution.trigger;

  if (Buffer.byteLength(input.body) > MAX_BODY_BYTES) return { status: 413, body: { error: 'Payload too large' } };
  const signed = verifyMcpEventSignature(
    trigger.secret,
    { id: input.webhookId, timestamp: input.webhookTimestamp, signature: input.webhookSignature },
    input.body,
    deps.now?.(),
  );
  if (!signed) return { status: 401, body: { error: 'Invalid signature' } };
  const eventId = input.webhookId!;

  let event: { eventId?: unknown; name?: unknown; timestamp?: unknown; data?: unknown };
  try {
    event = JSON.parse(input.body);
  } catch {
    return { status: 400, body: { error: 'Body is not valid JSON' } };
  }
  if (event.name !== trigger.eventName) return { status: 400, body: { error: 'Unexpected event name' } };

  const state = await deps.loadState(execution.id);
  if (state.seenIds?.includes(eventId)) return { status: 200, body: { accepted: true, duplicate: true } };

  if (await scheduler.isPaused()) return busy('Planned executions are paused', PAUSED_RETRY_SECONDS);
  if (scheduler.exclusiveGateFor(execution)) return busy('Another automation holds the scheduler', BUSY_RETRY_SECONDS);

  const digest = createHash('sha256')
    .update(`${execution.id}\0${execution.generationId ?? execution.createdAt}\0${eventId}`)
    .digest('hex');
  const payload: TriggerFirePayload = {
    kind: 'mcp-event',
    summary: `${trigger.serverName}: ${trigger.eventName}`,
    context: { event: { eventId, name: event.name, timestamp: event.timestamp, data: event.data } },
    ...(execution.personaId ? { deliveryId: `mcp-event-${digest}` } : {}),
  };
  const remember = () => deps.updateState(execution.id, current => ({
    ...current,
    seenIds: [...(current.seenIds ?? []), eventId].slice(-MAX_SEEN_IDS),
  }));

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
