import { classifyStatisticsError } from '@/backend/services/statistics';
import type { NormalizedChatError } from '@/shared/types/execution/errors';
import type { EmitFn } from '@/shared/types/execution/events';
import type { SharedState } from './types';

/**
 * Issue #383 ("Chat Error Code"): the single place that shapes an error for
 * the UI. Everything downstream — the SSE `error`/`run:done` events, the
 * persisted `SharedState.lastError` / compact conversation-summary
 * projection, and the non-streaming chat-completions error envelope — is
 * built from this function's output, so the message/code shown to the user
 * cannot drift between a live run, a page reload, and the OpenAI-compatible
 * API.
 *
 * REDACTION IS MANDATORY: `redactErrorDetails()` runs over the raw provider
 * body before it is ever attached to a `NormalizedChatError.details`, because
 * that body can contain authorization headers or key fragments.
 */

const REDACT_KEY_PATTERN =
  /^(authorization|api[-_]?key|x-api-key|cookie|set-cookie|proxy-authorization|www-authenticate)$/i;
const SECRET_VALUE_PATTERN = /sk-[A-Za-z0-9_-]{8,}/g;
const BEARER_VALUE_PATTERN = /bearer\s+[A-Za-z0-9._.~+/=-]{8,}/gi;
/** Keep persisted/served snapshots small; ~8 KB cap on the serialized details blob. */
const MAX_DETAILS_CHARS = 8 * 1024;
const MAX_REDACT_DEPTH = 6;

function maskSecretsInString(value: string): string {
  return value
    .replace(BEARER_VALUE_PATTERN, 'Bearer [REDACTED]')
    .replace(SECRET_VALUE_PATTERN, '[REDACTED]');
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > MAX_REDACT_DEPTH) return '[REDACTED: max depth exceeded]';
  if (typeof value === 'string') return maskSecretsInString(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACT_KEY_PATTERN.test(key) ? '[REDACTED]' : redactValue(val, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Redacts secrets from a raw provider error body (headers/keys denylist +
 * `sk-…`/bearer-token masking) and caps its serialized size so persisted
 * conversation snapshots and API responses stay small.
 */
export function redactErrorDetails(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined;
  const redacted = redactValue(raw, 0);

  let serialized: string;
  try {
    serialized = JSON.stringify(redacted) ?? '';
  } catch {
    return { note: '[REDACTED: unserializable provider error body]' };
  }
  if (!serialized) return undefined;

  if (serialized.length > MAX_DETAILS_CHARS) {
    return {
      note: '[REDACTED: provider error body truncated]',
      truncated: serialized.slice(0, MAX_DETAILS_CHARS),
    };
  }

  if (redacted && typeof redacted === 'object' && !Array.isArray(redacted)) {
    return redacted as Record<string, unknown>;
  }
  return { value: redacted };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Normalizes ANY thrown/returned error shape encountered on the chat error
 * path into the shared `NormalizedChatError` contract. Reads `err.details`
 * when present (that is where `ModelHandler.extractProviderErrorDetails()`
 * and `ProcessNode`'s thrown model errors put `status`/`code`/`type`/
 * `retryAfter`/`providerError`), falls back to `err.code` / `err.name` /
 * `String(err)`, and always fills `errorClass` via the existing
 * `classifyStatisticsError()` classifier.
 */
export function normalizeChatError(
  err: unknown,
  ctx?: { nodeId?: string; nodeName?: string }
): NormalizedChatError {
  const details =
    err && typeof err === 'object' && (err as Record<string, unknown>).details
      && typeof (err as Record<string, unknown>).details === 'object'
      ? ((err as Record<string, unknown>).details as Record<string, unknown>)
      : undefined;

  let message: string;
  if (err instanceof Error) {
    message = err.message || 'An unknown error occurred.';
  } else if (typeof err === 'string' && err.length > 0) {
    message = err;
  } else if (err && typeof err === 'object' && readString((err as Record<string, unknown>).message)) {
    message = (err as Record<string, unknown>).message as string;
  } else if (err === undefined || err === null) {
    message = 'An unknown error occurred.';
  } else {
    message = String(err);
  }

  const code =
    readString(details?.code)
    ?? (err && typeof err === 'object' ? readString((err as Record<string, unknown>).code) : undefined);

  const httpStatus =
    readNumber(details?.status)
    ?? (err && typeof err === 'object' ? readNumber((err as Record<string, unknown>).status) : undefined);

  const providerType =
    readString(details?.type)
    ?? (err instanceof Error ? readString(err.name) : undefined);

  const retryAfter = readString(details?.retryAfter);

  const redactedDetails = details?.providerError !== undefined
    ? redactErrorDetails(details.providerError)
    : undefined;

  return {
    message,
    ...(code ? { code } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(providerType ? { providerType } : {}),
    errorClass: classifyStatisticsError(err),
    ...(ctx?.nodeId ? { nodeId: ctx.nodeId } : {}),
    ...(ctx?.nodeName ? { nodeName: ctx.nodeName } : {}),
    ...(retryAfter ? { retryAfter } : {}),
    occurredAt: Date.now(),
    ...(redactedDetails ? { details: redactedDetails } : {}),
  };
}

/**
 * Rebuilds a `NormalizedChatError` from the legacy `SharedState.lastResponse`
 * shape (`{ success: false, error, errorDetails }` or a bare string) for
 * conversations persisted before issue #383 added `SharedState.lastError`.
 * Used as a read-time back-compat fallback — no migration needed.
 */
export function deriveLastErrorFromLastResponse(
  lastResponse: unknown
): NormalizedChatError | undefined {
  if (lastResponse === undefined || lastResponse === null) return undefined;

  if (typeof lastResponse === 'string') {
    return lastResponse.length > 0 ? normalizeChatError(new Error(lastResponse)) : undefined;
  }

  if (typeof lastResponse === 'object') {
    const record = lastResponse as Record<string, unknown>;
    if (record.success === false) {
      const message = readString(record.error) ?? 'An unknown error occurred.';
      const errorDetails =
        record.errorDetails && typeof record.errorDetails === 'object'
          ? (record.errorDetails as Record<string, unknown>)
          : undefined;
      const synthetic = Object.assign(new Error(message), errorDetails ? { details: errorDetails } : {});
      return normalizeChatError(synthetic);
    }
  }

  return undefined;
}

/**
 * Emits exactly one `error` event per run and records the normalized error on
 * `SharedState.lastError`, no matter how many of the (now several) terminal
 * error paths call it. The guard lives on `sharedState` itself — rather than
 * a closure — because `FlowExecutor.executeStep()` and `runFlow()`'s own loop
 * are different call frames that must share the same per-run dedupe state.
 *
 * Deliberately NOT called for user cancellation: `runFlow` already
 * special-cases `'Execution cancelled by user.'`, and a stop must keep
 * rendering as the neutral "stopped" banner, not an error.
 */
export function emitErrorOnce(
  sharedState: SharedState,
  emit: EmitFn | undefined,
  err: unknown,
  ctx?: { nodeId?: string; nodeName?: string }
): NormalizedChatError | undefined {
  if (sharedState.errorEventEmitted) {
    return sharedState.lastError;
  }
  return emitNormalizedErrorOnce(sharedState, emit, normalizeChatError(err, ctx), ctx);
}

/**
 * Same per-run dedupe guard as `emitErrorOnce()`, but for a caller that
 * already has a `NormalizedChatError` in hand (the `runFlow` status-reconcile
 * backstop derives one from `sharedState.lastResponse` via
 * `deriveLastErrorFromLastResponse()` and must not re-normalize/lose fields).
 */
export function emitNormalizedErrorOnce(
  sharedState: SharedState,
  emit: EmitFn | undefined,
  norm: NormalizedChatError,
  ctx?: { nodeId?: string; nodeName?: string }
): NormalizedChatError {
  if (sharedState.errorEventEmitted) {
    return sharedState.lastError ?? norm;
  }
  sharedState.errorEventEmitted = true;
  sharedState.lastError = norm;
  emit?.({
    type: 'error',
    node: ctx?.nodeId ? { nodeId: ctx.nodeId } : undefined,
    message: norm.message,
    error: norm,
  });
  return norm;
}
