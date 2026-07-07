/**
 * Runtime handoff-description synthesizer (issue #38, Item A).
 *
 * Given a handoff *target* node, assemble a {@link HandoffNodeSummary} by
 * walking what the target actually does — its bound model, a snippet of its
 * prompt, the MCP servers/tools it can use — and, for a Subflow node, recursing
 * into the referenced flow (bounded by {@link MAX_SUBFLOW_DEPTH}). The pure
 * formatter in `@/shared/utils/handoffDescription` turns the summary into the
 * final string, so the FlowBuilder preview can reuse the exact same renderer.
 *
 * Guardrails (all confirmed for #38):
 *  - depth cap = MAX_SUBFLOW_DEPTH (the same ceiling runFlow enforces),
 *  - a bound MCP server is enumerated ONLY when already connected — we never
 *    spawn/connect a server just to introspect it; an offline server is listed
 *    by name only,
 *  - tool NAMES only (no descriptions/params), capped per server by the formatter,
 *  - a user-authored node description (FlowNode.data.description) wins verbatim.
 */
import { Flow, FlowNode } from '@/shared/types/flow';
import { flowService } from '@/backend/services/flow/index';
import { modelService } from '@/backend/services/model';
import { mcpService } from '@/backend/services/mcp';
import { createLogger } from '@/utils/logger';
import { MAX_SUBFLOW_DEPTH } from '@/backend/execution/flow/constants';
import {
  HandoffNodeSummary,
  HandoffServerSummary,
  formatHandoffDescription,
  formatFlowToolDescription,
} from '@/shared/utils/handoffDescription';

const log = createLogger('backend/execution/flow/buildHandoffDescription');

// Per-build caches: a single handoff-tool generation pass may reference the same
// model/server/flow many times. These live only for the duration of one
// build call (fresh instance per top-level target).
interface BuildCaches {
  modelNames: Map<string, string>;
  serverConnected: Map<string, boolean>;
  flows: Map<string, Flow | null>;
}

function newCaches(): BuildCaches {
  return { modelNames: new Map(), serverConnected: new Map(), flows: new Map() };
}

async function resolveModelName(modelId: string | undefined, caches: BuildCaches): Promise<string | undefined> {
  if (!modelId) return undefined;
  if (caches.modelNames.has(modelId)) return caches.modelNames.get(modelId);
  let name = modelId;
  try {
    const model = await modelService.getModel(modelId);
    if (model) name = (model.displayName && model.displayName.trim()) || model.name || modelId;
  } catch (err) {
    log.debug('resolveModelName failed; using raw id', { modelId, err });
  }
  caches.modelNames.set(modelId, name);
  return name;
}

async function isServerConnected(server: string, caches: BuildCaches): Promise<boolean> {
  if (caches.serverConnected.has(server)) return caches.serverConnected.get(server)!;
  let connected = false;
  try {
    // getServerStatus reports liveness WITHOUT spawning a stdio process
    // (it only adopts an already-running client from the recovery map).
    const status = await mcpService.getServerStatus(server);
    connected = status?.status === 'connected';
  } catch (err) {
    log.debug('getServerStatus failed; treating server as offline', { server, err });
  }
  caches.serverConnected.set(server, connected);
  return connected;
}

async function loadFlow(flowId: string, caches: BuildCaches): Promise<Flow | null> {
  if (caches.flows.has(flowId)) return caches.flows.get(flowId)!;
  let flow: Flow | null = null;
  try {
    flow = await flowService.getFlow(flowId);
  } catch (err) {
    log.debug('getFlow failed while summarising subflow', { flowId, err });
  }
  caches.flows.set(flowId, flow);
  return flow;
}

/** Build the MCP-server facets for a Process node from its bound MCP node references. */
async function summariseServers(properties: Record<string, unknown>, caches: BuildCaches): Promise<HandoffServerSummary[]> {
  const mcpNodes = Array.isArray((properties as any).mcpNodes) ? (properties as any).mcpNodes : [];
  const servers: HandoffServerSummary[] = [];
  const seen = new Set<string>();
  for (const mcpNode of mcpNodes) {
    const boundServer: string | undefined = mcpNode?.properties?.boundServer;
    if (!boundServer || seen.has(boundServer)) continue;
    seen.add(boundServer);
    const connected = await isServerConnected(boundServer, caches);
    // Tool names come from the node's own enabledTools — no server round-trip
    // (and therefore no spawn). We surface them only when the server is live.
    const enabledTools: string[] = Array.isArray(mcpNode?.properties?.enabledTools)
      ? mcpNode.properties.enabledTools
      : [];
    servers.push({
      name: boundServer,
      connected,
      tools: connected ? enabledTools : undefined,
    });
  }
  return servers;
}

/**
 * Recursively summarise a node. `depth` is the current subflow nesting level
 * (0 = the handoff target itself). `visitedFlows` breaks cycles where a flow
 * references itself directly or transitively.
 */
async function summariseNode(
  node: Pick<FlowNode, 'data'> & { type?: string },
  depth: number,
  caches: BuildCaches,
  visitedFlows: Set<string>,
): Promise<HandoffNodeSummary> {
  const type = (node.data?.type || node.type || 'unknown') as string;
  const label = node.data?.label || 'Unknown Node';
  const properties = (node.data?.properties || {}) as Record<string, unknown>;
  const userDescription = node.data?.description;

  const summary: HandoffNodeSummary = { label, type, userDescription };

  // A user-authored description wins verbatim — never synthesise over it.
  if (userDescription && userDescription.trim()) return summary;

  if (type === 'subflow') {
    const subflowId = (properties as any).subflowId as string | undefined;
    if (!subflowId) {
      summary.subflowMissing = true;
      return summary;
    }
    if (depth + 1 > MAX_SUBFLOW_DEPTH || visitedFlows.has(subflowId)) {
      summary.depthCapReached = true;
      const flow = await loadFlow(subflowId, caches);
      summary.subflowName = flow?.name;
      return summary;
    }
    const flow = await loadFlow(subflowId, caches);
    if (!flow) {
      summary.subflowMissing = true;
      return summary;
    }
    summary.subflowName = flow.name;
    const nextVisited = new Set(visitedFlows);
    nextVisited.add(subflowId);
    const childNodes = (flow.nodes || []).filter(
      (n) => n.data?.type === 'process' || n.data?.type === 'subflow' || n.type === 'process' || n.type === 'subflow',
    );
    summary.children = [];
    for (const child of childNodes) {
      summary.children.push(await summariseNode(child, depth + 1, caches, nextVisited));
    }
    return summary;
  }

  // Process (or any model-bound) node.
  summary.modelName = await resolveModelName((properties as any).boundModel as string | undefined, caches);
  const promptTemplate = (properties as any).promptTemplate;
  if (typeof promptTemplate === 'string' && promptTemplate.trim()) {
    summary.promptSummary = promptTemplate;
  }
  summary.servers = await summariseServers(properties, caches);
  return summary;
}

/**
 * Build the handoff-tool description string for a single target node. Falls back
 * to the plain `Hand off execution to <label> (<type>)` header on any error so a
 * synthesis failure can never break tool generation.
 */
export async function buildHandoffDescription(targetNode: FlowNode): Promise<string> {
  try {
    const summary = await summariseNode(targetNode, 0, newCaches(), new Set());
    return formatHandoffDescription(summary);
  } catch (err) {
    const label = targetNode.data?.label || 'Unknown Node';
    const type = (targetNode.data?.type || targetNode.type || 'unknown') as string;
    log.warn('buildHandoffDescription failed; falling back to basic description', { label, type, err });
    return `Hand off execution to ${label} (${type})`;
  }
}

/**
 * Build the MCP-tool description for a whole Flow exposed by the built-in FLUJO
 * MCP server (issue #38, Item D). The flow's Process/Subflow nodes are summarised
 * with the same live synthesizer used for handoff tools (bounded model + prompt
 * snippet + connected MCP servers/tools, recursing into subflows up to
 * MAX_SUBFLOW_DEPTH). A user-authored *node* description still wins verbatim for
 * that node (Flow has no top-level description field). Falls back to a minimal
 * one-liner on any error so tool listing can never break.
 */
export async function buildFlowToolDescription(flow: Flow): Promise<string> {
  try {
    const caches = newCaches();
    const visited = new Set<string>([flow.id]);
    const childNodes = (flow.nodes || []).filter(
      (n) => n.data?.type === 'process' || n.data?.type === 'subflow' || n.type === 'process' || n.type === 'subflow',
    );
    const children: HandoffNodeSummary[] = [];
    for (const child of childNodes) {
      children.push(await summariseNode(child, 1, caches, visited));
    }
    return formatFlowToolDescription(flow.name, children);
  } catch (err) {
    log.warn('buildFlowToolDescription failed; falling back to basic description', { flow: flow?.name, err });
    return `Runs the FLUJO flow "${flow?.name ?? 'unknown'}".`;
  }
}
