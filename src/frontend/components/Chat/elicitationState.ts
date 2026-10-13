/** A late cancellation must not remove a newer prompt or another conversation. */
export function cancelPendingElicitation<T extends { elicitationId: string }>(pending: T | null, cancelledId: string): T | null {
  return pending?.elicitationId === cancelledId ? null : pending;
}

export function clearPendingQuestion<T extends { questionId: string }>(pending: T | null, resolvedId: string): T | null {
  return pending?.questionId === resolvedId ? null : pending;
}

/** A GET started before a live prompt/resolution cannot overwrite that event. */
export function shouldHydratePendingInputs(
  viewedConversationId: string | null,
  fetchedConversationId: string,
  snapshotNextSeq: number,
  lastInputEventSeq: number,
): boolean {
  return viewedConversationId === fetchedConversationId && Number.isSafeInteger(snapshotNextSeq)
    && snapshotNextSeq >= 0 && snapshotNextSeq > lastInputEventSeq;
}
