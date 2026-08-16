/**
 * The single, explicit definition of what makes a conversation "active"
 * (issue #405).
 *
 * FLUJO has no persisted "active node" concept: it has a durable conversation
 * `status`, plus a live in-memory execution state that only exists until the
 * process restarts. Inferring activity from "is it currently in memory" would
 * therefore change after every restart, so activity is defined ONLY as an
 * allowlist of durable statuses. Live state may still *overlay* the status
 * (a persisted `running` record with no live event channel projects as
 * `error`), while the allowlist below drives each chain node's active metadata.
 *
 * Pure and dependency-free so both the API route and the UI can share it.
 */

/** Statuses that count as an active conversation node in a visible chain. */
export const ACTIVE_CONVERSATION_STATUSES = [
  'running',
  'awaiting_tool_approval',
  'paused_debug',
] as const;

export type ActiveConversationStatus = (typeof ACTIVE_CONVERSATION_STATUSES)[number];

const ACTIVE_STATUS_SET: ReadonlySet<string> = new Set(ACTIVE_CONVERSATION_STATUSES);

/**
 * True when the given (possibly undefined/legacy) status is one of the
 * allowlisted active statuses. Terminal states (`completed`, `error`,
 * `capped`) and unknown/missing statuses are never active.
 */
export function isActiveConversationStatus(
  status: string | null | undefined
): status is ActiveConversationStatus {
  return typeof status === 'string' && ACTIVE_STATUS_SET.has(status);
}
