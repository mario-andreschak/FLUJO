// How provider and SDK errors become one readable error result for every completion attempt.
import { isConversationDurabilityError } from '@/backend/execution/flow/conversationPublicationError';
import { ModelTurnArchiveMemoryError } from '../modelTurnArchiveWriteBudget';
import {
  ModelCallResult,
} from '../types/modelHandler';
import { Result } from '../errors';
import { createModelError } from '../errorFactory';
import OpenAI from 'openai';
import {
  CodexInputLimitError,
} from '@/backend/services/model/adapters/codexInputCompaction';
import {
  rethrowFlowExecutionAuthorityError,
} from '@/backend/execution/flow/executionAuthority';
import {
  classifyStatisticsError,
} from '@/backend/services/statistics';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/flow/execution/handlers/providerErrorShape');

/**
 * Normalize a provider error body into a detailed, human-readable message
 * plus structured detail fields.
 *
 * The same provider error shape reaches us two ways: when the provider
 * returns HTTP 200 with an `error` object in the body, and when the SDK
 * throws an `OpenAI.APIError` (whose `.error` is that same body). Both paths
 * call this so the extraction stays consistent. OpenRouter in particular
 * nests the real upstream reason under `metadata` — `raw` is usually a plain
 * human-readable string (occasionally a JSON string), and `provider_name` /
 * `retry_after_seconds` are the actionable bits. Requesty tags every error
 * body with `origin` ("router" = its own validation, "provider" = a relayed
 * upstream error) — surfaced in the message because it decides whether the
 * request was actually malformed or the upstream backend just rejected it.
 *
 * @param body       The provider error object (chatCompletion.error or APIError.error).
 * @param baseMessage Optional prefix (e.g. the SDK's "429 ..." message) to build on.
 */
export function extractProviderErrorDetails(
  body: unknown,
  baseMessage?: string
): {
  message: string;
  code?: unknown;
  type?: unknown;
  param?: unknown;
  retryAfter?: string;
  providerError?: unknown;
} {
  const errorBody = body && typeof body === 'object'
    ? body as Record<string, unknown>
    : {};
  let message =
    baseMessage
    || (typeof errorBody.message === 'string' ? errorBody.message : undefined)
    || 'Provider returned an unspecified error in the response body.';

  // When a base message is supplied (SDK path), append the body's own message
  // if it adds something beyond the prefix.
  if (
    baseMessage &&
    typeof errorBody.message === 'string' &&
    errorBody.message &&
    errorBody.message !== baseMessage
  ) {
    message = `${baseMessage} - ${errorBody.message}`;
  }

  const meta = errorBody.metadata && typeof errorBody.metadata === 'object'
    ? errorBody.metadata as Record<string, unknown>
    : undefined;
  if (meta) {
    let rawMsg: string | undefined;
    if (typeof meta.raw === 'string') {
      try {
        const parsed = JSON.parse(meta.raw);
        const parsedRecord = parsed && typeof parsed === 'object'
          ? parsed as Record<string, unknown>
          : {};
        const parsedError = parsedRecord.error && typeof parsedRecord.error === 'object'
          ? parsedRecord.error as Record<string, unknown>
          : undefined;
        rawMsg = typeof parsedError?.message === 'string'
          ? parsedError.message
          : typeof parsedRecord.message === 'string'
            ? parsedRecord.message
            : meta.raw;
      } catch {
        rawMsg = meta.raw; // not JSON — use the string as-is
      }
    } else if (meta.raw && typeof meta.raw === 'object') {
      const raw = meta.raw as Record<string, unknown>;
      const nestedError = raw.error && typeof raw.error === 'object'
        ? raw.error as Record<string, unknown>
        : undefined;
      rawMsg = typeof nestedError?.message === 'string'
        ? nestedError.message
        : typeof raw.message === 'string' ? raw.message : undefined;
    }
    const upstreamParts: string[] = [];
    if (meta.provider_name) upstreamParts.push(String(meta.provider_name));
    if (rawMsg) upstreamParts.push(rawMsg);
    if (upstreamParts.length > 0) {
      message = `${message} (upstream: ${upstreamParts.join(': ')})`;
    }
  }

  // Requesty's origin tag: "router" vs "provider" (see doc comment above).
  if (typeof errorBody.origin === 'string' && errorBody.origin) {
    message = `${message} (origin: ${errorBody.origin})`;
  }

  return {
    message,
    code: errorBody.code,
    type: errorBody.type,
    param: errorBody.param,
    retryAfter: meta?.retry_after_seconds != null ? String(meta.retry_after_seconds) : undefined,
    providerError: body,
  };
}

/**
 * Shape a thrown provider/SDK error into a standardized error Result. Shared
 * by every attempt of a completion call and the setup path, so cancellation,
 * OpenAI.APIError bodies, and unknown errors are all reported identically no
 * matter which attempt threw. `aborted` = the shared AbortController fired
 * (user Stop), reported as a clean cancellation rather than a provider failure.
 */
export function shapeCompletionError(
  error: unknown,
  modelId: string,
  aborted: boolean
): Result<ModelCallResult> {
  // A user cancellation aborted the in-flight call: whatever error shape the
  // SDK threw (OpenAI APIUserAbortError, DOMException AbortError, the Agent
  // SDK's teardown error, ...), report it as a clean cancellation — not a
  // provider failure.
  if (aborted) {
    log.info('Provider call aborted by user cancellation.', { modelId });
    return {
      success: false,
      error: createModelError('cancelled', 'Execution cancelled by user.', modelId),
    };
  }

  rethrowFlowExecutionAuthorityError(error);
  if (isConversationDurabilityError(error)) {
    return { success: false, error: createModelError(error.code, error.message, modelId,
      undefined, { status: error.status }) };
  }
  if (error instanceof ModelTurnArchiveMemoryError) {
    return { success: false, error: createModelError(error.code, error.message, modelId,
      undefined, { status: error.status, providerError: error.diagnostic }) };
  }
  if (error instanceof CodexInputLimitError) {
    return { success: false, error: createModelError(error.code, error.message, modelId,
      undefined, { inputCharacters: error.inputCharacters }) };
  }

  // Error diagnostics are deliberately metadata-only. Provider bodies,
  // messages, request URLs, headers, and stacks may contain credentials or
  // execution content and must never be passed to the logger.
  log.error('Provider completion failed', {
    modelId,
    errorClass: classifyStatisticsError(error),
    status: error instanceof OpenAI.APIError ? error.status : undefined,
    type: error instanceof OpenAI.APIError ? error.type : undefined,
    code: error instanceof OpenAI.APIError ? error.code : undefined,
  });

  // Handle API errors
  if (error instanceof OpenAI.APIError) {
    // The SDK's APIError.message is often terse (e.g. "429 Provider returned
    // error"). The real reason lives in the parsed response body
    // (error.error); extractProviderErrorDetails digs it out so the user
    // sees something actionable instead of a generic line.
    const body = 'error' in error ? error.error : undefined;
    const extracted = extractProviderErrorDetails(body, error.message);

    // Prefer the response header retry-after; fall back to the body's
    // metadata.retry_after_seconds (already surfaced by the helper).
    const headers = (error.headers || {}) as Record<string, unknown>;
    const headerRetryAfter = headers['retry-after'] ?? headers['Retry-After'];
    const retryAfter =
      headerRetryAfter !== undefined ? String(headerRetryAfter) : extracted.retryAfter;
    const rateLimitReset =
      headers['x-ratelimit-reset'] ?? headers['x-ratelimit-reset-requests'];

    const errorResult: Result<ModelCallResult> = {
      success: false,
      error: createModelError(
        'api_error',
        extracted.message,
        modelId,
        undefined,
        {
          status: error.status,
          // Prefer the body's values; fall back to the SDK's.
          type: extracted.type ?? error.type,
          code: extracted.code ?? error.code,
          param: extracted.param ?? error.param,
          retryAfter,
          rateLimitReset: rateLimitReset !== undefined ? String(rateLimitReset) : undefined,
          // The full parsed provider body is the richest source of truth.
          providerError: extracted.providerError,
          // Include stack trace if available
          stack: error.stack
        }
      )
    };

    log.warn('Provider request failed', {
      modelId,
      status: error.status,
      code: extracted.code ?? error.code,
      type: extracted.type ?? error.type,
    });
    return errorResult;
  }

  // Handle other errors
  const errorResult: Result<ModelCallResult> = {
    success: false,
    error: createModelError(
      'unknown_error',
      error instanceof Error ? error.message : String(error),
      modelId,
      undefined,
      {
        // Include stack trace if available
        stack: error instanceof Error ? error.stack : undefined
      }
    )
  };

  log.warn('Provider request failed with an unclassified error', {
    modelId,
    errorClass: error instanceof Error ? error.name : typeof error,
  });
  return errorResult;
}
