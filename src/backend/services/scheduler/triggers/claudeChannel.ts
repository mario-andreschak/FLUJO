import { totalmem } from 'os';
import type { McpInboundEvent } from '@/backend/services/mcp/inboundEvents';
import { armMcpEvent } from './mcpEvent';
import type { ArmedTrigger } from './types';

/**
 * "A tool server reports an event" with Claude channel messages as the source
 * (#1401). The server pushes on the open MCP connection, so FLUJO keeps the
 * server running and connected, and holds messages briefly while it cannot
 * start work yet.
 *
 * Channels have no acknowledgement or replay, so this is best effort: a short,
 * bounded wait instead of refusing at once, then a visible note. Bursts become
 * one run. A batch that was tried once is retried exactly as it was, so a
 * steered message keeps its id and is never added twice.
 */
export type ChannelDeliveryOutcome = 'accepted' | 'duplicate' | 'busy' | 'gone';

export interface ClaudeChannelDeps {
  /** Starts the server if needed; false when it does not send channel messages. */
  connect: () => Promise<boolean>;
  pin: () => void | Promise<void>;
  unpin: () => void | Promise<void>;
  /** Listen for this server's messages; returns the way to stop listening. */
  listen: (listener: (event: McpInboundEvent) => void) => () => void;
  deliver: (batch: McpInboundEvent[]) => Promise<ChannelDeliveryOutcome>;
  onError: (message: string) => void;
  onSuccess: () => void;
  now?: () => number;
  /** Wait for more of a burst before starting work. */
  batchDelayMs?: number;
  maxBatch?: number;
  /** Messages held while busy; when full the oldest are dropped. */
  maxPending?: number;
  /** Bytes held while busy; scales with the machine's memory. */
  maxPendingBytes?: number;
  /** How long a message may wait for a busy automation. */
  maxWaitMs?: number;
  retryDelaysMs?: number[];
  refreshMs?: number;
}

const BATCH_DELAY_MS = 250;
const MAX_BATCH = 50;
const MAX_PENDING = 500;
/** 1/512 of the machine's memory (64 MB on 32 GB), at least 8 MB. */
const MAX_PENDING_BYTES = Math.max(8 * 1024 * 1024, Math.floor(totalmem() / 512));
const MAX_WAIT_MS = 30 * 60_000;
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

export function armClaudeChannel(deps: ClaudeChannelDeps): ArmedTrigger {
  const now = deps.now ?? Date.now;
  const batchDelay = deps.batchDelayMs ?? BATCH_DELAY_MS;
  const maxBatch = deps.maxBatch ?? MAX_BATCH;
  const maxPending = deps.maxPending ?? MAX_PENDING;
  const maxPendingBytes = deps.maxPendingBytes ?? MAX_PENDING_BYTES;
  const maxWait = deps.maxWaitMs ?? MAX_WAIT_MS;
  const retryDelays = deps.retryDelaysMs ?? RETRY_DELAYS_MS;
  const pending: McpInboundEvent[] = [];
  let pendingBytes = 0;
  const size = (event: McpInboundEvent) => event.content.length * 2 + JSON.stringify(event.meta).length * 2;
  let inFlight: McpInboundEvent[] | null = null;
  let busyAttempts = 0;
  let draining = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (delayMs: number) => {
    if (disposed || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void drain();
    }, delayMs);
    timer.unref?.();
  };

  const drain = async () => {
    if (disposed || draining) return;
    draining = true;
    try {
      while (!disposed) {
        if (!inFlight) {
          if (pending.length === 0) return;
          inFlight = pending.splice(0, maxBatch);
          for (const event of inFlight) pendingBytes -= size(event);
        }
        let outcome: ChannelDeliveryOutcome;
        try {
          outcome = await deps.deliver(inFlight);
        } catch {
          outcome = 'busy';
        }
        if (disposed) return;
        if (outcome === 'busy') {
          const waited = now() - Date.parse(inFlight[0].receivedAt);
          if (waited > maxWait) {
            deps.onError(`${inFlight.length} channel message(s) could not be started within ${Math.round(maxWait / 60_000)} minutes and were dropped. Channel messages have no delivery guarantee.`);
            inFlight = null;
            busyAttempts = 0;
            continue;
          }
          schedule(retryDelays[Math.min(busyAttempts, retryDelays.length - 1)]);
          busyAttempts++;
          return;
        }
        inFlight = null;
        busyAttempts = 0;
      }
    } finally {
      draining = false;
    }
  };

  const stopListening = deps.listen((event) => {
    if (disposed) return;
    let dropped = 0;
    while (pending.length > 0 && (pending.length >= maxPending || pendingBytes + size(event) > maxPendingBytes)) {
      pendingBytes -= size(pending.shift()!);
      dropped++;
    }
    if (dropped > 0) {
      deps.onError(`${dropped} channel message(s) were dropped because the automation could not keep up. Channel messages have no delivery guarantee.`);
    }
    pending.push(event);
    pendingBytes += size(event);
    if (!inFlight) schedule(batchDelay);
  });

  // Same keep-alive loop as webhook events: pin, connect, re-check every few minutes.
  const connection = armMcpEvent({
    subscribe: async () => {
      if (!await deps.connect()) throw new Error('This server does not send Claude channel messages');
      return { refreshBefore: null };
    },
    pin: deps.pin,
    unpin: deps.unpin,
    onError: deps.onError,
    onSuccess: deps.onSuccess,
    now: deps.now,
    refreshMs: deps.refreshMs,
  });

  return {
    // Messages still held are dropped: channels promise no delivery.
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      stopListening();
      connection.dispose();
    },
  };
}
