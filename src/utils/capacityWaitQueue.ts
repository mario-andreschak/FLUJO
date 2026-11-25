import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Arrival-ordered waiting for capacity that is momentarily full (issue #757).
 *
 * A caller that finds a limit full waits here instead of being refused at once
 * or polling with growing sleeps. Whoever frees capacity calls `wake()`, and
 * every waiter that now fits is admitted immediately, oldest first. A slow
 * timer retries too: memory pressure eases without any release announcing it,
 * and a missed wake can never strand a waiter. Each wait ends at its deadline
 * or when its caller aborts, with the last refusal it met.
 */
export interface CapacityWaitOptions {
  /** `Date.now()` value after which the caller gets the last refusal. */
  deadline: number;
  signal?: AbortSignal;
}

export interface CapacityRules {
  /** The refusal can clear by waiting (busy or memory), as opposed to a bad request. */
  waitable: (refusal: unknown) => boolean;
  /** The refusal holds for every waiter (process memory), so later waiters need not try now. */
  blocksAll?: (refusal: unknown) => boolean;
}

type Attempt = 'settled' | 'waiting' | 'blocked';
interface Waiter { attempt: () => Attempt }

const RETRY_MS = 250;

export class CapacityWaitQueue {
  private readonly waiters = new Set<Waiter>();
  private retryTimer: ReturnType<typeof setInterval> | undefined;

  get size(): number {
    return this.waiters.size;
  }

  /**
   * Take capacity now, or wait in arrival order until `tryAcquire` succeeds.
   * Every attempt runs in the caller's async context (its workspace), even
   * when another request's release wakes it.
   */
  acquire<T>(attempt: () => T, rules: CapacityRules, options: CapacityWaitOptions): Promise<T> {
    const tryAcquire = AsyncLocalStorage.bind(attempt);
    let lastRefusal: unknown;
    // Newcomers never overtake callers that are already waiting.
    if (this.waiters.size === 0) {
      try {
        return Promise.resolve(tryAcquire());
      } catch (refusal) {
        if (!rules.waitable(refusal) || Date.now() >= options.deadline || options.signal?.aborted) {
          return Promise.reject(refusal);
        }
        lastRefusal = refusal;
      }
    }
    return new Promise<T>((resolve, reject) => {
      const finish = () => {
        this.waiters.delete(waiter);
        clearTimeout(deadlineTimer);
        options.signal?.removeEventListener('abort', giveUp);
        if (this.waiters.size === 0 && this.retryTimer) {
          clearInterval(this.retryTimer);
          this.retryTimer = undefined;
        }
      };
      const giveUp = () => {
        if (!this.waiters.has(waiter)) return;
        finish();
        reject(lastRefusal ?? new Error('Capacity wait ended before any attempt.'));
      };
      const waiter: Waiter = {
        attempt: () => {
          let value: T;
          try {
            value = tryAcquire();
          } catch (refusal) {
            if (rules.waitable(refusal)) {
              lastRefusal = refusal;
              return rules.blocksAll?.(refusal) ? 'blocked' : 'waiting';
            }
            finish();
            reject(refusal);
            return 'settled';
          }
          finish();
          resolve(value);
          return 'settled';
        },
      };
      const deadlineTimer = setTimeout(giveUp, Math.max(0, options.deadline - Date.now()));
      options.signal?.addEventListener('abort', giveUp, { once: true });
      this.waiters.add(waiter);
      if (!this.retryTimer) {
        this.retryTimer = setInterval(() => this.wake(), RETRY_MS);
        this.retryTimer.unref?.();
      }
      if (lastRefusal === undefined) this.wake();
      if (options.signal?.aborted) giveUp();
    });
  }

  /** Capacity was freed: admit every waiter that fits now, oldest first. */
  wake(): void {
    for (const waiter of [...this.waiters]) {
      if (this.waiters.has(waiter) && waiter.attempt() === 'blocked') return;
    }
  }
}
