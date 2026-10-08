import type { StatisticsErrorClass } from '@/shared/types/statistics';

/**
 * UI-facing normalized chat/run error (issue #383).
 *
 * This is the single shape that the SSE `error` event, the terminal
 * `run:done` event, the persisted `SharedState.lastError` / compact
 * `ConversationSummary.lastError`, and the non-streaming chat-completions
 * error envelope all share, so the message/code shown to the user cannot
 * drift between a live run, a reload, and the OpenAI-compatible API.
 *
 * Every field except `message` is optional so older persisted conversations
 * (and any consumer built against the pre-#383 event shape) keep working
 * unchanged.
 */
export interface NormalizedChatError {
  /** Human-readable message, already including any upstream/provider detail. */
  message: string;
  /** Provider/flow error code, e.g. 'rate_limit_exceeded', 'api_error'. */
  code?: string;
  /** Provider HTTP status, e.g. 429. */
  httpStatus?: number;
  /** Provider-reported 'type', e.g. 'rate_limit_error'. */
  providerType?: string;
  /** Coarse classification reusing the existing 11-value statistics enum. */
  errorClass?: StatisticsErrorClass;
  /** Node the error occurred on/near, when known. */
  nodeId?: string;
  nodeName?: string;
  /** Retry hint, seconds as a string (already stringified upstream). */
  retryAfter?: string;
  /** Epoch ms when the error was normalized. */
  occurredAt?: number;
  /** REDACTED provider body, for the collapsed "Details" expander. Never
   *  contains auth headers or key fragments — see normalizeError.ts. */
  details?: Record<string, unknown>;
}
