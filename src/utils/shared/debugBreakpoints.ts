/**
 * Breakpoint vocabulary shared by the visual debugger (frontend) and the
 * execution loop (backend).
 *
 * `SharedState.breakpoints` is a flat string array. Historically it held node
 * IDs only, plus the one-shot `'*'` sentinel armed by the "attach debugger"
 * control. Tool breakpoints (issue: debug tool calls) extend the same array
 * with a namespaced prefix so nothing about persistence or the REST contract
 * has to change:
 *
 *   - `<nodeId>`      pause BEFORE that node executes
 *   - `'*'`           one-shot: pause before whatever node comes next (attach)
 *   - `'tool:*'`      pause BEFORE executing ANY tool call batch
 *   - `'tool:<name>'` pause before a batch containing that tool. `<name>` is
 *                     matched against the model-facing tool name, the decoded
 *                     `server:tool` pair, and the bare decoded tool name, so a
 *                     breakpoint survives the mcp_<slug>_<hash> namespacing.
 *   - `'tool-node:<id>'` pause before a call supplied by one MCP attachment
 *                        node. MCP nodes are configuration, not executable graph
 *                        nodes, so the canvas translates clicks on them to this
 *                        runtime breakpoint instead of creating a dead node BP.
 */

export const ATTACH_BREAKPOINT = '*';
export const TOOL_BREAKPOINT_PREFIX = 'tool:';
export const TOOL_NODE_BREAKPOINT_PREFIX = 'tool-node:';
export const ANY_TOOL_BREAKPOINT = 'tool:*';

/** A tool call as seen by the loop (only the name matters here). */
export interface BreakpointToolCall {
  function?: { name?: string };
}

/** Decoded (server, tool) for a namespaced MCP tool name, when available. */
export type ToolNameDecoder = (name: string) => { server: string; tool: string; nodeId?: string } | null | undefined;

export const isToolBreakpoint = (breakpoint: string): boolean =>
  breakpoint.startsWith(TOOL_BREAKPOINT_PREFIX)
  || breakpoint.startsWith(TOOL_NODE_BREAKPOINT_PREFIX);

/** Node-scoped breakpoints only (everything that is not a tool breakpoint or the attach sentinel). */
export const nodeBreakpoints = (breakpoints: readonly string[] | undefined): string[] =>
  (breakpoints ?? []).filter(b => b !== ATTACH_BREAKPOINT && !isToolBreakpoint(b));

/** Tool breakpoints only, without the `tool:` prefix (`['*']`, `['read_file']`, …). */
export const toolBreakpointNames = (breakpoints: readonly string[] | undefined): string[] =>
  (breakpoints ?? [])
    .filter(b => b.startsWith(TOOL_BREAKPOINT_PREFIX))
    .map(b => b.slice(TOOL_BREAKPOINT_PREFIX.length));

/** MCP attachment node IDs carrying an "any tool from this attachment" breakpoint. */
export const toolNodeBreakpointIds = (breakpoints: readonly string[] | undefined): string[] =>
  (breakpoints ?? [])
    .filter(b => b.startsWith(TOOL_NODE_BREAKPOINT_PREFIX))
    .map(b => b.slice(TOOL_NODE_BREAKPOINT_PREFIX.length));

export const hasAnyToolBreakpoint = (breakpoints: readonly string[] | undefined): boolean =>
  (breakpoints ?? []).some(isToolBreakpoint);

/**
 * The first tool call in `toolCalls` that an armed tool breakpoint matches, or
 * null when the batch should run without pausing. Returns the matched tool's
 * model-facing name so callers can log/emit which breakpoint fired.
 */
export function matchToolBreakpoint(
  breakpoints: readonly string[] | undefined,
  toolCalls: readonly BreakpointToolCall[] | undefined,
  decode?: ToolNameDecoder,
): string | null {
  if (!breakpoints || breakpoints.length === 0) return null;
  if (!toolCalls || toolCalls.length === 0) return null;
  const armed = toolBreakpointNames(breakpoints);
  const armedNodeIds = toolNodeBreakpointIds(breakpoints);
  if (armed.length === 0 && armedNodeIds.length === 0) return null;
  const wildcard = armed.includes('*');

  for (const call of toolCalls) {
    const name = call?.function?.name;
    if (!name) continue;
    if (wildcard) return name;
    const decoded = decode ? decode(name) : null;
    const aliases = [name];
    if (decoded) {
      aliases.push(`${decoded.server}:${decoded.tool}`, decoded.tool);
      if (decoded.nodeId && armedNodeIds.includes(decoded.nodeId)) return name;
    }
    if (armed.some(target => aliases.includes(target))) return name;
  }
  return null;
}
