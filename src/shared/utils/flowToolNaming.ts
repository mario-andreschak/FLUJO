/**
 * Flow-as-MCP-tool naming (issue #38, Item D).
 *
 * The built-in FLUJO MCP server (`/mcp`) exposes every saved Flow as a tool so
 * an external LLM/host can discover and pick a flow autonomously. A flow's tool
 * name is a slug of its display name (`Web Research` -> `web_research`). MCP tool
 * names must match /^[A-Za-z0-9_-]+$/ and stay reasonably short, so we slugify
 * and cap, then resolve collisions deterministically with a numeric suffix.
 *
 * This module is PURE (no I/O) so the list/call mapping is unit-testable without
 * spinning up the transport, and so the endpoint's `tools/list` and `tools/call`
 * derive the exact same name -> flow mapping from the same flow set.
 */

// Keep well under the MCP 64-char tool-name ceiling even after a collision suffix.
const MAX_FLOW_SLUG_LENGTH = 56;

/**
 * Turn a flow display name into a compact, lowercase, underscore-separated slug
 * safe to use as an MCP tool name. Falls back to `flow` when the name slugs away
 * to nothing (e.g. a name of only punctuation).
 */
export function slugifyFlowName(name?: string): string {
  const base = (name && name.trim()) || 'flow';
  let slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_') // any run of non-alphanumerics -> single underscore
    .replace(/_+/g, '_') // collapse repeats
    .replace(/^_+|_+$/g, ''); // trim leading/trailing underscores
  if (slug.length > MAX_FLOW_SLUG_LENGTH) {
    slug = slug.slice(0, MAX_FLOW_SLUG_LENGTH).replace(/_+$/g, '');
  }
  return slug || 'flow';
}

/** A minimal reference to a flow for naming purposes. */
export interface FlowToolNameRef {
  id: string;
  name?: string;
}

/**
 * Build a stable, collision-free map from flow id -> MCP tool name.
 *
 * Two flows that slugify to the same stub get a numeric suffix
 * (`web_research`, `web_research_2`, ...), assigned in input order so the result
 * is deterministic. Duplicate ids collapse to a single entry (the Map keys by
 * id), so callers may pass repeated ids safely.
 */
export function buildFlowToolNameMap(flows: FlowToolNameRef[]): Map<string, string> {
  const used = new Set<string>();
  const byId = new Map<string, string>();

  for (const flow of flows) {
    if (byId.has(flow.id)) continue; // already assigned; keep the first
    const slug = slugifyFlowName(flow.name);
    let name = slug;
    if (used.has(name)) {
      let i = 2;
      while (used.has(`${slug}_${i}`)) i++;
      name = `${slug}_${i}`;
    }
    used.add(name);
    byId.set(flow.id, name);
  }

  return byId;
}
