/**
 * Tool calls this page already approved or rejected. A conversation refresh that
 * started before the answer reached the server still reports the call as waiting;
 * showing its prompt again left the chat stuck on "Waiting for tool approval"
 * after the run had finished (found by the scripted pilot, #577).
 */
export const ANSWERED_TOOL_CALLS_KEPT = 500;

export function rememberAnsweredToolCall(answered: Set<string>, toolCallId: string): void {
  answered.delete(toolCallId);
  answered.add(toolCallId);
  while (answered.size > ANSWERED_TOOL_CALLS_KEPT) {
    const oldest = answered.values().next().value;
    if (oldest === undefined) break;
    answered.delete(oldest);
  }
}

/**
 * The calls that still need an answer from this page. An empty list stays empty
 * (the run waits without naming a call); a list whose calls were all answered here
 * becomes `null`, because those answers are already on their way.
 */
export function unansweredToolCalls<T extends { id: string }>(
  calls: readonly T[] | null | undefined,
  answered: ReadonlySet<string>,
): T[] | null {
  if (!calls) return null;
  if (calls.length === 0) return [];
  const open = calls.filter(call => !answered.has(call.id));
  return open.length > 0 ? open : null;
}
