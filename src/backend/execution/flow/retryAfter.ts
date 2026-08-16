/**
 * Bounded, abort-aware `Retry-After` handling for automatic provider retries
 * (issue #400).
 *
 * A provider that reports a session/rate limit and hands back a *valid, small*
 * `Retry-After` is telling us exactly when the same request may be replayed.
 * Instead of failing the chat turn immediately we wait and retry that single
 * provider call.
 *
 * The policy here is deliberately conservative and centralized so it can be
 * unit-tested in isolation:
 *
 * - only standards-shaped `Retry-After` values are accepted (delta-seconds or
 *   an HTTP-date); malformed, negative, non-finite, or already-expired values
 *   are rejected;
 * - the accepted delay is capped ({@link MAX_AUTOMATIC_RETRY_DELAY_MS}) so a
 *   hostile or nonsensical header cannot park a run for hours;
 * - the number of automatic attempts is capped
 *   ({@link MAX_AUTOMATIC_MODEL_RETRIES});
 * - only a session/rate-limit *signature* (or an explicit 429) with such a
 *   delay is eligible. A generic transport failure or a 429 without a usable
 *   delay keeps the existing terminal-error behaviour.
 *
 * Nothing here performs I/O, emits events, or touches persisted state: callers
 * own that. Only sanitized timing metadata leaves this module.
 */

/** Hard cap on a single automatic wait. Longer resets stay a user decision. */
export const MAX_AUTOMATIC_RETRY_DELAY_MS = 15 * 60 * 1000;

/** Hard cap on automatic retries of one logical provider call. */
export const MAX_AUTOMATIC_MODEL_RETRIES = 3;

/**
 * Provider wording that identifies a session/usage/rate limit. Kept narrow on
 * purpose: this gate decides whether a failed call may be replayed at all.
 */
const LIMIT_SIGNATURE =
  /(session|usage|rate|quota|message|token)[\s_-]{0,3}limit|limit reached|reached your limit|too many requests|rate[\s_-]?limited|quota exceeded|exceeded your [a-z ]{0,24}quota|resets? (at|in|on)\b/i;

/** Purely numeric delta-seconds, per RFC 9110 (integers; we tolerate decimals). */
const DELTA_SECONDS = /^\d+(?:\.\d+)?$/;

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Parse a `Retry-After` value into a non-negative delay in milliseconds.
 *
 * Accepts delta-seconds (number or numeric string) and HTTP-date strings,
 * measured against `now` (the server clock). Returns `undefined` for missing,
 * malformed, negative, non-finite, or already-expired values. The returned
 * value is NOT capped — see {@link resolveAutomaticRetryDelayMs} for the
 * bounded, retry-eligible form.
 */
export function parseRetryAfterMs(value: unknown, now: number = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return undefined;
    return Math.round(value * 1000);
  }

  const raw = stringField(value);
  if (!raw) return undefined;

  if (DELTA_SECONDS.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return Math.round(seconds * 1000);
  }

  // A leading sign is not a valid delta-seconds production, and a negative wait
  // is meaningless. Reject rather than silently clamping to zero.
  if (/^[+-]/.test(raw)) return undefined;

  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return undefined;
  const delta = parsed - now;
  // Already expired (or clock skew put it in the past): ineligible, per plan.
  if (delta < 0) return undefined;
  return delta;
}

/**
 * Parse and bound a `Retry-After` value for AUTOMATIC replay. Returns
 * `undefined` when the value is unusable or exceeds
 * {@link MAX_AUTOMATIC_RETRY_DELAY_MS}.
 */
export function resolveAutomaticRetryDelayMs(
  value: unknown,
  now: number = Date.now(),
  maxDelayMs: number = MAX_AUTOMATIC_RETRY_DELAY_MS,
): number | undefined {
  const delay = parseRetryAfterMs(value, now);
  if (delay === undefined) return undefined;
  if (delay > maxDelayMs) return undefined;
  return delay;
}

/** The subset of a normalized error this module reads. */
interface RetryErrorFacts {
  status?: number;
  code?: string;
  message: string;
  retryAfter?: unknown;
  retryAfterMs?: number;
}

/** Flatten the normalized model error / raw error into the fields we gate on. */
export function extractRetryErrorFacts(error: unknown): RetryErrorFacts {
  const root = (error && typeof error === 'object' ? error : {}) as Record<string, unknown>;
  const details = (root.details && typeof root.details === 'object'
    ? root.details
    : root.errorDetails && typeof root.errorDetails === 'object'
      ? root.errorDetails
      : root) as Record<string, unknown>;

  const message =
    stringField(root.message) ??
    stringField(details.message) ??
    (typeof error === 'string' ? error : '') ??
    '';

  return {
    status: numberField(details.status) ?? numberField(details.statusCode),
    code: stringField(details.code) ?? stringField(details.type) ?? stringField(root.code),
    message,
    retryAfter: details.retryAfter,
    retryAfterMs: numberField(details.retryAfterMs),
  };
}

/**
 * True when the failure carries the session/usage/rate-limit signature this
 * feature targets. Status 429 counts on its own; otherwise the provider must
 * say so in the code/type/message.
 */
export function isSessionLimitFailure(error: unknown): boolean {
  const facts = extractRetryErrorFacts(error);
  if (facts.status === 429) return true;
  return LIMIT_SIGNATURE.test(`${facts.code ?? ''} ${facts.message}`);
}

export interface AutomaticRetryPlan {
  /** Bounded wait before the replay. */
  delayMs: number;
  /** Absolute deadline (server clock) for UI countdowns. */
  retryAt: number;
  /** Sanitized, non-sensitive reason surfaced to the UI. */
  reason: 'session_limit';
  /** HTTP status of the failure, when the provider reported one. */
  status?: number;
  /** Provider code/type, when present. */
  code?: string;
}

/**
 * Decide whether a failed provider call may be replayed automatically.
 *
 * Returns the bounded plan, or `undefined` when the failure is not an eligible
 * session/rate limit, carries no usable `Retry-After`, or asks for a wait
 * beyond the configured maximum.
 */
export function planAutomaticRetry(
  error: unknown,
  options: { now?: number; maxDelayMs?: number } = {},
): AutomaticRetryPlan | undefined {
  const now = options.now ?? Date.now();
  const facts = extractRetryErrorFacts(error);
  if (!isSessionLimitFailure(error)) return undefined;

  const delayMs =
    facts.retryAfterMs !== undefined && facts.retryAfterMs >= 0
      ? (facts.retryAfterMs <= (options.maxDelayMs ?? MAX_AUTOMATIC_RETRY_DELAY_MS)
          ? facts.retryAfterMs
          : undefined)
      : resolveAutomaticRetryDelayMs(facts.retryAfter, now, options.maxDelayMs);

  if (delayMs === undefined) return undefined;

  return {
    delayMs,
    retryAt: now + delayMs,
    reason: 'session_limit',
    status: facts.status,
    code: facts.code,
  };
}

/** How often the abort-aware wait re-checks a polled cancellation flag. */
const RETRY_WAIT_POLL_MS = 250;

/**
 * Sleep until the retry deadline, or bail out early on cancellation.
 *
 * Resolves `'ready'` when the full delay elapsed and `'aborted'` when the run
 * was cancelled (either via the shared `AbortSignal` or the polled
 * `shouldAbort` flag used by the Stop button). Every timer is cleared on both
 * paths, so no stray timer can fire a second provider call.
 */
export async function waitForRetryWindow(
  delayMs: number,
  options: { signal?: AbortSignal; shouldAbort?: () => boolean; pollMs?: number } = {},
): Promise<'ready' | 'aborted'> {
  const { signal, shouldAbort } = options;
  if (signal?.aborted || shouldAbort?.()) return 'aborted';
  if (delayMs <= 0) return 'ready';

  return new Promise<'ready' | 'aborted'>((resolve) => {
    let settled = false;
    let poll: ReturnType<typeof setInterval> | undefined;

    // `timer` below is declared after this closure; settle() is only ever
    // reached from the timer/poll/abort callbacks, all created afterwards.
    const settle = (outcome: 'ready' | 'aborted') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };

    function onAbort() {
      settle('aborted');
    }

    const timer = setTimeout(() => settle('ready'), delayMs);
    timer.unref?.();

    if (shouldAbort) {
      poll = setInterval(() => {
        if (shouldAbort()) settle('aborted');
      }, options.pollMs ?? RETRY_WAIT_POLL_MS);
      poll.unref?.();
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
