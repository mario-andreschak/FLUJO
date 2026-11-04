/**
 * System-prompt freeze helpers (issue #249).
 *
 * The system prompt is FROZEN per (conversation, node) on first render so it
 * forms a byte-stable provider cache prefix (mirrors the #89 tool-block freeze).
 * A later render that differs — e.g. a `${resource:}` / `${kv:}` pill changed,
 * or a date rolled over — does not change the frozen prompt and adds nothing to
 * the conversation (issue #1333 removed the synthetic `[System update]`
 * messages). Live values belong in tools, such as FLUJO MCP's conversation
 * tools; steps that must see a fresh prompt every turn use the `per-turn`
 * policy instead. The frozen prompt is rebuilt at a compaction boundary.
 *
 * The freeze decision is a PURE function so it can be unit-tested in isolation
 * from the heavily-mocked `ProcessNode.prep()`; the caller persists the
 * returned frozen map.
 */

/** Outcome of the pure freeze decision. */
export interface FreezeDecision {
  /** The system-prompt content that must be sent on the wire this turn. */
  content: string;
  /** The frozen map AFTER this decision (new object; assign back to state). */
  frozenSystemPrompts: Record<string, string>;
  /** True when this render froze the prompt for the first time on this node. */
  frozeNow: boolean;
}

/**
 * Decide the system-prompt content for this turn given the freshly-rendered
 * prompt and the conversation's frozen-prompt map. PURE — returns the new frozen
 * map; the caller mutates state.
 *
 * - First render on this node: freeze `fresh` and use it.
 * - Later renders: reuse the frozen string byte-for-byte, whatever `fresh` is.
 */
export function resolveFrozenSystemPrompt(
  nodeId: string,
  fresh: string,
  frozenSystemPrompts: Record<string, string> | undefined
): FreezeDecision {
  const current = frozenSystemPrompts ?? {};
  const frozen = current[nodeId];

  if (frozen === undefined) {
    return {
      content: fresh,
      frozenSystemPrompts: { ...current, [nodeId]: fresh },
      frozeNow: true,
    };
  }

  return { content: frozen, frozenSystemPrompts: current, frozeNow: false };
}
