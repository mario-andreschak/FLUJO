/**
 * Shared request-timeout configuration for LLM calls.
 *
 * A single FLUJO flow run is one long-lived, blocking request from the browser
 * to /v1/chat/completions: the server drives the whole agentic loop (model
 * calls + tool calls + tool results, possibly dozens of turns, possibly hitting
 * slow external systems like SAP or a ticketing API) and only responds when the
 * run finishes. Provider SDKs default to a ~10-minute per-request timeout, which
 * aborts legitimately long runs and discards everything that happened — every
 * assistant message, tool call, and tool result. We therefore use a deliberately
 * generous ceiling so a long-but-healthy run is never killed mid-flight.
 *
 * This is a safety ceiling, not an expected duration. It is intentionally large;
 * a genuinely hung request is better surfaced by the live "no activity" hint and
 * the user cancelling than by a short hard timeout that loses work.
 */
export const LLM_REQUEST_TIMEOUT_MS = 5 * 60 * 60 * 1000; // 5 hours
