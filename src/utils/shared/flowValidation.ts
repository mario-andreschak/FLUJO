/**
 * Flow consistency checks — a pure, dependency-light validator that surfaces the ways a
 * saved flow can quietly become broken or un-runnable over time:
 *
 *   - a bound model was deleted
 *   - an MCP node's server is missing from the current server list (renamed, removed, or
 *     just offline)
 *   - the flow has no Start node (or more than one), or no Finish node
 *   - a Process node has no model bound
 *   - nodes are orphaned / unreachable from Start (missing connections)
 *   - a Process prompt still references tools from a server it is no longer connected to
 *     (e.g. after deleting an MCP node or renaming its server)
 *
 * This is intentionally framework-agnostic: it works off minimal structural shapes so it
 * can run in the browser (Flow builder "Check" button) and on the backend (before
 * execution) alike. Pass whatever context you have — model/server lookups are optional and
 * checks that need them are simply skipped when absent.
 */
import { findBindings } from './mcpBinding';

export type FlowIssueSeverity = 'error' | 'warning';

export interface FlowValidationIssue {
  severity: FlowIssueSeverity;
  /** Stable machine code, e.g. 'process-model-missing'. */
  code: string;
  /** Human-readable, ready to render. */
  message: string;
  /** The node the issue is about, when applicable (lets the UI select/open it). */
  nodeId?: string;
  nodeLabel?: string;
}

export interface FlowValidationResult {
  issues: FlowValidationIssue[];
  errorCount: number;
  warningCount: number;
  /** True when there are no error-severity issues (warnings don't block a run). */
  isRunnable: boolean;
}

export interface FlowValidationContext {
  /** Known models, for detecting a deleted/renamed bound model. Omit to skip those checks. */
  models?: Array<{ id: string; name?: string; displayName?: string }>;
  /** Known MCP servers, for detecting a deleted/renamed bound server. Omit to skip. */
  servers?: Array<{ name: string; status?: string }>;
  /**
   * Tool names available per server (keyed by server name). When provided, tool pills are
   * checked against actual availability. Omit to skip the per-tool availability check.
   */
  serverTools?: Record<string, string[]>;
}

// --- Minimal structural shapes (avoid a hard dependency on @xyflow/react types) ---

interface VNodeData {
  label?: string;
  type?: string;
  properties?: Record<string, any> | null;
}
export interface VNode {
  id: string;
  type?: string;
  data?: VNodeData | null;
}
export interface VEdge {
  id?: string;
  source: string;
  target: string;
  data?: { edgeType?: string; bidirectional?: boolean } | null;
}
export interface VFlow {
  id?: string;
  name?: string;
  nodes: VNode[];
  edges: VEdge[];
}

/** A node's effective type — prefer data.type (frontend) and fall back to node.type. */
export function getNodeType(node: VNode): string {
  return node.data?.type ?? node.type ?? 'unknown';
}

/** A node's display label, falling back to its id. */
export function getNodeLabel(node: VNode): string {
  return node.data?.label || node.id;
}

/** MCP (tool-wiring) edges are tagged edgeType 'mcp'; everything else is flow control. */
export function isMcpEdge(edge: VEdge): boolean {
  return edge.data?.edgeType === 'mcp';
}

/**
 * The set of MCP server names a Process node is wired to, via mcp edges to MCP nodes that
 * still exist and are bound to a server. This is the authority for "can this node call
 * tools from server X" — the same edge-derived view the execution converter builds.
 */
export function mcpServersConnectedToProcess(
  processNodeId: string,
  nodes: VNode[],
  edges: VEdge[]
): Set<string> {
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const servers = new Set<string>();
  for (const edge of edges) {
    if (!isMcpEdge(edge)) continue;
    let otherId: string | null = null;
    if (edge.source === processNodeId) otherId = edge.target;
    else if (edge.target === processNodeId) otherId = edge.source;
    if (!otherId) continue;
    const mcpNode = nodesById.get(otherId);
    if (!mcpNode || getNodeType(mcpNode) !== 'mcp') continue;
    const server = mcpNode.data?.properties?.boundServer;
    if (typeof server === 'string' && server) servers.add(server);
  }
  return servers;
}

/** Build adjacency (source -> targets) over flow-control (non-mcp) edges only.
 * Bidirectional edges connect both ways. */
function buildControlAdjacency(edges: VEdge[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  const add = (from: string, to: string) => {
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from)!.push(to);
  };
  for (const edge of edges) {
    if (isMcpEdge(edge)) continue;
    add(edge.source, edge.target);
    if (edge.data?.bidirectional) add(edge.target, edge.source);
  }
  return adj;
}

/** Node ids reachable from the given start ids over flow-control edges. */
function reachableFrom(startIds: string[], adj: Map<string, string[]>): Set<string> {
  const seen = new Set<string>(startIds);
  const queue = [...startIds];
  while (queue.length) {
    const id = queue.shift()!;
    for (const next of adj.get(id) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/**
 * Validate a flow against the (optional) current models/servers, returning a structured
 * list of issues. Errors block a run; warnings are advisory.
 */
export function validateFlow(flow: VFlow, context: FlowValidationContext = {}): FlowValidationResult {
  const issues: FlowValidationIssue[] = [];
  const nodes = Array.isArray(flow?.nodes) ? flow.nodes : [];
  const edges = Array.isArray(flow?.edges) ? flow.edges : [];

  const add = (severity: FlowIssueSeverity, code: string, message: string, node?: VNode) =>
    issues.push({
      severity,
      code,
      message,
      nodeId: node?.id,
      nodeLabel: node ? getNodeLabel(node) : undefined,
    });

  const modelById = new Map((context.models ?? []).map((m) => [m.id, m]));
  const serverByName = new Map((context.servers ?? []).map((s) => [s.name, s]));
  const haveModels = !!context.models;
  const haveServers = !!context.servers;

  const startNodes = nodes.filter((n) => getNodeType(n) === 'start');
  const finishNodes = nodes.filter((n) => getNodeType(n) === 'finish');
  const processNodes = nodes.filter((n) => getNodeType(n) === 'process');
  const mcpNodes = nodes.filter((n) => getNodeType(n) === 'mcp');

  // --- Structure: start / finish ---
  if (startNodes.length === 0) {
    add('error', 'no-start-node', 'The flow has no Start node, so it has no entry point.');
  } else if (startNodes.length > 1) {
    for (const extra of startNodes.slice(1)) {
      add('error', 'multiple-start-nodes', 'The flow has more than one Start node; only one is allowed.', extra);
    }
  }
  if (finishNodes.length === 0) {
    add('warning', 'no-finish-node', 'The flow has no Finish node; it will run but never reaches a defined end.');
  }

  // --- Process nodes: model binding ---
  // Note: we deliberately do NOT flag a stale cached technical name (props.modelName).
  // Binding is by id (boundModel) and execution always resolves the current model by id, so
  // the cached name is a display-only fallback with no effect on a run — warning about it
  // would be noise the user can't meaningfully act on.
  for (const node of processNodes) {
    const props = node.data?.properties ?? {};
    const boundModel = props.boundModel as string | undefined;
    if (!boundModel) {
      add('error', 'process-missing-model', `Process node "${getNodeLabel(node)}" has no model bound.`, node);
    } else if (haveModels && !modelById.has(boundModel)) {
      const cachedName = typeof props.modelName === 'string' && props.modelName ? ` (was "${props.modelName}")` : '';
      add(
        'error',
        'process-model-missing',
        `Process node "${getNodeLabel(node)}" is bound to a model that no longer exists${cachedName}.`,
        node
      );
    }
  }

  // --- MCP nodes: server binding + connectivity ---
  for (const node of mcpNodes) {
    const props = node.data?.properties ?? {};
    const boundServer = props.boundServer as string | undefined;
    if (!boundServer) {
      add('warning', 'mcp-missing-server', `MCP node "${getNodeLabel(node)}" is not bound to a server.`, node);
    } else if (haveServers && !serverByName.has(boundServer)) {
      // Absence from the current server list is ambiguous: the server may have been renamed
      // or removed, but it may equally be a remote server that's simply offline right now
      // (e.g. it's behind a VPN that isn't connected). Don't assert deletion as fact, and
      // don't block the run — if the binding is stale the user can rebind; if the server
      // comes back the flow just works. So this is an advisory warning, not an error.
      add(
        'warning',
        'mcp-server-missing',
        `MCP node "${getNodeLabel(node)}" is bound to server "${boundServer}", which isn't in your current MCP server list. It may be offline (e.g. not connected), renamed, or removed — if it was renamed or removed, rebind this node.`,
        node
      );
    } else if (haveServers) {
      const server = serverByName.get(boundServer)!;
      if (server.status && server.status !== 'connected') {
        const readable = server.status === 'disabled' ? 'disabled' : `not connected (${server.status})`;
        add(
          'warning',
          'mcp-server-disconnected',
          `MCP node "${getNodeLabel(node)}" is bound to server "${boundServer}", which is currently ${readable}. It will provide tools again once it reconnects.`,
          node
        );
      }
    }

    // An MCP node wired to no Process node contributes nothing to the flow.
    const wiredToProcess = edges.some(
      (e) => isMcpEdge(e) && (e.source === node.id || e.target === node.id)
    );
    if (!wiredToProcess) {
      add('warning', 'mcp-node-unconnected', `MCP node "${getNodeLabel(node)}" is not connected to any Process node.`, node);
    }
  }

  // --- Connectivity / runnability ---
  if (startNodes.length > 0) {
    const adj = buildControlAdjacency(edges);

    // A Start node with no outgoing flow-control edge can't drive the flow.
    for (const start of startNodes) {
      if (!(adj.get(start.id)?.length)) {
        add('error', 'start-no-outgoing', 'The Start node is not connected to anything; the flow cannot run.', start);
      }
    }

    // Process/Finish nodes unreachable from any Start are dead weight (or a missing link).
    const reachable = reachableFrom(startNodes.map((s) => s.id), adj);
    for (const node of [...processNodes, ...finishNodes]) {
      if (!reachable.has(node.id)) {
        add(
          'warning',
          'unreachable-node',
          `${getNodeType(node) === 'finish' ? 'Finish' : 'Process'} node "${getNodeLabel(node)}" is not reachable from the Start node.`,
          node
        );
      }
    }
  }

  // --- Dangling tool/resource pills in Process prompts ---
  for (const node of processNodes) {
    const promptTemplate = node.data?.properties?.promptTemplate;
    if (typeof promptTemplate !== 'string' || !promptTemplate) continue;

    const connectedServers = mcpServersConnectedToProcess(node.id, nodes, edges);
    const seen = new Set<string>();
    for (const binding of findBindings(promptTemplate)) {
      // Handoff pills aren't server-bound; they're validated by flow control, not here.
      if (binding.server === 'handoff') continue;
      const key = `${binding.kind}:${binding.server}:${binding.name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (!connectedServers.has(binding.server)) {
        add(
          'error',
          'tool-pill-disconnected',
          `Process node "${getNodeLabel(node)}" references ${binding.kind} "${binding.name}" from server "${binding.server}", but it is not connected to that server (the MCP node was removed or the server was renamed).`,
          node
        );
      } else if (
        binding.kind === 'tool' &&
        context.serverTools &&
        context.serverTools[binding.server] &&
        !context.serverTools[binding.server].includes(binding.name)
      ) {
        add(
          'warning',
          'tool-unavailable',
          `Process node "${getNodeLabel(node)}" references tool "${binding.name}" which server "${binding.server}" no longer provides.`,
          node
        );
      }
    }
  }

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.length - errorCount;
  return { issues, errorCount, warningCount, isRunnable: errorCount === 0 };
}
