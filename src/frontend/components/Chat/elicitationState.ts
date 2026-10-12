/** A late cancellation must not remove a newer prompt or another conversation. */
export function cancelPendingElicitation<T extends { elicitationId: string }>(pending: T | null, cancelledId: string): T | null {
  return pending?.elicitationId === cancelledId ? null : pending;
}
