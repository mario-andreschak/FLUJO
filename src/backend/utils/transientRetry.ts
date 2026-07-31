import { createLogger } from '@/utils/logger';

const log = createLogger('backend/utils/transientRetry');

const TRANSIENT_KEYWORDS = [
  'econnreset',
  'invalid response body',
  'socket hang up',
  'premature close',
  'etimedout',
] as const;

/**
 * Returns true when the given error looks like a transient transport-layer
 * failure that is worth retrying (ECONNRESET, stream truncation, keep-alive
 * drops, …).  AbortErrors are explicitly excluded: those originate from a
 * deliberate user cancel and must never be retried.
 */
export function isTransientTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // Never retry a user-initiated abort.
  if (error.name === 'AbortError') return false;
  const msg = error.message.toLowerCase();
  return TRANSIENT_KEYWORDS.some((kw) => msg.includes(kw));
}

export interface TransientRetryOptions {
  /** Total attempts (initial + retries). Default 3. */
  maxAttempts?: number;
  /** Base delay in ms; doubles each retry. Default 500. */
  baseDelayMs?: number;
  /** When provided, an already-aborted signal skips all retries. */
  signal?: AbortSignal;
  /** Best-effort metadata callback for each actual invocation of `fn`. */
  onAttempt?: (observation: {
    attempt: number;
    durationMs: number;
    outcome: 'completed' | 'error' | 'cancelled';
    result?: unknown;
    error?: unknown;
  }) => void;
}

/**
 * Wraps an async function `fn` in a retry loop that re-issues the call when
 * {@link isTransientTransportError} identifies a transient transport failure.
 *
 * - Maximum `maxAttempts` total attempts (default 3: initial + 2 retries).
 * - Exponential back-off: `baseDelayMs * 2^(attempt-1)` (500 ms → 1 s).
 * - The caller's `AbortSignal` is respected both at the start of each attempt
 *   and during the back-off delay (pressing "Stop" cancels immediately).
 * - Non-transient errors (4xx/5xx, AuthenticationError, …) are re-thrown
 *   immediately without any retry.
 */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  opts: TransientRetryOptions = {}
): Promise<T> {
  const { maxAttempts = 3, baseDelayMs = 500, signal, onAttempt } = opts;
  const observe = (observation: Parameters<NonNullable<TransientRetryOptions['onAttempt']>>[0]) => {
    try {
      onAttempt?.(observation);
    } catch {
      // Instrumentation must never alter provider behavior.
    }
  };
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw lastError ?? new DOMException('Aborted', 'AbortError');
    }
    const startedAt = Date.now();
    try {
      const result = await fn();
      observe({ attempt, durationMs: Math.max(0, Date.now() - startedAt), outcome: 'completed', result });
      return result;
    } catch (err) {
      observe({
        attempt,
        durationMs: Math.max(0, Date.now() - startedAt),
        outcome: signal?.aborted || (err instanceof Error && err.name === 'AbortError') ? 'cancelled' : 'error',
        error: err,
      });
      if (!isTransientTransportError(err) || attempt >= maxAttempts) {
        throw err;
      }
      lastError = err;
      const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      log.warn(
        `Transient transport error on attempt ${attempt}/${maxAttempts}; retrying in ${delayMs} ms`,
        { message: err instanceof Error ? err.message : String(err) }
      );
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(lastError);
          },
          { once: true }
        );
      });
    }
  }
  throw lastError;
}
