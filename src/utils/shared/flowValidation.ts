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
import { EdgeCondition, isValidConditionKind, isRegexCompilable } from './edgeConditions';
import { referencedRunVars, isValidRunVarName } from './resolveRunVars';
import { referencedKvKeys, isValidKvName, parseKvRef } from './resolveKvRefs';

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
  data?: { edgeType?: string; bidirectional?: boolean; condition?: EdgeCondition } | null;
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

/** MCP (tool-wiring) edges are tagged edgeType 'mcp'. */
export function isMcpEdge(edge: VEdge): boolean {
  return edge.data?.edgeType === 'mcp';
}

/** Resource (data-wiring, Tier 3) edges are tagged edgeType 'resource'. */
export function isResourceEdge(edge: VEdge): boolean {
  return edge.data?.edgeType === 'resource';
}

/**
 * Attachment edges (mcp/resource) are configuration wiring, not flow control.
 * Every control-flow discrimination below must use THIS predicate, not
 * isMcpEdge alone — a resource edge misread as a control edge corrupts
 * reachability, subflow outgoing counting and condition routing.
 */
export function isAttachmentEdge(edge: VEdge): boolean {
  return isMcpEdge(edge) || isResourceEdge(edge);
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

/** Build adjacency (source -> targets) over flow-control (non-attachment) edges
 * only. Bidirectional edges connect both ways. */
function buildControlAdjacency(edges: VEdge[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  const add = (from: string, to: string) => {
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from)!.push(to);
  };
  for (const edge of edges) {
    if (isAttachmentEdge(edge)) continue;
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

  // --- Resource nodes (Tier 3: data artifacts in the graph) ---
  // A resource node is a config holder like an MCP node. Edge direction
  // encodes role: resource → process = the step CONSUMES the artifact;
  // process → resource = the step PRODUCES it (run scope only).
  const resourceNodes = nodes.filter((n) => getNodeType(n) === 'resource');
  for (const node of resourceNodes) {
    const props = node.data?.properties ?? {};
    const scope = props.scope === 'run' ? 'run' : 'mcp';
    const boundServer = typeof props.boundServer === 'string' ? props.boundServer : '';
    const uri = typeof props.uri === 'string' ? props.uri : '';
    const runName = typeof props.runName === 'string' ? props.runName.trim() : '';

    if (scope === 'mcp' && (!boundServer || !uri)) {
      add(
        'warning',
        'resource-missing-binding',
        `Resource node "${getNodeLabel(node)}" has no ${!boundServer ? 'server' : 'resource URI'} bound; connected steps will receive nothing.`,
        node
      );
    }
    if (scope === 'run' && !runName) {
      add(
        'warning',
        'resource-missing-binding',
        `Resource node "${getNodeLabel(node)}" is a run artifact with no name; give it a name so steps can produce/consume it.`,
        node
      );
    }
    if (scope === 'run' && runName && !isValidRunVarName(runName)) {
      add(
        'warning',
        'resource-run-name',
        `Resource node "${getNodeLabel(node)}" is named "${runName}", which is not a valid artifact name (letters, digits, _ and - only, not starting with a digit); it will be awkward to reference with \${res:...}.`,
        node
      );
    }

    if (scope === 'mcp' && boundServer && haveServers && !serverByName.has(boundServer)) {
      add(
        'warning',
        'resource-server-missing',
        `Resource node "${getNodeLabel(node)}" is bound to server "${boundServer}", which isn't in your current MCP server list.`,
        node
      );
    }

    const touching = edges.filter(
      (e) => isResourceEdge(e) && (e.source === node.id || e.target === node.id)
    );
    if (touching.length === 0) {
      add('warning', 'resource-node-unconnected', `Resource node "${getNodeLabel(node)}" is not connected to any Process node.`, node);
    }

    // Produce edges (process → resource) are only meaningful for run artifacts:
    // a static MCP resource cannot be written by a step.
    const produceEdges = touching.filter((e) => e.target === node.id);
    if (scope === 'mcp' && produceEdges.length > 0) {
      add(
        'error',
        'resource-produce-static',
        `Resource node "${getNodeLabel(node)}" is a static MCP resource, but a step writes INTO it. Only run artifacts (scope "run") can be produced by a step — flip the edge or make this a run artifact.`,
        node
      );
    }
    if (scope === 'run' && produceEdges.length > 1) {
      add(
        'warning',
        'resource-multiple-producers',
        `Resource node "${getNodeLabel(node)}" is produced by ${produceEdges.length} steps; the last writer wins. Consider one producer per artifact.`,
        node
      );
    }
    if (scope === 'run' && produceEdges.length === 0 && touching.length > 0) {
      add(
        'warning',
        'resource-consumed-never-produced',
        `Resource node "${getNodeLabel(node)}" is consumed but no step in this flow produces it; it resolves to nothing unless an earlier run captured it.`,
        node
      );
    }
  }

  // --- Signal nodes (issue #117: deterministic in-flow event emission) ---
  // A signal node emits {topic, payload} onto the flow-run bus when traversed.
  // Without a topic nothing can listen, so the node is inert — advisory only.
  const signalNodes = nodes.filter((n) => getNodeType(n) === 'signal');
  for (const node of signalNodes) {
    const props = node.data?.properties ?? {};
    const topic = typeof props.topic === 'string' ? props.topic.trim() : '';
    if (!topic) {
      add(
        'warning',
        'signal-missing-topic',
        `Signal node "${getNodeLabel(node)}" has no topic; it emits nothing. Give it a topic that a flow-event trigger can listen for.`,
        node
      );
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

  // --- Subflow nodes: single outgoing path ---
  // A subflow hands off blindly to its first successor — it has no model to
  // choose between routes. Allowed shapes: one outgoing edge (A > B > C) or
  // one bidirectional edge back to the caller (A <> B). More than one
  // outgoing path (counting the reverse transition a bidirectional edge
  // gives its target) makes the follow-up node order-dependent.
  const subflowNodes = nodes.filter((n) => getNodeType(n) === 'subflow');
  for (const node of subflowNodes) {
    const outgoing = edges.filter(
      (e) =>
        !isAttachmentEdge(e) &&
        (e.source === node.id || (e.target === node.id && !!e.data?.bidirectional))
    );
    if (outgoing.length > 1) {
      add(
        'error',
        'subflow-multiple-outgoing',
        `Subflow node "${getNodeLabel(node)}" has ${outgoing.length} outgoing connections; a subflow can only have one (either A > B > C or a bidirectional A <> B).`,
        node
      );
    }

    // --- Fan-out target: a single child (subflowId) OR parallel lanes (parallelSubflowIds).
    // The single-outgoing-edge rule above is about SUCCESSORS and is unchanged; this is about
    // CHILDREN. Only ADD the parallel acceptance path — never regress single-child subflows.
    const props = node.data?.properties ?? {};
    const subflowId = typeof props.subflowId === 'string' && props.subflowId ? props.subflowId : undefined;
    const parallelIds = Array.isArray(props.parallelSubflowIds)
      ? props.parallelSubflowIds.filter((id: unknown): id is string => typeof id === 'string' && !!id)
      : [];
    if (subflowId && parallelIds.length > 0) {
      add(
        'error',
        'subflow-both-targets',
        `Subflow node "${getNodeLabel(node)}" sets both a single "subflowId" and "parallelSubflowIds"; use one or the other.`,
        node
      );
    }

    // --- Map-over-list (Tier 2a): runs the SINGLE child once per item. It needs a
    // resolvable single subflowId and is mutually exclusive with the parallel
    // fan-out lanes. This mirrors the subflow-both-targets shape.
    const mapOverList = props.mapOverList === true;
    if (mapOverList && parallelIds.length > 0) {
      add(
        'error',
        'subflow-map-and-parallel',
        `Subflow node "${getNodeLabel(node)}" combines "mapOverList" with "parallelSubflowIds"; map-over-list runs a single child once per item and cannot be combined with parallel fan-out.`,
        node
      );
    }
    if (mapOverList && !subflowId && parallelIds.length === 0) {
      add(
        'error',
        'subflow-map-no-child',
        `Subflow node "${getNodeLabel(node)}" has "mapOverList" but no child flow ("subflowId"); select a flow to run once per item.`,
        node
      );
    }

    // --- Dynamic fan-out (issue #130): parallelSubflowIdsVar names a run-scoped
    // variable whose value lists the fan-out target flow ids AT RUNTIME. It is a
    // fan-out (multiple CHILDREN), so — like the static parallel list — it is
    // mutually exclusive with map-over-list; and it needs a valid variable name
    // that some node actually captures (advisory: it may also be caller-seeded).
    const parallelVar =
      typeof props.parallelSubflowIdsVar === 'string' ? props.parallelSubflowIdsVar.trim() : '';
    if (parallelVar) {
      if (!isValidRunVarName(parallelVar)) {
        add(
          'warning',
          'subflow-parallel-var-name',
          `Subflow node "${getNodeLabel(node)}" reads dynamic fan-out targets from "${parallelVar}", which is not a valid variable name (letters, digits, _ and - only, not starting with a digit); it will be awkward to capture with \${var:...}.`,
          node
        );
      }
      if (mapOverList) {
        add(
          'error',
          'subflow-map-and-parallel-var',
          `Subflow node "${getNodeLabel(node)}" combines "mapOverList" with dynamic fan-out ("parallelSubflowIdsVar"); map-over-list runs a single child once per item and cannot be combined with fan-out.`,
          node
        );
      }
      const capturedSomewhere = nodes.some((n) => {
        const c = n.data?.properties?.captureVariable;
        return typeof c === 'string' && c.trim() === parallelVar;
      });
      if (!capturedSomewhere) {
        add(
          'warning',
          'subflow-parallel-var-uncaptured',
          `Subflow node "${getNodeLabel(node)}" reads dynamic fan-out targets from variable "${parallelVar}", but no node captures it (captureVariable). It may be seeded by the caller; otherwise it resolves to no targets and the node falls back to its static parallel list.`,
          node
        );
      }
    }

    // --- Agentic fan-out (issue #130 Phase 4): allowCallerFanout lets the ROUTING
    // model pass the parallel set via the handoff tool at call time. Like the
    // other fan-out sources it is a fan-out (multiple CHILDREN) and so is mutually
    // exclusive with map-over-list (which runs a single child once per item).
    if (props.allowCallerFanout === true && mapOverList) {
      add(
        'error',
        'subflow-map-and-caller-fanout',
        `Subflow node "${getNodeLabel(node)}" combines "mapOverList" with agentic fan-out ("allowCallerFanout"); map-over-list runs a single child once per item and cannot be combined with fan-out.`,
        node
      );
    }
    if (parallelIds.length > 0) {
      const limit = props.concurrencyLimit;
      if (typeof limit === 'number' && limit < 1) {
        add(
          'warning',
          'subflow-concurrency-limit',
          `Subflow node "${getNodeLabel(node)}" has a concurrencyLimit of ${limit}; it must be at least 1 (the runtime default will be used).`,
          node
        );
      }
    }
  }

  // --- Tier 2b: deterministic edge conditions ---
  // A condition lets the engine route on the last message (first matching
  // outgoing edge wins, a bare edge is the fallback). Only process nodes route
  // this way, so a condition anywhere else is an error; and a conditioned node
  // with no bare fallback can dead-end when nothing matches (advisory).
  {
    const nodesById = new Map(nodes.map((n) => [n.id, n]));
    const conditionedSources = new Set<string>();
    for (const edge of edges) {
      if (isAttachmentEdge(edge)) continue;
      const condition = edge.data?.condition;
      if (!condition || typeof condition !== 'object') continue;

      const sourceNode = nodesById.get(edge.source);
      const sourceType = sourceNode ? getNodeType(sourceNode) : 'unknown';
      if (sourceType !== 'process') {
        add(
          'error',
          'edge-condition-non-process',
          `An edge leaving ${sourceType === 'unknown' ? 'an unknown' : `the ${sourceType}`} node "${sourceNode ? getNodeLabel(sourceNode) : edge.source}" has a routing condition, but only process nodes can route on a condition.`,
          sourceNode ?? undefined
        );
        continue;
      }

      conditionedSources.add(edge.source);

      if (!isValidConditionKind(condition.kind)) {
        add(
          'warning',
          'edge-condition-kind',
          `Process node "${getNodeLabel(sourceNode!)}" has an outgoing edge whose condition kind "${String(condition.kind)}" is unknown; it will never match.`,
          sourceNode!
        );
      } else if (condition.kind === 'always') {
        // 'always' is a valid value-less always-true predicate (issue #111) —
        // it is the deterministic default route, so no "missing value" warning.
      } else if (typeof condition.value !== 'string' || condition.value.length === 0) {
        add(
          'warning',
          'edge-condition-value',
          `Process node "${getNodeLabel(sourceNode!)}" has an outgoing edge condition with no "value"; it will never match.`,
          sourceNode!
        );
      } else if (condition.kind === 'regex' && !isRegexCompilable(condition.value)) {
        add(
          'warning',
          'edge-condition-regex',
          `Process node "${getNodeLabel(sourceNode!)}" has an outgoing edge with a regex condition that does not compile; it will never match.`,
          sourceNode!
        );
      }
    }

    // A conditioned node with no bare (predicate-less) outgoing edge dead-ends
    // whenever no predicate matches. A bidirectional edge pointing AT the node
    // gives it a bare reverse route, which counts as a fallback.
    for (const nodeId of conditionedSources) {
      const node = nodesById.get(nodeId);
      if (!node) continue;
      const hasBareFallback = edges.some((e) => {
        if (isAttachmentEdge(e)) return false;
        // A bare edge, OR an `always` edge (issue #111) which always matches, is a
        // fallback: the node can never dead-end on a non-matching reply.
        if (e.source === nodeId) {
          return !e.data?.condition || (e.data.condition.kind === 'always' && !e.data.condition.negate);
        }
        if (e.target === nodeId && e.data?.bidirectional) return true; // reverse route is bare
        return false;
      });
      if (!hasBareFallback) {
        add(
          'warning',
          'edge-condition-no-fallback',
          `Process node "${getNodeLabel(node)}" has conditioned outgoing edges but no bare fallback edge; if no condition matches, the flow ends here.`,
          node
        );
      }
    }
  }

  // --- Tier 2c: named variables (${var:NAME} + captureVariable) ---
  // Advisory only — never blocks a run. A var can also be seeded from
  // FlowRunInput.variables (caller-supplied), so an "uncaptured" reference is a
  // likely typo/ordering bug, not proof of breakage.
  {
    // Every variable name some node captures via captureVariable.
    const capturedNames = new Set<string>();
    for (const node of nodes) {
      const capture = node.data?.properties?.captureVariable;
      if (typeof capture === 'string' && capture.trim()) {
        const name = capture.trim();
        capturedNames.add(name);
        if (!isValidRunVarName(name)) {
          add(
            'warning',
            'capture-var-name',
            `${getNodeType(node) === 'subflow' ? 'Subflow' : 'Process'} node "${getNodeLabel(node)}" captures into "${name}", which is not a valid variable name (letters, digits, _ and - only, not starting with a digit); it will be awkward to reference with \${var:...}.`,
            node
          );
        }
      }
    }

    // Any ${var:NAME} reference to a name nothing in the flow captures.
    const referenceFields = ['promptTemplate', 'isolatedPrompt'] as const;
    const warnedRefs = new Set<string>();
    for (const node of nodes) {
      const props = node.data?.properties ?? {};
      for (const field of referenceFields) {
        const text = (props as Record<string, unknown>)[field];
        if (typeof text !== 'string' || !text) continue;
        for (const name of referencedRunVars(text)) {
          if (capturedNames.has(name)) continue;
          const dedupeKey = `${node.id}:${name}`;
          if (warnedRefs.has(dedupeKey)) continue;
          warnedRefs.add(dedupeKey);
          add(
            'warning',
            'var-ref-uncaptured',
            `${getNodeLabel(node)} references \${var:${name}} but no step in this flow captures "${name}" (via captureVariable). It resolves to empty unless supplied as a run input — check for a typo or a step ordered after this one.`,
            node
          );
        }
      }
    }
  }

  // --- Tier 4: persistent kv (${kv:NAME} + captureKv) ---
  // Advisory only. kv is CROSS-RUN state, so — unlike ${var:} — a reference to a key
  // nothing in THIS flow captures is expected (an earlier run, or another flow in the
  // same folder, may have seeded it). We only flag a malformed key NAME.
  {
    for (const node of nodes) {
      const capture = node.data?.properties?.captureKv;
      if (typeof capture === 'string' && capture.trim()) {
        const { key } = parseKvRef(capture.trim());
        if (!isValidKvName(key)) {
          add(
            'warning',
            'capture-kv-name',
            `${getNodeType(node) === 'subflow' ? 'Subflow' : 'Process'} node "${getNodeLabel(node)}" captures into kv "${capture.trim()}", whose key is not a valid name (letters, digits, _ and - only, not starting with a digit); it will be awkward to reference with \${kv:...}.`,
            node
          );
        }
      }
    }

    const kvFields = ['promptTemplate', 'isolatedPrompt'] as const;
    const warnedKvRefs = new Set<string>();
    for (const node of nodes) {
      const props = node.data?.properties ?? {};
      for (const field of kvFields) {
        const text = (props as Record<string, unknown>)[field];
        if (typeof text !== 'string' || !text) continue;
        for (const token of referencedKvKeys(text)) {
          const { key } = parseKvRef(token);
          if (isValidKvName(key)) continue;
          const dedupeKey = `${node.id}:${token}`;
          if (warnedKvRefs.has(dedupeKey)) continue;
          warnedKvRefs.add(dedupeKey);
          add(
            'warning',
            'kv-ref-name',
            `${getNodeLabel(node)} references \${kv:${token}}, whose key is not a valid name (letters, digits, _ and - only, not starting with a digit); it resolves to empty.`,
            node
          );
        }
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
