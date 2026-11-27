import { totalmem } from 'os';

/**
 * Events that arrive on an open connection (Claude channel messages, MCP
 * events push streams) have no sender that retries, so FLUJO holds them while
 * the automation cannot start work yet (#1401).
 *
 * - A burst becomes one batch: items that arrive within `batchDelayMs` are
 *   handed over together, at most `maxBatch` at a time.
 * - A busy batch is retried exactly as it was, with growing waits, so a
 *   steered message keeps its id and is never added twice.
 * - Memory is bounded by count and by bytes (scaled with the machine). When
 *   full, the oldest waiting item is dropped, or, for a source that can replay
 *   from its cursor, `push` refuses and the source re-reads later instead.
 * - Without replay, an item may wait `maxWaitMs`; with replay it waits as long
 *   as it takes, because nothing more than the batch is held.
 */
export type HeldDeliveryOutcome = 'accepted' | 'duplicate' | 'busy' | 'gone';

export interface HeldEventQueueOptions<T> {
  deliver: (batch: T[]) => Promise<HeldDeliveryOutcome>;
  receivedAt: (item: T) => number;
  size: (item: T) => number;
  /** Items dropped because the queue was full or they waited too long. */
  onDropped: (count: number, reason: 'full' | 'late') => void;
  /** Nothing is waiting or being delivered any more. */
  onIdle?: () => void;
  /** True when the source can send the same items again from its cursor. */
  replayable?: () => boolean;
  now?: () => number;
  batchDelayMs?: number;
  maxBatch?: number;
  maxPending?: number;
  maxPendingBytes?: number;
  maxWaitMs?: number;
  retryDelaysMs?: number[];
}

export interface HeldEventQueue<T> {
  /** False when the queue is full and the source can replay; nothing was added. */
  push(item: T): boolean;
  /** Forgets what waits; the batch being delivered stays. */
  clearPending(): void;
  /** Nothing waiting and nothing being delivered. */
  idle(): boolean;
  dispose(): void;
}

const BATCH_DELAY_MS = 250;
const MAX_BATCH = 50;
const MAX_PENDING = 500;
/** 1/512 of the machine's memory (64 MB on 32 GB), at least 8 MB. */
const MAX_PENDING_BYTES = Math.max(8 * 1024 * 1024, Math.floor(totalmem() / 512));
const MAX_WAIT_MS = 30 * 60_000;
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

export function createHeldEventQueue<T>(options: HeldEventQueueOptions<T>): HeldEventQueue<T> {
  const now = options.now ?? Date.now;
  const batchDelay = options.batchDelayMs ?? BATCH_DELAY_MS;
  const maxBatch = options.maxBatch ?? MAX_BATCH;
  const maxPending = options.maxPending ?? MAX_PENDING;
  const maxPendingBytes = options.maxPendingBytes ?? MAX_PENDING_BYTES;
  const maxWait = options.maxWaitMs ?? MAX_WAIT_MS;
  const retryDelays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  const replayable = options.replayable ?? (() => false);
  const pending: T[] = [];
  let pendingBytes = 0;
  let inFlight: T[] | null = null;
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

  const idle = () => !inFlight && pending.length === 0 && !draining;

  const drain = async () => {
    if (disposed || draining) return;
    draining = true;
    try {
      while (!disposed) {
        if (!inFlight) {
          if (pending.length === 0) break;
          inFlight = pending.splice(0, maxBatch);
          for (const item of inFlight) pendingBytes -= options.size(item);
        }
        let outcome: HeldDeliveryOutcome;
        try {
          outcome = await options.deliver(inFlight);
        } catch {
          outcome = 'busy';
        }
        if (disposed) return;
        if (outcome === 'busy') {
          if (!replayable() && now() - options.receivedAt(inFlight[0]) > maxWait) {
            options.onDropped(inFlight.length, 'late');
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
    if (!disposed && idle()) options.onIdle?.();
  };

  return {
    push(item) {
      if (disposed) return true;
      const itemSize = options.size(item);
      const full = () => pending.length > 0 && (pending.length >= maxPending || pendingBytes + itemSize > maxPendingBytes);
      if (full() && replayable()) return false;
      let dropped = 0;
      while (full()) {
        pendingBytes -= options.size(pending.shift()!);
        dropped++;
      }
      if (dropped > 0) options.onDropped(dropped, 'full');
      pending.push(item);
      pendingBytes += itemSize;
      if (!inFlight) schedule(batchDelay);
      return true;
    },
    clearPending() {
      pending.length = 0;
      pendingBytes = 0;
      if (!inFlight && !draining && timer) {
        clearTimeout(timer);
        timer = undefined;
        options.onIdle?.();
      }
    },
    idle,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
