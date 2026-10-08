/**
 * System-prompt freeze / drift helpers (issue #249).
 *
 * The system prompt is FROZEN per (conversation, node) on first render so it
 * forms a byte-stable provider cache prefix (mirrors the #89 tool-block freeze).
 * When a later turn re-renders a DIFFERENT prompt — e.g. a `${resource:}` /
 * `${kv:}` pill changed, or a date rolled over — we must NOT mutate the frozen
 * prefix, because rewriting it would invalidate 100% of the provider's prefix
 * cache for that turn. Instead the drift is surfaced to the model as a synthetic
 * `[System update]` message appended at the tail, costing at most one cache miss
 * on the newest turn.
 *
 * The freeze decision is a PURE function so it can be unit-tested in isolation
 * from the heavily-mocked `ProcessNode.prep()`; the caller applies the returned
 * mutations (persist the frozen map, append the drift message).
 */

/** Marker prefix used to identify (and dedupe) synthetic drift updates. */
export const SYSTEM_UPDATE_PREFIX = '[System update]';

/**
 * Build the human-readable body of a `[System update]` message describing that
 * the live system context drifted from the frozen prefix.
 *
 * Deterministic (no dates / randomness): an identical drift always yields
 * identical text, which lets the caller dedupe repeated identical updates so a
 * live pill re-resolving to the same value across tool-loop iterations does not
 * spam the conversation tail.
 *
 * Coarse first version: surface the current (drifted) system context verbatim
 * so the model still sees the live values, while the frozen prefix stays
 * byte-stable for caching. A richer line-diff can replace the body later without
 * changing the freeze/append contract.
 */
export function buildSystemUpdateText(frozen: string, fresh: string): string {
  return `${SYSTEM_UPDATE_PREFIX} The system context changed since this conversation started. Current system context:\n\n${fresh}`;
}

/**
 * A message shape the drift dedupe check needs (role + content only). `content`
 * is `unknown` because a FlujoChatMessage's content can be a string, a
 * structured object, null, or a `ChatCompletionContentPartText[]` array; the
 * dedupe only ever compares it (`=== driftText`) against a string, so the wider
 * type is safe and lets `SharedState.messages` be passed in directly.
 */
export interface DriftMessageView {
  role: string;
  content?: unknown;
}

/** Outcome of the pure freeze decision. */
export interface FreezeDecision {
  /** The system-prompt content that must be sent on the wire this turn. */
  content: string;
  /** The frozen map AFTER this decision (new object; assign back to state). */
  frozenSystemPrompts: Record<string, string>;
  /** True when this render froze the prompt for the first time on this node. */
  frozeNow: boolean;
  /**
   * The `[System update]` text to append to the conversation tail, or undefined
   * when there is no drift (or an identical update is already present).
   */
  driftUpdate?: string;
}

/**
 * Decide the system-prompt content for this turn given the freshly-rendered
 * prompt and the conversation's frozen-prompt map. PURE — returns the new frozen
 * map and (optionally) a drift-update string; the caller mutates state.
 *
 * - First render on this node: freeze `fresh` and use it.
 * - Later renders: reuse the frozen string byte-for-byte. If `fresh` drifts from
 *   the frozen string, emit a `[System update]` unless an identical one is
 *   already present in `existingMessages` (dedupe against tool-loop re-renders).
 */
export function resolveFrozenSystemPrompt(
  nodeId: string,
  fresh: string,
  frozenSystemPrompts: Record<string, string> | undefined,
  existingMessages: ReadonlyArray<DriftMessageView>
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

  if (fresh === frozen) {
    return { content: frozen, frozenSystemPrompts: current, frozeNow: false };
  }

  const driftText = buildSystemUpdateText(frozen, fresh);
  const alreadyPresent = existingMessages.some(
    (m) => m.role === 'user' && m.content === driftText
  );

  return {
    content: frozen,
    frozenSystemPrompts: current,
    frozeNow: false,
    driftUpdate: alreadyPresent ? undefined : driftText,
  };
}
