/**
 * FlowSpec → Flow compiler (issue #14, flow generation).
 *
 * The flow generator does NOT ask the LLM to emit raw ReactFlow JSON — that format is
 * full of load-bearing trivia a model will fumble (edges without sourceHandle/targetHandle
 * are silently dropped by the FlowBuilder on load; edge ids must follow
 * `source:handle->target:handle`; handle ids are a fixed per-node-type vocabulary;
 * `properties.mcpNodes` is derived from MCP edges by the FlowConverter and must never be
 * hand-authored). Instead the model emits a compact semantic {@link FlowSpec} and this
 * pure, deterministic compiler produces the ReactFlow JSON: uuids, layered layout,
 * handle ids, edge ids, MCP nodes + mcp edges, markers.
 *
 * The compiler is BEST-EFFORT: it always returns a flow when at least one node is usable,
 * recording everything it skipped or could not resolve as {@link CompileIssue}s. Semantic
 * problems (unknown model, unresolved subflow target, …) surface here or in the follow-up
 * `validateFlow` pass and feed the generator's repair loop; the reviewed-in-builder draft
 * is the final safety valve, so a flawed flow is still worth returning.
 *
 * Kept in utils/shared: pure data-in/data-out, no services, safe for backend and browser.
 * The edge shapes deliberately mirror the builder's `createEdgeFromConnection`
 * (FlowBuilder/Canvas/utils/edgeUtils.ts) + `mcpEdgeOptions` (Canvas/types.ts) — the
 * compiler must not import frontend component modules, so the shapes are re-declared here
 * and pinned to the originals by __tests__/flow/flowSpecCompiler.test.ts.
 */
import { v4 as uuidv4 } from 'uuid';
import type { Edge } from '@xyflow/react';
import { Flow, FlowNode } from '@/shared/types/flow';
import { findBindings } from './mcpBinding';

// ---------------------------------------------------------------------------
// FlowSpec — the DSL the generator model emits
// ---------------------------------------------------------------------------

/** An MCP server a process step may call tools on. */
export interface FlowSpecServerRef {
  /** MCP server name as configured in FLUJO. */
  name: string;
  /** Tool names to enable. Omitted → all tools known for the server (or none if unknown). */
  tools?: string[];
}

export interface FlowSpecNode {
  /** Spec-local handle other nodes' edges refer to. Must be unique. */
  key: string;
  /** 'mcp' is deliberately NOT accepted — servers are attached via `servers`. */
  type: 'start' | 'process' | 'finish' | 'subflow';
  label?: string;
  /** Free-text description; lands on FlowNode.data.description (wins verbatim in handoff synthesis). */
  description?: string;
  /** start: the flow's system-level prompt. process: the step prompt. subflow: isolated-mode prompt. */
  prompt?: string;
  /** process only: model id OR displayName/name — resolved against the context. */
  model?: string;
  /** process only: MCP servers this step may use (each becomes an MCP node + mcp edge). */
  servers?: FlowSpecServerRef[];
  /** process/subflow: what the step receives from the conversation. */
  inputMode?: 'full-history' | 'latest-message' | 'isolated';
  /** process only, inputMode 'isolated': the replacement context. */
  isolatedPrompt?: string;
  /** subflow only: target flow name OR id — resolved against the context. */
  flow?: string;
  /** subflow only. */
  outputMode?: 'steps' | 'final-only';
}

export interface FlowSpecEdge {
  /** Source node key. */
  from: string;
  /** Target node key. */
  to: string;
  /** Handoff-back upgrade: traffic also flows to → from. */
  bidirectional?: boolean;
}

export interface FlowSpec {
  name?: string;
  description?: string;
  nodes: FlowSpecNode[];
  edges: FlowSpecEdge[];
}

// ---------------------------------------------------------------------------
// Compile context + result
// ---------------------------------------------------------------------------

export interface CompileContext {
  /** Known models, for resolving FlowSpecNode.model (id, then displayName, then name). */
  models?: Array<{ id: string; name?: string; displayName?: string }>;
  /** Known MCP server names (unknown server → warning; node still emitted). */
  servers?: Array<{ name: string }>;
  /** Tool names per server; used to default enabledTools and warn on unknown tools. */
  serverTools?: Record<string, string[]>;
  /** Existing flows, for resolving subflow targets and de-duplicating the flow name. */
  flows?: Array<{ id: string; name: string }>;
}

export interface CompileIssue {
  severity: 'error' | 'warning';
  /** Stable machine code, e.g. 'subflow-unresolved'. */
  code: string;
  /** Human-readable; also fed back to the generator model for repair. */
  message: string;
  /** The spec node the issue is about, when applicable. */
  nodeKey?: string;
}

export interface CompileResult {
  /** Best-effort flow; null only when no node was usable at all. */
  flow: Flow | null;
  issues: CompileIssue[];
  errorCount: number;
  warningCount: number;
}

// ---------------------------------------------------------------------------
// Layout + edge constants (edge shapes pinned to edgeUtils by tests)
// ---------------------------------------------------------------------------

const BASE_X = 250;
const BASE_Y = 150;
const X_SPACING = 280;
const Y_SPACING = 170;
/** MCP nodes sit to the right of their process node. */
const MCP_X_OFFSET = 320;
const MCP_Y_SPACING = 150;

/** Mirror of Canvas/types.ts `mcpEdgeOptions` (markers/style); 'arrowclosed' === MarkerType.ArrowClosed. */
const MCP_EDGE_MARKER = { type: 'arrowclosed' as const, width: 20, height: 20, color: '#1976d2' };
const MCP_EDGE_STYLE = { stroke: '#1976d2', strokeWidth: 2 };

const VALID_INPUT_MODES = new Set(['full-history', 'latest-message', 'isolated']);
const VALID_OUTPUT_MODES = new Set(['steps', 'final-only']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flow names must satisfy the builder's `validateFlowName` (`^[\w-]+$`). */
export function sanitizeFlowName(raw: string | undefined, existingNames: string[]): string {
  let name = (raw ?? '').trim().replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!name) name = 'generated_flow';
  const taken = new Set(existingNames.map((n) => n.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) {
    const candidate = `${name}_${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * v1 generated prompts carry no binding pills — tools reach the model via MCP edges +
 * enabledTools, and pills are a whole codec/validation error class we skip. Any pill the
 * model emitted anyway is replaced by its plain tool/uri name.
 */
function stripPills(text: string): { text: string; stripped: boolean } {
  const bindings = findBindings(text);
  if (bindings.length === 0) return { text, stripped: false };
  let out = '';
  let cursor = 0;
  for (const b of bindings) {
    out += text.slice(cursor, b.index) + b.name;
    cursor = b.index + b.fullMatch.length;
  }
  out += text.slice(cursor);
  return { text: out, stripped: true };
}

function defaultLabel(type: string): string {
  return `${type.charAt(0).toUpperCase()}${type.slice(1)} Node`;
}

/** Resolve a model reference: exact id, then case-insensitive displayName, then name. */
function resolveModel(
  ref: string,
  models: NonNullable<CompileContext['models']>
): string | null {
  if (models.some((m) => m.id === ref)) return ref;
  const lower = ref.toLowerCase();
  const byDisplay = models.find((m) => m.displayName?.toLowerCase() === lower);
  if (byDisplay) return byDisplay.id;
  const byName = models.find((m) => m.name?.toLowerCase() === lower);
  return byName ? byName.id : null;
}

/** Resolve a subflow reference: exact id, then case-insensitive name. */
function resolveFlowRef(
  ref: string,
  flows: NonNullable<CompileContext['flows']>
): string | null {
  if (flows.some((f) => f.id === ref)) return ref;
  const lower = ref.toLowerCase();
  const byName = flows.find((f) => f.name.toLowerCase() === lower);
  return byName ? byName.id : null;
}

/** A standard flow-control edge, shaped exactly like `createEdgeFromConnection`'s non-MCP branch. */
function controlEdge(source: FlowNode, target: FlowNode, bidirectional?: boolean): Edge {
  const sourceHandle = `${source.type}-bottom`;
  const targetHandle = `${target.type}-top`;
  return {
    id: `${source.id}:${sourceHandle}->${target.id}:${targetHandle}`,
    source: source.id,
    sourceHandle,
    target: target.id,
    targetHandle,
    type: 'custom',
    data: { edgeType: 'standard', ...(bidirectional ? { bidirectional: true } : {}) },
    animated: true,
  } as Edge;
}

/** An MCP tool-wiring edge, shaped exactly like `createEdgeFromConnection`'s MCP branch. */
function mcpEdge(processNode: FlowNode, mcpNode: FlowNode): Edge {
  const sourceHandle = 'process-right-mcp';
  const targetHandle = 'mcp-left';
  return {
    id: `${processNode.id}:${sourceHandle}->${mcpNode.id}:${targetHandle}`,
    source: processNode.id,
    sourceHandle,
    target: mcpNode.id,
    targetHandle,
    type: 'mcpEdge',
    data: { edgeType: 'mcp' },
    animated: false,
    markerEnd: { ...MCP_EDGE_MARKER },
    markerStart: { ...MCP_EDGE_MARKER },
    style: { ...MCP_EDGE_STYLE },
  } as Edge;
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

export function compileFlowSpec(spec: FlowSpec, context: CompileContext = {}): CompileResult {
  const issues: CompileIssue[] = [];
  const error = (code: string, message: string, nodeKey?: string) =>
    issues.push({ severity: 'error', code, message, nodeKey });
  const warn = (code: string, message: string, nodeKey?: string) =>
    issues.push({ severity: 'warning', code, message, nodeKey });

  const models = context.models ?? [];
  const knownServers = new Set((context.servers ?? []).map((s) => s.name));
  const serverTools = context.serverTools ?? {};
  const flows = context.flows ?? [];

  const specNodes = Array.isArray(spec?.nodes) ? spec.nodes : [];
  const specEdges = Array.isArray(spec?.edges) ? spec.edges : [];

  // --- Pass 1: nodes ---------------------------------------------------------
  const nodesByKey = new Map<string, FlowNode>();
  const flowNodes: FlowNode[] = [];
  // MCP nodes are created per (process, server) pair so each step keeps its own
  // enabledTools subset; collected separately for placement next to their process node.
  const mcpAttachments: Array<{ processKey: string; mcpNode: FlowNode }> = [];

  for (const specNode of specNodes) {
    const key = specNode?.key;
    if (!key || typeof key !== 'string') {
      error('node-missing-key', 'A node is missing its "key" — every node needs a unique key.');
      continue;
    }
    if (nodesByKey.has(key)) {
      error('node-duplicate-key', `Duplicate node key "${key}" — keys must be unique; the later node was dropped.`, key);
      continue;
    }
    const type = specNode.type;
    if (type === ('mcp' as string)) {
      error(
        'mcp-node-not-allowed',
        `Node "${key}": do not emit "mcp" nodes — attach servers to a process node via its "servers" list instead.`,
        key
      );
      continue;
    }
    if (type !== 'start' && type !== 'process' && type !== 'finish' && type !== 'subflow') {
      error('unknown-node-type', `Node "${key}" has unknown type "${String(type)}".`, key);
      continue;
    }

    const properties: Record<string, any> = {};
    const prompt = typeof specNode.prompt === 'string' ? specNode.prompt : undefined;

    if (type === 'start') {
      const { text, stripped } = stripPills(prompt ?? '');
      if (stripped) warn('pill-stripped', `Node "${key}": binding pills are not supported in generated prompts and were replaced with plain names.`, key);
      properties.promptTemplate = text;
    } else if (type === 'process') {
      const { text, stripped } = stripPills(prompt ?? '');
      if (stripped) warn('pill-stripped', `Node "${key}": binding pills are not supported in generated prompts and were replaced with plain names.`, key);
      properties.promptTemplate = text;

      if (specNode.model) {
        const resolved = resolveModel(specNode.model, models);
        if (resolved) {
          properties.boundModel = resolved;
        } else {
          // Keep the raw reference so the intent stays visible in the builder;
          // validateFlow raises the blocking 'process-model-missing' error.
          properties.boundModel = specNode.model;
          warn('model-unresolved', `Node "${key}": model "${specNode.model}" does not match any configured model (by id, display name, or name).`, key);
        }
      }

      if (specNode.inputMode !== undefined) {
        if (VALID_INPUT_MODES.has(specNode.inputMode)) {
          properties.inputMode = specNode.inputMode;
          if (specNode.inputMode === 'isolated' && typeof specNode.isolatedPrompt === 'string') {
            properties.isolatedPrompt = specNode.isolatedPrompt;
          }
        } else {
          warn('invalid-input-mode', `Node "${key}": inputMode "${String(specNode.inputMode)}" is not valid (full-history | latest-message | isolated); omitted.`, key);
        }
      }
    } else if (type === 'subflow') {
      if (specNode.flow) {
        const resolved = resolveFlowRef(specNode.flow, flows);
        if (resolved) {
          properties.subflowId = resolved;
        } else {
          error('subflow-unresolved', `Node "${key}": flow "${specNode.flow}" does not match any existing flow (by id or name).`, key);
        }
      } else {
        error('subflow-missing-flow', `Node "${key}": subflow nodes need a "flow" (name or id of an existing flow).`, key);
      }
      if (specNode.inputMode !== undefined) {
        if (VALID_INPUT_MODES.has(specNode.inputMode)) {
          properties.inputMode = specNode.inputMode;
        } else {
          warn('invalid-input-mode', `Node "${key}": inputMode "${String(specNode.inputMode)}" is not valid (full-history | latest-message | isolated); omitted.`, key);
        }
      }
      if (specNode.outputMode !== undefined) {
        if (VALID_OUTPUT_MODES.has(specNode.outputMode)) {
          properties.outputMode = specNode.outputMode;
        } else {
          warn('invalid-output-mode', `Node "${key}": outputMode "${String(specNode.outputMode)}" is not valid (steps | final-only); omitted.`, key);
        }
      }
      // A prompt on a subflow is its isolated-mode input (runtime back-compat treats a
      // promptTemplate with no inputMode as isolated).
      if (prompt !== undefined) {
        const { text, stripped } = stripPills(prompt);
        if (stripped) warn('pill-stripped', `Node "${key}": binding pills are not supported in generated prompts and were replaced with plain names.`, key);
        properties.promptTemplate = text;
      }
    }
    // finish: no properties.

    const node: FlowNode = {
      id: uuidv4(),
      type,
      position: { x: 0, y: 0 }, // layout pass below
      data: {
        label: specNode.label || defaultLabel(type),
        type,
        ...(specNode.description ? { description: specNode.description } : {}),
        properties,
      },
    };
    nodesByKey.set(key, node);
    flowNodes.push(node);

    // --- MCP attachments (process only) ---
    if (type === 'process' && Array.isArray(specNode.servers)) {
      const seenServers = new Set<string>();
      for (const ref of specNode.servers) {
        const serverName = ref?.name;
        if (!serverName || typeof serverName !== 'string') {
          warn('server-missing-name', `Node "${key}": a server reference is missing its "name"; skipped.`, key);
          continue;
        }
        if (seenServers.has(serverName)) continue;
        seenServers.add(serverName);
        if (!knownServers.has(serverName)) {
          warn('server-unknown', `Node "${key}": MCP server "${serverName}" is not configured in FLUJO.`, key);
        }
        const known = serverTools[serverName];
        let enabledTools: string[];
        if (Array.isArray(ref.tools)) {
          enabledTools = ref.tools.filter((t) => typeof t === 'string' && t);
          if (known) {
            const unknown = enabledTools.filter((t) => !known.includes(t));
            if (unknown.length > 0) {
              warn('tool-unknown', `Node "${key}": server "${serverName}" does not report tool(s): ${unknown.join(', ')}.`, key);
            }
          }
        } else {
          // Tools omitted → enable everything we know about (empty if the server is
          // unknown/offline — the builder is where the user refines this).
          enabledTools = known ? [...known] : [];
        }
        const mcpNode: FlowNode = {
          id: uuidv4(),
          type: 'mcp',
          position: { x: 0, y: 0 },
          data: {
            label: serverName,
            type: 'mcp',
            properties: { boundServer: serverName, enabledTools },
          },
        };
        flowNodes.push(mcpNode);
        mcpAttachments.push({ processKey: key, mcpNode });
      }
    } else if (type !== 'process' && Array.isArray(specNode.servers) && specNode.servers.length > 0) {
      warn('servers-on-non-process', `Node "${key}": only process nodes can have "servers"; ignored.`, key);
    }
  }

  if (nodesByKey.size === 0) {
    error('no-usable-nodes', 'No usable nodes — the spec must contain at least a start node and one step.');
    return finalize(null, issues);
  }

  // --- Pass 2: edges ---------------------------------------------------------
  const edges: Edge[] = [];
  const seenControlPairs = new Set<string>();
  for (const specEdge of specEdges) {
    const fromKey = specEdge?.from;
    const toKey = specEdge?.to;
    const source = fromKey ? nodesByKey.get(fromKey) : undefined;
    const target = toKey ? nodesByKey.get(toKey) : undefined;
    if (!source || !target) {
      error('edge-unknown-node', `Edge "${String(fromKey)}" -> "${String(toKey)}" references a node key that does not exist (or was dropped).`);
      continue;
    }
    if (source === target) {
      error('edge-self-loop', `Edge "${fromKey}" -> "${toKey}": a node cannot connect to itself.`);
      continue;
    }
    // Same legality rules as the builder's getConnectionError for flow control.
    if (target.type === 'start') {
      error('edge-into-start', `Edge "${fromKey}" -> "${toKey}": nothing may connect INTO a start node.`);
      continue;
    }
    if (source.type === 'finish') {
      error('edge-out-of-finish', `Edge "${fromKey}" -> "${toKey}": nothing may connect OUT OF a finish node.`);
      continue;
    }
    const pair = `${fromKey}->${toKey}`;
    if (seenControlPairs.has(pair)) {
      warn('edge-duplicate', `Edge "${fromKey}" -> "${toKey}" appears more than once; kept the first.`);
      continue;
    }
    seenControlPairs.add(pair);
    let bidirectional = specEdge.bidirectional === true;
    if (bidirectional && (source.type === 'start' || target.type === 'finish')) {
      // The reverse direction would be illegal (into start / out of finish).
      warn('bidirectional-illegal', `Edge "${fromKey}" -> "${toKey}" cannot be bidirectional; downgraded to one-way.`);
      bidirectional = false;
    }
    edges.push(controlEdge(source, target, bidirectional));
  }

  // MCP edges after control edges (order is cosmetic; grouping aids debugging).
  for (const { processKey, mcpNode } of mcpAttachments) {
    const processNode = nodesByKey.get(processKey)!;
    edges.push(mcpEdge(processNode, mcpNode));
  }

  // --- Pass 3: layout --------------------------------------------------------
  layout(flowNodes, nodesByKey, edges, mcpAttachments);

  const existingNames = flows.map((f) => f.name);
  const flow: Flow = {
    id: uuidv4(),
    name: sanitizeFlowName(spec?.name, existingNames),
    ...(spec?.description ? { description: spec.description } : {}),
    nodes: flowNodes,
    edges,
  };
  return finalize(flow, issues);
}

/** Layered top-down layout: BFS depth over flow-control edges; MCP nodes beside their process. */
function layout(
  flowNodes: FlowNode[],
  nodesByKey: Map<string, FlowNode>,
  edges: Edge[],
  mcpAttachments: Array<{ processKey: string; mcpNode: FlowNode }>
): void {
  const controlAdj = new Map<string, string[]>();
  for (const e of edges) {
    if ((e.data as { edgeType?: string } | undefined)?.edgeType === 'mcp') continue;
    if (!controlAdj.has(e.source)) controlAdj.set(e.source, []);
    controlAdj.get(e.source)!.push(e.target);
  }

  const specNodes = [...nodesByKey.values()];
  const roots = specNodes.filter((n) => n.type === 'start');
  const bfsRoots = roots.length > 0 ? roots : specNodes.slice(0, 1);
  const depths = new Map<string, number>();
  const queue: Array<{ id: string; depth: number }> = bfsRoots.map((n) => ({ id: n.id, depth: 0 }));
  for (const q of queue) depths.set(q.id, 0);
  while (queue.length) {
    const { id, depth } = queue.shift()!;
    for (const next of controlAdj.get(id) ?? []) {
      if (!depths.has(next)) {
        depths.set(next, depth + 1);
        queue.push({ id: next, depth: depth + 1 });
      }
    }
  }
  // Unreachable spec nodes go below everything placed so far.
  let maxDepth = 0;
  for (const d of depths.values()) maxDepth = Math.max(maxDepth, d);
  for (const n of specNodes) {
    if (!depths.has(n.id)) depths.set(n.id, maxDepth + 1);
  }

  const columnCounters = new Map<number, number>();
  for (const n of specNodes) {
    const depth = depths.get(n.id)!;
    const col = columnCounters.get(depth) ?? 0;
    columnCounters.set(depth, col + 1);
    n.position = { x: BASE_X + col * X_SPACING, y: BASE_Y + depth * Y_SPACING };
  }

  // MCP nodes: to the right of their process node, stacked.
  const mcpCounters = new Map<string, number>();
  for (const { processKey, mcpNode } of mcpAttachments) {
    const processNode = nodesByKey.get(processKey)!;
    const idx = mcpCounters.get(processKey) ?? 0;
    mcpCounters.set(processKey, idx + 1);
    mcpNode.position = {
      x: processNode.position.x + MCP_X_OFFSET,
      y: processNode.position.y + idx * MCP_Y_SPACING,
    };
  }
}

function finalize(flow: Flow | null, issues: CompileIssue[]): CompileResult {
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  return { flow, issues, errorCount, warningCount: issues.length - errorCount };
}
