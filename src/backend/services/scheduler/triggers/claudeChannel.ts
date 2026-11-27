import type { McpInboundEvent } from '@/backend/services/mcp/inboundEvents';
import { createHeldEventQueue, type HeldDeliveryOutcome } from './heldEventQueue';
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
export type ChannelDeliveryOutcome = HeldDeliveryOutcome;

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

const MAX_WAIT_MS = 30 * 60_000;

export function armClaudeChannel(deps: ClaudeChannelDeps): ArmedTrigger {
  const maxWait = deps.maxWaitMs ?? MAX_WAIT_MS;
  const queue = createHeldEventQueue<McpInboundEvent>({
    deliver: deps.deliver,
    receivedAt: event => Date.parse(event.receivedAt),
    size: event => event.content.length * 2 + JSON.stringify(event.meta).length * 2,
    onDropped: (count, reason) => deps.onError(reason === 'late'
      ? `${count} channel message(s) could not be started within ${Math.round(maxWait / 60_000)} minutes and were dropped. Channel messages have no delivery guarantee.`
      : `${count} channel message(s) were dropped because the automation could not keep up. Channel messages have no delivery guarantee.`),
    now: deps.now,
    batchDelayMs: deps.batchDelayMs,
    maxBatch: deps.maxBatch,
    maxPending: deps.maxPending,
    maxPendingBytes: deps.maxPendingBytes,
    maxWaitMs: maxWait,
    retryDelaysMs: deps.retryDelaysMs,
  });
  let disposed = false;
  const stopListening = deps.listen((event) => {
    if (!disposed) queue.push(event);
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
      queue.dispose();
      stopListening();
      connection.dispose();
    },
  };
}
