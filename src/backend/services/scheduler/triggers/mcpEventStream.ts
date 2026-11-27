import type { McpEventOccurrence } from '@/backend/services/mcp/serverEvents';
import type {
  McpEventStream,
  McpEventStreamHandlers,
} from '@/backend/services/mcp/serverEventStream';
import { createHeldEventQueue, type HeldDeliveryOutcome } from './heldEventQueue';
import type { ArmedTrigger } from './types';

/**
 * "A tool server reports an event" with push delivery (#1401, MCP events
 * extension `events/stream`). FLUJO keeps one stream open per automation and
 * pins the server so it is not closed for being idle.
 *
 * - The cursor is saved when events are accepted, and from heartbeats and the
 *   confirmation while nothing waits, so a reconnect or a restart resumes
 *   where FLUJO stopped.
 * - Events wait in a bounded queue while the automation is busy. When the
 *   event type can replay (its cursor is not null) and the queue is full,
 *   FLUJO closes the stream, forgets the waiting events and reconnects from
 *   the saved cursor once the queue is empty: nothing is lost and memory stays
 *   bounded. Without replay the oldest waiting events are dropped with a note.
 * - No message for three heartbeats means the stream is dead: reconnect.
 *   Every reconnect waits a random moment first, as the spec asks.
 */
export interface McpEventStreamDeps {
  open: (cursor: string | null, handlers: McpEventStreamHandlers) => Promise<McpEventStream>;
  loadCursor: () => Promise<string | null>;
  saveCursor: (cursor: string) => Promise<void>;
  deliver: (batch: McpEventOccurrence[]) => Promise<HeldDeliveryOutcome>;
  pin: () => void | Promise<void>;
  unpin: () => void | Promise<void>;
  /** A note on the automation card; cleared by `onSuccess`. */
  onError: (message: string) => void;
  onSuccess: () => void;
  now?: () => number;
  random?: () => number;
  retryDelaysMs?: number[];
  /** Asked of the server; it decides. */
  heartbeatMs?: number;
  batchDelayMs?: number;
  maxBatch?: number;
  maxPending?: number;
  maxPendingBytes?: number;
  maxWaitMs?: number;
}

const RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 60_000, 300_000];
const HEARTBEAT_MS = 30_000;
const DEAD_AFTER_HEARTBEATS = 3;
const RECONNECT_JITTER_MS = 1_000;

type Received = McpEventOccurrence & { receivedAt: number };

export function armMcpEventStream(deps: McpEventStreamDeps): ArmedTrigger {
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const retryDelays = deps.retryDelaysMs ?? RETRY_DELAYS_MS;
  let disposed = false;
  let stream: McpEventStream | undefined;
  let connecting = false;
  let replayable = false;
  let knowsReplay = false;
  let reconnectWhenIdle = false;
  let failures = 0;
  let heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
  let lastMessageAt = now();
  let savedCursor: string | null | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let livenessTimer: ReturnType<typeof setTimeout> | undefined;

  const report = (error: unknown) => deps.onError(error instanceof Error ? error.message : String(error));

  const saveQuietCursor = (cursor: string | null) => {
    if (!cursor || cursor === savedCursor || !queue.idle()) return;
    savedCursor = cursor;
    void deps.saveCursor(cursor).catch(report);
  };

  const queue = createHeldEventQueue<Received>({
    deliver: async (batch) => {
      const outcome = await deps.deliver(batch);
      const cursor = batch.map(event => event.cursor).filter((value): value is string => Boolean(value)).at(-1);
      if (cursor && (outcome === 'accepted' || outcome === 'duplicate')) savedCursor = cursor;
      return outcome;
    },
    receivedAt: event => event.receivedAt,
    size: event => JSON.stringify(event).length * 2,
    onDropped: (count, reason) => deps.onError(reason === 'late'
      ? `${count} event(s) could not be started in time and were dropped. This event type cannot be replayed.`
      : `${count} event(s) were dropped because the automation could not keep up. This event type cannot be replayed.`),
    onIdle: () => {
      if (reconnectWhenIdle && !disposed) {
        reconnectWhenIdle = false;
        scheduleReconnect(0);
      }
    },
    replayable: () => replayable,
    now: deps.now,
    batchDelayMs: deps.batchDelayMs,
    maxBatch: deps.maxBatch,
    maxPending: deps.maxPending,
    maxPendingBytes: deps.maxPendingBytes,
    maxWaitMs: deps.maxWaitMs,
  });

  const stopLiveness = () => {
    if (livenessTimer) clearTimeout(livenessTimer);
    livenessTimer = undefined;
  };

  const watchLiveness = () => {
    stopLiveness();
    if (disposed) return;
    livenessTimer = setTimeout(() => {
      livenessTimer = undefined;
      if (disposed || !stream) return;
      if (now() - lastMessageAt >= heartbeatMs * DEAD_AFTER_HEARTBEATS) {
        deps.onError('The event stream went quiet. Reconnecting.');
        stream.close();
        return;
      }
      watchLiveness();
    }, heartbeatMs);
    livenessTimer.unref?.();
  };

  const scheduleReconnect = (baseMs: number) => {
    if (disposed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, baseMs + Math.floor(random() * RECONNECT_JITTER_MS));
    reconnectTimer.unref?.();
  };

  const backoff = () => retryDelays[Math.min(failures++, retryDelays.length - 1)];

  const handlers: McpEventStreamHandlers = {
    onActive({ cursor, truncated, heartbeatMs: granted }) {
      if (disposed) return;
      lastMessageAt = now();
      knowsReplay = true;
      replayable = cursor !== null;
      if (granted) heartbeatMs = granted;
      failures = 0;
      deps.onSuccess();
      if (truncated && replayable) deps.onError('The server skipped some events. Runs for them did not happen.');
      saveQuietCursor(cursor);
      watchLiveness();
    },
    onEvent(event) {
      if (disposed) return;
      lastMessageAt = now();
      if (queue.push({ ...event, receivedAt: now() })) return;
      // Full, and the server can send these again from the saved cursor.
      reconnectWhenIdle = true;
      queue.clearPending();
      stream?.close();
    },
    onHeartbeat(cursor) {
      if (disposed) return;
      lastMessageAt = now();
      saveQuietCursor(cursor);
    },
    onError() {
      if (disposed) return;
      lastMessageAt = now();
    },
  };

  const connect = async () => {
    if (disposed || stream || connecting) return;
    connecting = true;
    try {
      // A type that cannot replay always starts "from now".
      const cursor = knowsReplay && !replayable ? null : await deps.loadCursor();
      savedCursor = cursor;
      const opened = await deps.open(cursor, handlers);
      if (disposed) {
        opened.close();
        return;
      }
      stream = opened;
      void opened.ended.then((end) => {
        if (stream === opened) stream = undefined;
        stopLiveness();
        if (disposed) return;
        switch (end.kind) {
          case 'closed':
            if (!reconnectWhenIdle) scheduleReconnect(0);
            return;
          case 'ended':
            scheduleReconnect(0);
            return;
          case 'terminated':
            deps.onError(`The server ended the subscription (${end.error.message}). FLUJO subscribes again.`);
            scheduleReconnect(backoff());
            return;
          case 'failed':
            deps.onError(`The event stream was interrupted (${end.message}). Reconnecting.`);
            scheduleReconnect(backoff());
            return;
        }
      });
    } catch (error) {
      if (disposed) return;
      report(error);
      scheduleReconnect(backoff());
    } finally {
      connecting = false;
    }
  };

  void Promise.resolve(deps.pin()).catch(() => undefined).then(connect);

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      stopLiveness();
      queue.dispose();
      stream?.close();
      void Promise.resolve(deps.unpin()).catch(() => undefined);
    },
  };
}
