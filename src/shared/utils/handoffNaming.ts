/**
 * Handoff tool naming (issue #38, Item A).
 *
 * Handoff tools used to be named `handoff_to_<targetNodeId>`, embedding the raw
 * node UUID (e.g. `handoff_to_c23dc1e2-64c0-49fb-89b7-cd4477839f5b`). Models
 * route far better against a human-readable stub — `handoff_to_finish_node` —
 * so we now slugify the target node's label (falling back to its type).
 *
 * The `handoff_to_` PREFIX is load-bearing: every other part of the engine
 * detects a handoff by that prefix (ModelHandler, runFlow, the Claude
 * subscription adapter, buildNodeContext.isHandoffToolName). Only the routing
 * step in ProcessNode.processHandoffToolCalls previously decoded the suffix
 * back to a node id — that decode is now done through SharedState.handoffNameMap
 * (tool name -> node id), populated when the tools are generated. This module
 * is pure and shared by the runtime (ProcessNode) and the FlowBuilder preview
 * (useHandoffTools) so the two can never drift on the name.
 */

/** The invariant prefix all handoff tools share; do not change (see above). */
export const HANDOFF_TOOL_PREFIX = 'handoff_to_';

// OpenAI/Anthropic tool names must match /^[A-Za-z0-9_-]+$/ and stay <= 64 chars.
// The prefix eats 11 chars, so cap the slug so the worst case (+ a collision
// suffix) still fits comfortably.
const MAX_SLUG_LENGTH = 48;

/**
 * Turn a node label (or, when it is empty, the node type) into a compact,
 * lowercase, underscore-separated slug safe to use in a tool name.
 * Examples: `Finish Node` -> `finish_node`, `Claude (opus)` -> `claude_opus`.
 */
export function slugifyHandoffTarget(label?: string, type?: string): string {
  const base = (label && label.trim()) || (type && type.trim()) || 'node';
  let slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_') // any run of non-alphanumerics -> single underscore
    .replace(/_+/g, '_') // collapse repeats
    .replace(/^_+|_+$/g, ''); // trim leading/trailing underscores
  if (slug.length > MAX_SLUG_LENGTH) {
    slug = slug.slice(0, MAX_SLUG_LENGTH).replace(/_+$/g, '');
  }
  // Everything slugged away (e.g. a label of only punctuation) -> fall back to type.
  if (!slug) slug = (type && type.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')) || 'node';
  return slug || 'node';
}

/** A minimal reference to a handoff target node. */
export interface HandoffTargetRef {
  id: string;
  label?: string;
  type?: string;
}

/**
 * Build a stable, collision-free map from target node id -> handoff tool name.
 *
 * Two targets that slugify to the same stub (realistic now that a Process node
 * auto-tracks its model name — two `Claude (opus)` nodes -> `claude_opus`) get
 * a numeric suffix (`handoff_to_claude_opus`, `handoff_to_claude_opus_2`, ...),
 * assigned in input order so the result is deterministic. Duplicate ids collapse
 * to a single entry (the Map keys by id), so callers may pass repeated ids.
 */
export function buildHandoffToolNameMap(targets: HandoffTargetRef[]): Map<string, string> {
  const used = new Set<string>();
  const byId = new Map<string, string>();

  for (const target of targets) {
    if (byId.has(target.id)) continue; // already assigned; keep the first
    const slug = slugifyHandoffTarget(target.label, target.type);
    let name = `${HANDOFF_TOOL_PREFIX}${slug}`;
    if (used.has(name)) {
      let i = 2;
      while (used.has(`${HANDOFF_TOOL_PREFIX}${slug}_${i}`)) i++;
      name = `${HANDOFF_TOOL_PREFIX}${slug}_${i}`;
    }
    used.add(name);
    byId.set(target.id, name);
  }

  return byId;
}
