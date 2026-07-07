/**
 * Handoff tool description synthesis (issue #38, Item A).
 *
 * An orchestrator Process node routes purely from its handoff tools' names and
 * descriptions. The default description used to be just
 * `Hand off execution to <label> (<type>)`, which says nothing about what the
 * target actually does. This module renders a richer, bounded description from
 * a structured summary of the target node (its model, a prompt snippet, the MCP
 * servers/tools it can use, and — for a Subflow node — a recursive summary of
 * what the referenced flow contains).
 *
 * It is a PURE formatter: callers assemble the {@link HandoffNodeSummary} (the
 * runtime does so with live services and full subflow recursion; the FlowBuilder
 * preview does a shallower, in-memory pass) and this function turns it into the
 * final string. Keeping the formatting here means runtime and preview share one
 * renderer and can never drift on shape. A user-authored node description always
 * wins verbatim and is never synthesised over.
 */

/** Max MCP tool names listed per server (issue #38, Q3). */
export const MAX_TOOLS_LISTED_PER_SERVER = 10;

/** Max child nodes summarised for one subflow level (breadth guard). */
export const MAX_SUBFLOW_CHILDREN_LISTED = 10;

/** Hard cap on a synthesised handoff description, to protect the context window. */
export const MAX_HANDOFF_DESCRIPTION_CHARS = 1500;

/** Max characters of a Process node's prompt folded into the summary. */
export const MAX_PROMPT_SUMMARY_CHARS = 200;

export interface HandoffServerSummary {
  /** MCP server name. */
  name: string;
  /** Whether the server was reachable when the summary was built. */
  connected: boolean;
  /** Tool names the node uses (already capped by the caller; only meaningful when connected). */
  tools?: string[];
}

export interface HandoffNodeSummary {
  label: string;
  type: string;
  /**
   * A user-authored description (FlowNode.data.description). When present it is
   * returned verbatim and nothing is synthesised — never override human intent.
   */
  userDescription?: string;
  // --- Process node facets ---
  /** Bound model display name (runtime) or technical id (preview fallback). */
  modelName?: string;
  /** A short snippet of the node's rendered prompt/role. */
  promptSummary?: string;
  /** MCP servers this Process node binds and (when connected) their tool names. */
  servers?: HandoffServerSummary[];
  // --- Subflow node facets ---
  /** Display name of the referenced flow. */
  subflowName?: string;
  /** True when the referenced flow could not be found. */
  subflowMissing?: boolean;
  /** Process/Subflow nodes inside the referenced flow (recursive). */
  children?: HandoffNodeSummary[];
  /** True when recursion stopped here because the depth cap was reached. */
  depthCapReached?: boolean;
  /**
   * Set by callers that cannot resolve a subflow's contents (the FlowBuilder
   * preview only has the current flow in memory). Renders a note that the full
   * summary is produced when the flow runs, instead of a misleading empty list.
   */
  subflowDetailsUnavailable?: boolean;
}

/** Truncate to `max` chars on a whitespace boundary where possible, adding an ellipsis. */
function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const slice = clean.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd()}…`;
}

function renderLines(summary: HandoffNodeSummary, depth: number, lines: string[]): void {
  const indent = '  '.repeat(depth);

  // A user-authored description wins for nested children too (the root case is
  // short-circuited in formatHandoffDescription before we ever get here).
  if (summary.userDescription && summary.userDescription.trim()) {
    lines.push(`${indent}${truncate(summary.userDescription, MAX_PROMPT_SUMMARY_CHARS)}`);
    return;
  }

  if (summary.type === 'subflow') {
    if (summary.subflowMissing) {
      lines.push(`${indent}Runs a subflow (referenced flow not found).`);
      return;
    }
    if (summary.subflowDetailsUnavailable) {
      const named = summary.subflowName ? ` "${summary.subflowName}"` : '';
      lines.push(`${indent}Runs a subflow${named} (contents summarised when the flow runs).`);
      return;
    }
    lines.push(`${indent}Runs the subflow "${summary.subflowName ?? 'unknown'}", which contains:`);
    if (summary.depthCapReached) {
      lines.push(`${indent}  (nested subflows omitted — recursion depth limit reached)`);
      return;
    }
    const children = summary.children ?? [];
    if (children.length === 0) {
      lines.push(`${indent}  (no process or subflow steps)`);
      return;
    }
    for (const child of children.slice(0, MAX_SUBFLOW_CHILDREN_LISTED)) {
      lines.push(`${indent}  - ${child.label}:`);
      renderLines(child, depth + 2, lines);
    }
    if (children.length > MAX_SUBFLOW_CHILDREN_LISTED) {
      lines.push(`${indent}  - …and ${children.length - MAX_SUBFLOW_CHILDREN_LISTED} more step(s)`);
    }
    return;
  }

  // Process (and any model-bound) node facets.
  if (summary.modelName) {
    lines.push(`${indent}Model: ${summary.modelName}`);
  }
  if (summary.promptSummary) {
    lines.push(`${indent}Role: ${truncate(summary.promptSummary, MAX_PROMPT_SUMMARY_CHARS)}`);
  }
  if (summary.servers && summary.servers.length > 0) {
    for (const server of summary.servers) {
      if (server.connected && server.tools && server.tools.length > 0) {
        const shown = server.tools.slice(0, MAX_TOOLS_LISTED_PER_SERVER);
        const extra = server.tools.length - shown.length;
        const suffix = extra > 0 ? `, +${extra} more` : '';
        lines.push(`${indent}Tools (${server.name}): ${shown.join(', ')}${suffix}`);
      } else {
        lines.push(`${indent}Tools (${server.name}): server not connected`);
      }
    }
  }
}

/**
 * Render a handoff tool description from a target-node summary. Returns a
 * bounded string (<= {@link MAX_HANDOFF_DESCRIPTION_CHARS}). A user-authored
 * description wins verbatim (still bounded).
 */
export function formatHandoffDescription(summary: HandoffNodeSummary): string {
  if (summary.userDescription && summary.userDescription.trim()) {
    return truncate(summary.userDescription, MAX_HANDOFF_DESCRIPTION_CHARS);
  }

  const header = `Hand off execution to ${summary.label} (${summary.type}).`;
  const lines: string[] = [];
  renderLines(summary, 0, lines);

  const body = lines.join('\n').trim();
  const full = body ? `${header}\n${body}` : header;

  if (full.length <= MAX_HANDOFF_DESCRIPTION_CHARS) return full;
  // Truncate the synthesised body but always keep the header intact.
  const room = MAX_HANDOFF_DESCRIPTION_CHARS - header.length - 2;
  if (room <= 0) return header;
  return `${header}\n${truncate(body, room)}`;
}
