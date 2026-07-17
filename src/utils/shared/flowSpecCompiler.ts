/**
 * FlowSpec → Flow compiler (issue #14, flow generation; issue #94, multi-level nesting).
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
 * MULTI-LEVEL (issue #94): a subflow node can reference an existing flow (`flow`) OR carry
 * an inline child {@link FlowSpec} (`subflowSpec`). Inline children are compiled into their
 * OWN flows and the parent subflow node's `subflowId` is wired to the compiled child's id.
 * The compiler therefore returns a BUNDLE of flows ({@link CompileResult.flows}) in
 * dependency order (descendants before the root) so the caller can persist them
 * descendants-first, keeping every `subflowId` resolvable. `CompileResult.flow` remains the
 * ROOT flow for back-compatibility with the single-flow callers. Recursion is bounded by a
 * hard depth cap and a total-flow cap. A third field, `generateSubflow`, is a
 * generator-only instruction (a natural-language description of a child to auto-generate);
 * the deterministic compiler cannot fulfil it and flags it — the LLM generator expands it
 * into a `subflowSpec` before compiling.
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
import { EdgeCondition, isValidConditionKind, isRegexCompilable } from './edgeConditions';

// ---------------------------------------------------------------------------
// Recursion bounds (issue #94) — token/latency + loop guards
// ---------------------------------------------------------------------------

/** Hard maximum subflow nesting depth (root is depth 0). Never exceeded, whatever the caller asks. */
export const MAX_SUBFLOW_DEPTH = 3;
/** Hard maximum number of flows a single compile/generate may produce (root + descendants). */
export const MAX_GENERATED_FLOWS = 8;
/** Sanity ceiling for a process node's `maxTurns` override (no hard runtime cap exists). */
export const MAX_PROCESS_MAX_TURNS = 1000;

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

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
  /** 'mcp' is deliberately NOT accepted — servers are attached via `servers`.
   *  'resource' (Tier 3) is a data artifact: an edge resource→process means the
   *  step READS it; process→resource means the step's output is SAVED to it
   *  (run artifacts only). */
  type: 'start' | 'process' | 'finish' | 'subflow' | 'resource' | 'signal';
  label?: string;
  /** Free-text description; lands on FlowNode.data.description (wins verbatim in handoff synthesis). */
  description?: string;
  /** start: the flow's system-level prompt. process: the step prompt. subflow: isolated-mode prompt. */
  prompt?: string;
  /** process only: model id OR displayName/name — resolved against the context. */
  model?: string;
  /** process only: MCP servers this step may use (each becomes an MCP node + mcp edge). */
  servers?: FlowSpecServerRef[];
  /**
   * process only: per-node cap on agentic turns (self-orchestrating tool loop). Clamped to
   * [1, {@link MAX_PROCESS_MAX_TURNS}]. Unset ⇒ inherit the model's setting, then the system
   * default (50). Exposing it is the pragmatic "retry until it passes" loop: one process node
   * + a tool + a bounded maxTurns loops internally without a multi-node loop construct.
   */
  maxTurns?: number;
  /** process only: drop the bound model's base/system prompt from the rendered prompt. */
  excludeModelPrompt?: boolean;
  /** process only: drop the start node's prompt from this step's rendered prompt. */
  excludeStartNodePrompt?: boolean;
  /** process only: suppress the hardcoded workflow/handoff guidance block. */
  excludeSystemPrompt?: boolean;
  /**
   * process only: a step-level tool allowlist, independent of the per-MCP-node
   * `servers[].tools` (enabledTools). Only these tool names are offered to the model.
   */
  allowedTools?: string[];
  /** process/subflow: what the step receives from the conversation. */
  inputMode?: 'full-history' | 'latest-message' | 'isolated';
  /** process only, inputMode 'isolated': the replacement context. */
  isolatedPrompt?: string;
  /** resource only: the MCP server publishing a STATIC resource (with `uri`). */
  server?: string;
  /** resource only: the static resource's URI (or uriTemplate) on `server`. */
  uri?: string;
  /** resource only: name of a RUN artifact (mutually exclusive with server/uri) —
   *  produced by a step via a process→resource edge, injectable via \${res:NAME}. */
  runName?: string;
  /** signal only (issue #117): the event topic emitted when the node is traversed.
   *  A flow-event trigger with a matching topic source fires in response. */
  topic?: string;
  /** signal only (issue #117): the payload template emitted with the signal;
   *  \${var:NAME} is resolved from run variables at emit time. */
  payloadTemplate?: string;
  /** subflow only: target flow name OR id of an EXISTING flow — resolved against the context. */
  flow?: string;
  /**
   * subflow only (issue #102): fan out to SEVERAL existing child flows CONCURRENTLY (by
   * name or id). The same resolved input (per `inputMode`) is fanned to every lane and the
   * outputs are joined. Mutually exclusive with the single-child sources; precedence is
   * flow > subflowSpec > parallelFlows > parallelSubflowSpecs > generateSubflow. This is
   * about multiple CHILDREN, not multiple successors — a subflow node still has ONE
   * outgoing edge.
   */
  parallelFlows?: string[];
  /**
   * subflow only (issue #102): fan out to several INLINE child FlowSpecs concurrently. Each
   * is compiled into its own flow (honouring the depth/flow caps, like `subflowSpec`) and
   * its id is added to the lane list. Prefer `parallelFlows` for large fan-outs to avoid the
   * MAX_GENERATED_FLOWS / MAX_SUBFLOW_DEPTH caps.
   */
  parallelSubflowSpecs?: FlowSpec[];
  /**
   * subflow only (issue #130): DYNAMIC fan-out. The NAME of a run-scoped variable
   * (captured upstream via `captureVariable`, referenced elsewhere as ${var:NAME})
   * whose value — a JSON array of flow ids/names, or a newline list — selects the
   * fan-out target flows AT RUNTIME. Lets a running step decide WHICH (and how
   * many) flows fan out. May stand ALONE as the sole target source, or decorate a
   * static `parallelFlows` base that it overrides when it resolves non-empty.
   * Mutually exclusive with `mapOverList`. Compiles to `properties.parallelSubflowIdsVar`.
   */
  parallelFlowsVariable?: string;
  /** subflow parallel: max lanes run at once (bounded pool). Clamped ≥1. Default runtime 4. */
  concurrencyLimit?: number;
  /** subflow parallel: string placed between joined lane outputs (child order). Default "\n\n". */
  joinSeparator?: string;
  /** subflow parallel: 'collect-all' (default; every lane runs, partials surfaced) | 'fail-fast'. */
  errorStrategy?: 'fail-fast' | 'collect-all';
  /**
   * subflow only (Tier 2a): run the SINGLE child flow (`flow` / `subflowSpec`) ONCE PER ITEM
   * parsed from the resolved input, instead of once. Mutually exclusive with the parallel
   * fan-out sources (`parallelFlows`/`parallelSubflowSpecs`). The per-item runs reuse the same
   * bounded pool and joining, so `concurrencyLimit`/`joinSeparator`/`errorStrategy` apply.
   */
  mapOverList?: boolean;
  /** subflow map-over-list: how to split the input into items — 'json-array' (default; parse a
   *  JSON array, each element one item) or 'lines' (split on newlines, blank lines dropped). */
  itemSplit?: 'json-array' | 'lines';
  /** subflow map-over-list: run items one at a time in order (pool size 1) instead of
   *  concurrently. Default false. */
  sequential?: boolean;
  /**
   * subflow only (issue #94): an INLINE child FlowSpec. The compiler compiles it into its
   * own flow and wires this node's subflowId to it. Mutually exclusive with `flow`
   * (precedence: flow > subflowSpec > generateSubflow).
   */
  subflowSpec?: FlowSpec;
  /**
   * subflow only (issue #94): a natural-language description of a child flow to
   * AUTO-GENERATE. Generator-only — the deterministic compiler cannot fulfil it and flags
   * it; the LLM generator expands it into a `subflowSpec` before compiling.
   */
  generateSubflow?: string;
  /** subflow: chat visibility of the child run ('steps' | 'final-only').
   *  process: what LATER steps see of this step's work ('full-conversation' |
   *  'latest-message' — the latter hides its tool calls/results from later
   *  model calls, keeping only its final response). */
  outputMode?: 'steps' | 'final-only' | 'full-conversation' | 'latest-message';
  /** subflow only, inputMode 'isolated' (issue #96): when true, a step that hands
   *  off to this subflow may pass a `prompt` argument that overrides `prompt`
   *  (the authored default). Defaults to false. */
  allowCallerPrompt?: boolean;
  /**
   * process/subflow only (Tier 2c — named variables): save this step's final
   * output into a run-scoped variable of this name. Any LATER step can inject it
   * with `${var:NAME}` in its prompt / isolatedPrompt / subflow input, surviving
   * `latest-message`/`isolated` scoping that would otherwise drop it from history.
   * Run-scoped plaintext — NOT config or secrets (distinct from `${global:VAR}`).
   */
  captureVariable?: string;
  /**
   * process/subflow only (Tier 3 — resource-tracked data flow): ALSO save this
   * step's final output as a named run-scoped RESOURCE (flujo://run/… with
   * producedBy/readBy lineage, readable via the internal "flujo" MCP server).
   * Later steps inject it with `${res:NAME}`. Use `captureVariable` for short
   * strings; `captureResource` for big/structured artifacts worth tracking.
   */
  captureResource?: string;
  /**
   * process/subflow only (Tier 4 — persistent kv): ALSO save this step's final
   * output into a PERSISTENT key-value entry that SURVIVES ACROSS RUNS, injected
   * elsewhere with `${kv:NAME}`. Unlike `captureVariable`/`captureResource`
   * (run-scoped), a scheduled flow uses this to carry a loop counter / cursor /
   * flag forward to its next pulse. Defaults to the flow's FOLDER board; prefix
   * the name with `flow/` or `global/` to target another board. Plaintext, never
   * secrets (distinct from `${global:VAR}`).
   */
  captureKv?: string;
}

export interface FlowSpecEdge {
  /** Source node key. */
  from: string;
  /** Target node key. */
  to: string;
  /** Handoff-back upgrade: traffic also flows to → from. */
  bidirectional?: boolean;
  /** Tier 2b: a deterministic predicate over the last message. When set, the
   *  engine takes this edge if the predicate matches (first matching outgoing
   *  edge wins, in author order); a bare edge is the fallback. Only meaningful
   *  on edges leaving a process node. */
  condition?: EdgeCondition;
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

/** Bounds for nested (subflowSpec) compilation. Clamped to the hard caps above. */
export interface CompileOptions {
  /** Max nesting depth (root is 0). Clamped to [0, MAX_SUBFLOW_DEPTH]. */
  maxDepth?: number;
  /** Max total flows in the bundle. Clamped to [1, MAX_GENERATED_FLOWS]. */
  maxFlows?: number;
  /**
   * Layout override for the ROOT level (issue #99, AI-Improve): a map from a spec node's
   * `key` to the canvas position it should keep. Any root node whose key is present is
   * placed there verbatim instead of being auto-laid-out; nodes without an entry (e.g. new
   * ones the model added) still get the layered layout, and MCP nodes follow their process
   * node's final position. This lets an "improve this flow" round-trip keep unchanged nodes
   * exactly where the user left them. Applied at depth 0 only.
   */
  positions?: Record<string, { x: number; y: number }>;
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
  /** Best-effort ROOT flow; null only when the root spec had no usable node at all. */
  flow: Flow | null;
  /**
   * The full bundle — root plus every inline-subflow descendant — in DEPENDENCY ORDER
   * (descendants before the root) so callers can persist them descendants-first and keep
   * each subflowId resolvable. For a non-nested spec this is `[flow]`. Empty when
   * `flow` is null.
   */
  flows: Flow[];
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

/** Mirror of Canvas/types.ts `resourceEdgeOptions` (Tier 3) — directional, teal. */
const RESOURCE_EDGE_MARKER = { type: 'arrowclosed' as const, width: 20, height: 20, color: '#009688' };
const RESOURCE_EDGE_STYLE = { stroke: '#009688', strokeWidth: 2 };

const VALID_INPUT_MODES = new Set(['full-history', 'latest-message', 'isolated']);
const VALID_OUTPUT_MODES = new Set(['steps', 'final-only']);
const VALID_PROCESS_OUTPUT_MODES = new Set(['full-conversation', 'latest-message']);

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
  flows: Array<{ id: string; name: string }>
): string | null {
  if (flows.some((f) => f.id === ref)) return ref;
  const lower = ref.toLowerCase();
  const byName = flows.find((f) => f.name.toLowerCase() === lower);
  return byName ? byName.id : null;
}

/** A standard flow-control edge, shaped exactly like `createEdgeFromConnection`'s non-MCP branch.
 * Exported so the auto-repair module (flowAutoRepair.ts) builds injected edges through the
 * SAME factory — edge ids/handles stay pinned to the builder's originals, no third copy.
 * A `condition` (Tier 2b) is spread into `data` only when set, so a plain edge stays
 * byte-for-byte identical to the builder's output (the flowSpecCompiler.test.ts pin). */
export function controlEdge(
  source: FlowNode,
  target: FlowNode,
  bidirectional?: boolean,
  condition?: EdgeCondition
): Edge {
  const sourceHandle = `${source.type}-bottom`;
  const targetHandle = `${target.type}-top`;
  return {
    id: `${source.id}:${sourceHandle}->${target.id}:${targetHandle}`,
    source: source.id,
    sourceHandle,
    target: target.id,
    targetHandle,
    type: 'custom',
    data: {
      edgeType: 'standard',
      ...(bidirectional ? { bidirectional: true } : {}),
      ...(condition ? { condition } : {}),
    },
    animated: true,
  } as Edge;
}

/** A resource data-wiring edge (Tier 3), shaped exactly like
 * `createEdgeFromConnection`'s resource branch. Direction is preserved from
 * the spec: resource→process = the step consumes; process→resource = the step
 * produces. Handles follow the side each endpoint plays. */
function resourceEdge(source: FlowNode, target: FlowNode): Edge {
  const sourceHandle = source.type === 'resource' ? 'resource-out' : 'process-right-resource';
  const targetHandle = target.type === 'resource' ? 'resource-in' : 'process-left-resource';
  return {
    id: `${source.id}:${sourceHandle}->${target.id}:${targetHandle}`,
    source: source.id,
    sourceHandle,
    target: target.id,
    targetHandle,
    type: 'resourceEdge',
    data: { edgeType: 'resource' },
    animated: false,
    markerEnd: { ...RESOURCE_EDGE_MARKER },
    style: { ...RESOURCE_EDGE_STYLE },
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

/**
 * Compile a {@link FlowSpec} into a Flow (or a BUNDLE of flows, when it nests inline
 * subflows via `subflowSpec`). See {@link CompileResult} for the return shape.
 */
export function compileFlowSpec(
  spec: FlowSpec,
  context: CompileContext = {},
  options: CompileOptions = {}
): CompileResult {
  const issues: CompileIssue[] = [];
  const error = (code: string, message: string, nodeKey?: string) =>
    issues.push({ severity: 'error', code, message, nodeKey });
  const warn = (code: string, message: string, nodeKey?: string) =>
    issues.push({ severity: 'warning', code, message, nodeKey });

  const models = context.models ?? [];
  const knownServers = new Set((context.servers ?? []).map((s) => s.name));
  const serverTools = context.serverTools ?? {};

  const maxDepth = clamp(options.maxDepth, 0, MAX_SUBFLOW_DEPTH, MAX_SUBFLOW_DEPTH);
  const maxFlows = clamp(options.maxFlows, 1, MAX_GENERATED_FLOWS, MAX_GENERATED_FLOWS);

  // Bundle state, shared across recursion levels:
  //  - `bundle` collects compiled flows in dependency order (children pushed before parents).
  //  - `takenNames` grows so sibling/child flow names never collide with each other or existing flows.
  //  - `bundleRefs` are the flows already compiled in THIS bundle, resolvable by a later
  //    subflow `flow` reference (a sibling can reference an earlier sibling). Ancestors are
  //    NOT added until their own level finishes, so a descendant can never resolve an
  //    ancestor by name — that structurally prevents reference cycles.
  const bundle: Flow[] = [];
  const takenNames = [...(context.flows ?? []).map((f) => f.name)];
  const bundleRefs: Array<{ id: string; name: string }> = [];
  // Counts every flow whose id has been reserved this bundle (root included, and counted
  // even if a level turns out to have no usable node) so the total-flow cap is honoured
  // exactly regardless of the children-before-parent push order.
  let flowCount = 0;

  const rootFlow = compileLevel(spec, 0, []);
  return finalize(rootFlow, bundle, issues);

  // -------------------------------------------------------------------------
  // Per-level compile (recurses for inline subflowSpec children)
  // -------------------------------------------------------------------------
  function compileLevel(levelSpec: FlowSpec, depth: number, ancestorNames: string[]): Flow | null {
    const specNodes = Array.isArray(levelSpec?.nodes) ? levelSpec.nodes : [];
    const specEdges = Array.isArray(levelSpec?.edges) ? levelSpec.edges : [];

    // Reserve the name up-front so nested children dedupe against it and cycle
    // detection can compare a subflow `flow` reference against ancestor names.
    const flowName = sanitizeFlowName(levelSpec?.name, takenNames);
    takenNames.push(flowName);
    flowCount++;
    const flowId = uuidv4();
    const childAncestors = [...ancestorNames, flowName];

    // --- Pass 1: nodes -------------------------------------------------------
    const nodesByKey = new Map<string, FlowNode>();
    const flowNodes: FlowNode[] = [];
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
      if (type !== 'start' && type !== 'process' && type !== 'finish' && type !== 'subflow' && type !== 'resource' && type !== 'signal') {
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

        if (specNode.outputMode !== undefined) {
          if (VALID_PROCESS_OUTPUT_MODES.has(specNode.outputMode)) {
            properties.outputMode = specNode.outputMode;
          } else {
            warn('invalid-output-mode', `Node "${key}": outputMode "${String(specNode.outputMode)}" is not valid on a process node (full-conversation | latest-message); omitted.`, key);
          }
        }

        // maxTurns (1b): per-node agentic-turn cap. Clamp to a sane range; absent ⇒ inherit.
        if (specNode.maxTurns !== undefined) {
          if (typeof specNode.maxTurns === 'number' && !Number.isNaN(specNode.maxTurns)) {
            properties.maxTurns = clamp(specNode.maxTurns, 1, MAX_PROCESS_MAX_TURNS, 1);
          } else {
            warn('invalid-max-turns', `Node "${key}": maxTurns "${String(specNode.maxTurns)}" is not a number; omitted.`, key);
          }
        }

        // Prompt-composition flags (1c): copy through only when boolean.
        if (typeof specNode.excludeModelPrompt === 'boolean') properties.excludeModelPrompt = specNode.excludeModelPrompt;
        if (typeof specNode.excludeStartNodePrompt === 'boolean') properties.excludeStartNodePrompt = specNode.excludeStartNodePrompt;
        if (typeof specNode.excludeSystemPrompt === 'boolean') properties.excludeSystemPrompt = specNode.excludeSystemPrompt;

        // allowedTools (1d): step-level tool allowlist (strings only).
        if (Array.isArray(specNode.allowedTools)) {
          properties.allowedTools = specNode.allowedTools.filter((t) => typeof t === 'string' && t);
        }

        // captureVariable (Tier 2c): save this step's output into a named run var.
        if (typeof specNode.captureVariable === 'string' && specNode.captureVariable.trim()) {
          properties.captureVariable = specNode.captureVariable.trim();
        }
        // captureResource (Tier 3): save this step's output as a named run resource.
        if (typeof specNode.captureResource === 'string' && specNode.captureResource.trim()) {
          properties.captureResource = specNode.captureResource.trim();
        }
        // captureKv (Tier 4): also persist this step's output to a cross-run kv key.
        if (typeof specNode.captureKv === 'string' && specNode.captureKv.trim()) {
          properties.captureKv = specNode.captureKv.trim();
        }
      } else if (type === 'subflow') {
        resolveSubflowTarget(specNode, key, depth, childAncestors, properties);
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
        // Opt-in caller prompt (issue #96): only meaningful in isolated mode.
        if (typeof specNode.allowCallerPrompt === 'boolean') {
          properties.allowCallerPrompt = specNode.allowCallerPrompt;
        }
        // captureVariable (Tier 2c): save the subflow's folded output into a named run var.
        if (typeof specNode.captureVariable === 'string' && specNode.captureVariable.trim()) {
          properties.captureVariable = specNode.captureVariable.trim();
        }
        // captureResource (Tier 3): save the folded output as a named run resource.
        if (typeof specNode.captureResource === 'string' && specNode.captureResource.trim()) {
          properties.captureResource = specNode.captureResource.trim();
        }
        // captureKv (Tier 4): also persist the folded output to a cross-run kv key.
        if (typeof specNode.captureKv === 'string' && specNode.captureKv.trim()) {
          properties.captureKv = specNode.captureKv.trim();
        }
      } else if (type === 'resource') {
        // Tier 3: a data artifact. Run artifact (runName) OR static MCP
        // resource (server + uri) — runName wins when both are present.
        const runName = typeof specNode.runName === 'string' ? specNode.runName.trim() : '';
        const server = typeof specNode.server === 'string' ? specNode.server.trim() : '';
        const uri = typeof specNode.uri === 'string' ? specNode.uri.trim() : '';
        if (runName) {
          properties.scope = 'run';
          properties.runName = runName;
          if (server || uri) {
            warn('resource-both-bindings', `Node "${key}": a resource node is EITHER a run artifact ("runName") or a static MCP resource ("server"+"uri"); kept the run artifact.`, key);
          }
        } else {
          properties.scope = 'mcp';
          if (server) properties.boundServer = server;
          if (uri) properties.uri = uri;
          if (!server || !uri) {
            warn('resource-missing-binding', `Node "${key}": a static resource node needs both "server" and "uri" (or a "runName" for a run artifact).`, key);
          } else if (!knownServers.has(server)) {
            warn('server-unknown', `Node "${key}": MCP server "${server}" is not configured in FLUJO.`, key);
          }
        }
      } else if (type === 'signal') {
        // Signal node (issue #117): a pass-through that emits {topic, payload}.
        const topic = typeof specNode.topic === 'string' ? specNode.topic.trim() : '';
        if (topic) {
          properties.topic = topic;
        } else {
          warn('signal-missing-topic', `Node "${key}": a signal node needs a "topic" to emit.`, key);
        }
        if (typeof specNode.payloadTemplate === 'string' && specNode.payloadTemplate) {
          properties.payloadTemplate = specNode.payloadTemplate;
        } else if (prompt !== undefined) {
          // Back-compat authoring convenience: `prompt` doubles as the payload.
          properties.payloadTemplate = prompt;
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
      return null;
    }

    // --- Pass 2: edges -------------------------------------------------------
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
      // Tier 3: an edge touching a resource node is DATA wiring, not flow
      // control. Legality mirrors getConnectionError: resource ↔ process only.
      // Direction is meaning (resource→process = consume, process→resource =
      // produce), so it is preserved verbatim; conditions/bidirectional don't
      // apply to data wiring and are dropped with a warning.
      if (source.type === 'resource' || target.type === 'resource') {
        const resourcePair =
          (source.type === 'resource' && target.type === 'process') ||
          (source.type === 'process' && target.type === 'resource');
        if (!resourcePair) {
          error('resource-edge-invalid', `Edge "${fromKey}" -> "${toKey}": resource nodes connect only to process nodes.`);
          continue;
        }
        if (specEdge.condition) {
          warn('resource-edge-condition', `Edge "${fromKey}" -> "${toKey}": conditions do not apply to resource wiring; dropped.`);
        }
        if (specEdge.bidirectional === true) {
          warn('resource-edge-bidirectional', `Edge "${fromKey}" -> "${toKey}": resource wiring is directional (read vs write); "bidirectional" was ignored — add the opposite edge explicitly if the step both reads and writes.`);
        }
        const pairKey = `${fromKey}->${toKey}`;
        if (seenControlPairs.has(pairKey)) {
          warn('edge-duplicate', `Edge "${fromKey}" -> "${toKey}" appears more than once; kept the first.`);
          continue;
        }
        seenControlPairs.add(pairKey);
        edges.push(resourceEdge(source, target));
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

      // Tier 2b: deterministic edge condition. Sanitize here so a bad predicate
      // is dropped (warned) rather than carried into the runtime graph. Only
      // process nodes route deterministically, so a condition on any other
      // source is dropped with a warning (it would be silently ignored anyway).
      let condition: EdgeCondition | undefined;
      const rawCond = specEdge.condition;
      if (rawCond && typeof rawCond === 'object') {
        if (source.type !== 'process') {
          warn(
            'edge-condition-non-process',
            `Edge "${fromKey}" -> "${toKey}" has a condition but leaves a ${source.type} node; conditions only route from process nodes and were dropped.`
          );
        } else if (!isValidConditionKind(rawCond.kind)) {
          warn(
            'edge-condition-kind',
            `Edge "${fromKey}" -> "${toKey}" has an unknown condition kind "${String(rawCond.kind)}"; the condition was dropped.`
          );
        } else if (rawCond.kind === 'always') {
          // Tier 2b (issue #111): explicit always-true fallback predicate. It
          // routes on ANY reply and legitimately carries no "value", so it must
          // NOT be dropped by the value-required check below.
          condition = {
            kind: 'always',
            ...(rawCond.target === 'last-message' ? { target: 'last-message' as const } : {}),
            ...(rawCond.negate === true ? { negate: true } : {}),
          };
        } else if (typeof rawCond.value !== 'string' || rawCond.value.length === 0) {
          warn(
            'edge-condition-value',
            `Edge "${fromKey}" -> "${toKey}" has a condition with no "value"; the condition was dropped.`
          );
        } else {
          if (rawCond.kind === 'regex' && !isRegexCompilable(rawCond.value)) {
            warn(
              'edge-condition-regex',
              `Edge "${fromKey}" -> "${toKey}" has a regex condition that does not compile; it is kept but will never match at runtime.`
            );
          }
          condition = {
            kind: rawCond.kind,
            value: rawCond.value,
            ...(rawCond.target === 'last-message' ? { target: 'last-message' as const } : {}),
            ...(rawCond.ignoreCase === true ? { ignoreCase: true } : {}),
            ...(rawCond.negate === true ? { negate: true } : {}),
          };
        }
      }

      edges.push(controlEdge(source, target, bidirectional, condition));
    }

    // MCP edges after control edges (order is cosmetic; grouping aids debugging).
    for (const { processKey, mcpNode } of mcpAttachments) {
      const processNode = nodesByKey.get(processKey)!;
      edges.push(mcpEdge(processNode, mcpNode));
    }

    // --- Pass 3: layout ------------------------------------------------------
    // Positions are honoured only at the root level (they key off root node ids).
    layout(flowNodes, nodesByKey, edges, mcpAttachments, depth === 0 ? options.positions : undefined);

    const flow: Flow = {
      id: flowId,
      name: flowName,
      ...(levelSpec?.description ? { description: levelSpec.description } : {}),
      nodes: flowNodes,
      edges,
    };
    // Register AFTER children compiled so a descendant can never resolve this flow (cycle
    // guard); a later sibling, compiled after this returns, still can.
    bundle.push(flow);
    bundleRefs.push({ id: flow.id, name: flow.name });
    return flow;
  }

  /**
   * Resolve a subflow node's target, honouring the precedence
   *   flow (single existing) > subflowSpec (single inline child) >
   *   parallelFlows (fan-out to existing) > parallelSubflowSpecs (fan-out to inline) >
   *   generateSubflow (generator-only).
   * Single-child sources set `properties.subflowId`; the parallel sources set
   * `properties.parallelSubflowIds` (issue #102) plus the tuning fields.
   */
  function resolveSubflowTarget(
    specNode: FlowSpecNode,
    key: string,
    depth: number,
    ancestorNames: string[],
    properties: Record<string, any>
  ): void {
    const hasParallelFlows = Array.isArray(specNode.parallelFlows) && specNode.parallelFlows.length > 0;
    const hasParallelSpecs = Array.isArray(specNode.parallelSubflowSpecs) && specNode.parallelSubflowSpecs.length > 0;
    // Dynamic fan-out (issue #130): a run-variable name whose value lists the
    // fan-out targets at runtime. It can decorate a static `parallelFlows` base
    // (runtime override) or stand ALONE as the sole target source.
    const parallelVar =
      typeof specNode.parallelFlowsVariable === 'string' ? specNode.parallelFlowsVariable.trim() : '';
    const present = [
      specNode.flow !== undefined && specNode.flow !== null ? 'flow' : null,
      specNode.subflowSpec !== undefined && specNode.subflowSpec !== null ? 'subflowSpec' : null,
      hasParallelFlows ? 'parallelFlows' : null,
      hasParallelSpecs ? 'parallelSubflowSpecs' : null,
      specNode.generateSubflow !== undefined && specNode.generateSubflow !== null ? 'generateSubflow' : null,
    ].filter(Boolean);
    if (present.length > 1) {
      warn(
        'subflow-multiple-sources',
        `Node "${key}": a subflow node should have only one target source ("flow", "subflowSpec", "parallelFlows", "parallelSubflowSpecs", or "generateSubflow"); applying precedence flow > subflowSpec > parallelFlows > parallelSubflowSpecs > generateSubflow.`,
        key
      );
    }

    // Map-over-list (Tier 2a): a modifier on a SINGLE-child subflow that runs the
    // child once per item. It is NOT a target source — it decorates `flow` /
    // `subflowSpec` — so it is resolved here (stamped onto properties before the
    // single-child branches below set subflowId) and is mutually exclusive with
    // the parallel fan-out sources.
    if (specNode.mapOverList === true) {
      const hasSingleChild =
        (specNode.flow !== undefined && specNode.flow !== null) ||
        (specNode.subflowSpec !== undefined && specNode.subflowSpec !== null);
      if (hasParallelFlows || hasParallelSpecs) {
        error(
          'subflow-map-and-parallel',
          `Node "${key}": "mapOverList" runs a SINGLE child once per item and cannot be combined with "parallelFlows"/"parallelSubflowSpecs".`,
          key
        );
      }
      if (!hasSingleChild) {
        error(
          'subflow-map-no-child',
          `Node "${key}": "mapOverList" needs a single child ("flow" or "subflowSpec") to run once per item.`,
          key
        );
      } else {
        properties.mapOverList = true;
        if (specNode.itemSplit !== undefined) {
          if (specNode.itemSplit === 'json-array' || specNode.itemSplit === 'lines') {
            properties.itemSplit = specNode.itemSplit;
          } else {
            warn('invalid-item-split', `Node "${key}": itemSplit "${String(specNode.itemSplit)}" is not valid (json-array | lines); using json-array.`, key);
          }
        }
        if (specNode.sequential === true) properties.sequential = true;
        // Per-item runs reuse the parallel pool/join/error tuning.
        applyParallelTuning(specNode, properties);
      }
    }

    // Dynamic fan-out target selection (issue #130): stamp the run-variable name
    // so the runtime resolves the targets. Mutually exclusive with map-over-list
    // (fan-out vs per-item). It never resolves a static child here — the target
    // set is runtime-determined — so it does not participate in the single-child
    // precedence and can accompany a static `parallelFlows` base.
    if (parallelVar) {
      if (specNode.mapOverList === true) {
        error(
          'subflow-map-and-parallel-var',
          `Node "${key}": "parallelFlowsVariable" (dynamic fan-out) cannot be combined with "mapOverList".`,
          key
        );
      } else {
        properties.parallelSubflowIdsVar = parallelVar;
      }
    }

    if (specNode.flow) {
      // A reference to an ancestor by name would close a loop (A → B → A).
      if (ancestorNames.some((n) => n.toLowerCase() === specNode.flow!.toLowerCase())) {
        error('subflow-cycle', `Node "${key}": flow "${specNode.flow}" refers to an ancestor flow, which would create a cycle.`, key);
        return;
      }
      const resolved = resolveFlowRef(specNode.flow, [...(context.flows ?? []), ...bundleRefs]);
      if (resolved) {
        properties.subflowId = resolved;
      } else {
        error('subflow-unresolved', `Node "${key}": flow "${specNode.flow}" does not match any existing flow (by id or name).`, key);
      }
      return;
    }

    if (specNode.subflowSpec) {
      if (depth + 1 > maxDepth) {
        error('subflow-too-deep', `Node "${key}": nested subflows may not go deeper than ${maxDepth} level(s); this inline subflow was not compiled.`, key);
        return;
      }
      if (flowCount >= maxFlows) {
        error('subflow-too-many', `Node "${key}": compiling this inline subflow would exceed the maximum of ${maxFlows} flows in one bundle; it was not compiled.`, key);
        return;
      }
      const childFlow = compileLevel(specNode.subflowSpec, depth + 1, ancestorNames);
      if (childFlow) {
        properties.subflowId = childFlow.id;
      } else {
        error('subflow-child-empty', `Node "${key}": the inline "subflowSpec" produced no usable flow.`, key);
      }
      return;
    }

    // --- Parallel fan-out to EXISTING flows (issue #102) --------------------
    if (hasParallelFlows) {
      const laneIds: string[] = [];
      for (const ref of specNode.parallelFlows!) {
        if (typeof ref !== 'string' || !ref) {
          error('parallel-flow-invalid', `Node "${key}": a "parallelFlows" entry is missing or not a string.`, key);
          continue;
        }
        // Per-lane cycle guard, mirroring the single-child `flow` path.
        if (ancestorNames.some((n) => n.toLowerCase() === ref.toLowerCase())) {
          error('subflow-cycle', `Node "${key}": parallel flow "${ref}" refers to an ancestor flow, which would create a cycle.`, key);
          continue;
        }
        const resolved = resolveFlowRef(ref, [...(context.flows ?? []), ...bundleRefs]);
        if (resolved) {
          if (!laneIds.includes(resolved)) laneIds.push(resolved);
        } else {
          error('parallel-flow-unresolved', `Node "${key}": parallel flow "${ref}" does not match any existing flow (by id or name).`, key);
        }
      }
      if (laneIds.length > 0) {
        properties.parallelSubflowIds = laneIds;
        applyParallelTuning(specNode, properties);
      } else {
        error('parallel-empty', `Node "${key}": "parallelFlows" resolved to no runnable lanes.`, key);
      }
      return;
    }

    // --- Parallel fan-out to INLINE child specs (issue #102) ---------------
    if (hasParallelSpecs) {
      const laneIds: string[] = [];
      for (const childSpec of specNode.parallelSubflowSpecs!) {
        if (!childSpec || typeof childSpec !== 'object') {
          error('parallel-spec-invalid', `Node "${key}": a "parallelSubflowSpecs" entry is not a FlowSpec object.`, key);
          continue;
        }
        if (depth + 1 > maxDepth) {
          error('subflow-too-deep', `Node "${key}": nested subflows may not go deeper than ${maxDepth} level(s); a parallel inline subflow was not compiled.`, key);
          continue;
        }
        if (flowCount >= maxFlows) {
          error('subflow-too-many', `Node "${key}": compiling a parallel inline subflow would exceed the maximum of ${maxFlows} flows in one bundle; it was not compiled.`, key);
          continue;
        }
        const childFlow = compileLevel(childSpec, depth + 1, ancestorNames);
        if (childFlow) {
          laneIds.push(childFlow.id);
        } else {
          error('subflow-child-empty', `Node "${key}": a "parallelSubflowSpecs" entry produced no usable flow.`, key);
        }
      }
      if (laneIds.length > 0) {
        properties.parallelSubflowIds = laneIds;
        applyParallelTuning(specNode, properties);
      } else {
        error('parallel-empty', `Node "${key}": "parallelSubflowSpecs" produced no runnable lanes.`, key);
      }
      return;
    }

    // Standalone DYNAMIC fan-out (issue #130): the whole target set comes from the
    // runtime variable, so there is no static child to resolve above. Apply the
    // parallel tuning and return before the "missing flow" error.
    if (parallelVar && properties.parallelSubflowIdsVar) {
      applyParallelTuning(specNode, properties);
      return;
    }

    if (specNode.generateSubflow !== undefined && specNode.generateSubflow !== null) {
      error(
        'subflow-generate-unsupported',
        `Node "${key}": "generateSubflow" is only available through the AI flow generator. Use "subflowSpec" for deterministic nested authoring, or "flow" to reference an existing flow.`,
        key
      );
      return;
    }

    error('subflow-missing-flow', `Node "${key}": subflow nodes need a "flow" (existing flow), a "subflowSpec" (inline child), "parallelFlows"/"parallelSubflowSpecs" (concurrent children), or "generateSubflow".`, key);
  }

  /** Map the parallel tuning fields onto the subflow node's properties (issue #102). */
  function applyParallelTuning(specNode: FlowSpecNode, properties: Record<string, any>): void {
    if (specNode.concurrencyLimit !== undefined) {
      if (typeof specNode.concurrencyLimit === 'number' && !Number.isNaN(specNode.concurrencyLimit)) {
        properties.concurrencyLimit = Math.max(1, Math.floor(specNode.concurrencyLimit));
      } else {
        warn('invalid-concurrency-limit', `Node "${specNode.key}": concurrencyLimit "${String(specNode.concurrencyLimit)}" is not a number; using the runtime default.`, specNode.key);
      }
    }
    if (typeof specNode.joinSeparator === 'string') {
      properties.joinSeparator = specNode.joinSeparator;
    }
    if (specNode.errorStrategy !== undefined) {
      if (specNode.errorStrategy === 'fail-fast' || specNode.errorStrategy === 'collect-all') {
        properties.errorStrategy = specNode.errorStrategy;
      } else {
        warn('invalid-error-strategy', `Node "${specNode.key}": errorStrategy "${String(specNode.errorStrategy)}" is not valid (fail-fast | collect-all); using collect-all.`, specNode.key);
      }
    }
  }
}

/**
 * Reverse of {@link compileFlowSpec} (issue #99, AI-Improve): serialize an existing Flow
 * back into a semantic {@link FlowSpec} so it can be shown to the flow-generation model for
 * an "improve this flow" pass.
 *
 * Each spec node's `key` is the ORIGINAL FlowNode id, so the improve caller can (a) tell the
 * model to preserve keys for nodes it does not restructure and (b) hand compileFlowSpec a
 * `positions` map keyed by those same keys, keeping unchanged nodes exactly where they were
 * on the canvas. MCP nodes are folded back into their process node's `servers` list (never
 * emitted as spec nodes — mirroring compileFlowSpec's rule 3), and MCP edges are
 * reconstructed from `servers`, not serialized.
 *
 * Round-trip goal: `compileFlowSpec(flowToSpec(flow))` reproduces `flow` modulo cosmetic
 * defaults (fresh uuids; auto-layout when no positions are supplied). Pinned by
 * __tests__/flow/flowToSpec.test.ts.
 */
export function flowToSpec(flow: Flow): FlowSpec {
  const nodes: FlowNode[] = Array.isArray(flow?.nodes) ? flow.nodes : [];
  const edges: Edge[] = Array.isArray(flow?.edges) ? flow.edges : [];

  // Index MCP nodes so each process node can pull back its bound server + enabled tools.
  const mcpById = new Map<string, FlowNode>();
  for (const n of nodes) if (n.type === 'mcp') mcpById.set(n.id, n);

  // process node id → server refs, reconstructed from the MCP edges leaving it.
  const serversByProcess = new Map<string, FlowSpecServerRef[]>();
  for (const e of edges) {
    if ((e.data as { edgeType?: string } | undefined)?.edgeType !== 'mcp') continue;
    const mcp = mcpById.get(e.target);
    if (!mcp) continue;
    const props = (mcp.data?.properties ?? {}) as Record<string, unknown>;
    const name =
      typeof props.boundServer === 'string' && props.boundServer ? props.boundServer : mcp.data?.label;
    if (!name || typeof name !== 'string') continue;
    const tools = Array.isArray(props.enabledTools)
      ? (props.enabledTools.filter((t): t is string => typeof t === 'string' && !!t))
      : undefined;
    const list = serversByProcess.get(e.source) ?? [];
    list.push({ name, ...(tools ? { tools } : {}) });
    serversByProcess.set(e.source, list);
  }

  const specNodes: FlowSpecNode[] = [];
  for (const node of nodes) {
    if (node.type === 'mcp') continue; // folded into `servers`
    const type = node.type;
    if (type !== 'start' && type !== 'process' && type !== 'finish' && type !== 'subflow' && type !== 'resource' && type !== 'signal') continue;
    const props = (node.data?.properties ?? {}) as Record<string, any>;
    const specNode: FlowSpecNode = {
      key: node.id,
      type,
      ...(node.data?.label ? { label: node.data.label } : {}),
      ...(node.data?.description ? { description: node.data.description } : {}),
    };
    if (type === 'start') {
      if (typeof props.promptTemplate === 'string' && props.promptTemplate) specNode.prompt = props.promptTemplate;
    } else if (type === 'process') {
      if (typeof props.promptTemplate === 'string' && props.promptTemplate) specNode.prompt = props.promptTemplate;
      if (typeof props.boundModel === 'string' && props.boundModel) specNode.model = props.boundModel;
      if (typeof props.inputMode === 'string') specNode.inputMode = props.inputMode as FlowSpecNode['inputMode'];
      if (typeof props.isolatedPrompt === 'string' && props.isolatedPrompt) specNode.isolatedPrompt = props.isolatedPrompt;
      if (typeof props.outputMode === 'string') specNode.outputMode = props.outputMode as FlowSpecNode['outputMode'];
      if (typeof props.maxTurns === 'number' && props.maxTurns > 0) specNode.maxTurns = props.maxTurns;
      if (props.excludeModelPrompt === true) specNode.excludeModelPrompt = true;
      if (props.excludeStartNodePrompt === true) specNode.excludeStartNodePrompt = true;
      if (props.excludeSystemPrompt === true) specNode.excludeSystemPrompt = true;
      if (Array.isArray(props.allowedTools) && props.allowedTools.length > 0) {
        specNode.allowedTools = props.allowedTools.filter((t: unknown): t is string => typeof t === 'string' && !!t);
      }
      if (typeof props.captureVariable === 'string' && props.captureVariable) specNode.captureVariable = props.captureVariable;
      if (typeof props.captureResource === 'string' && props.captureResource) specNode.captureResource = props.captureResource;
      if (typeof props.captureKv === 'string' && props.captureKv) specNode.captureKv = props.captureKv;
      const servers = serversByProcess.get(node.id);
      if (servers && servers.length > 0) specNode.servers = servers;
    } else if (type === 'subflow') {
      // Parallel fan-out (issue #102) takes precedence over the single-child target.
      if (Array.isArray(props.parallelSubflowIds) && props.parallelSubflowIds.length > 0) {
        specNode.parallelFlows = props.parallelSubflowIds.filter((id: unknown): id is string => typeof id === 'string' && !!id);
        if (typeof props.concurrencyLimit === 'number' && props.concurrencyLimit > 0) specNode.concurrencyLimit = props.concurrencyLimit;
        if (typeof props.joinSeparator === 'string') specNode.joinSeparator = props.joinSeparator;
        if (props.errorStrategy === 'fail-fast' || props.errorStrategy === 'collect-all') specNode.errorStrategy = props.errorStrategy;
      } else if (typeof props.subflowId === 'string' && props.subflowId) {
        specNode.flow = props.subflowId;
        // Map-over-list (Tier 2a): a single-child modifier — round-trip alongside `flow`.
        if (props.mapOverList === true) {
          specNode.mapOverList = true;
          if (props.itemSplit === 'json-array' || props.itemSplit === 'lines') specNode.itemSplit = props.itemSplit;
          if (props.sequential === true) specNode.sequential = true;
          if (typeof props.concurrencyLimit === 'number' && props.concurrencyLimit > 0) specNode.concurrencyLimit = props.concurrencyLimit;
          if (typeof props.joinSeparator === 'string') specNode.joinSeparator = props.joinSeparator;
          if (props.errorStrategy === 'fail-fast' || props.errorStrategy === 'collect-all') specNode.errorStrategy = props.errorStrategy;
        }
      }
      // Dynamic fan-out (issue #130): round-trip the run-variable target selector.
      // It can accompany a static `parallelFlows` base or stand alone; when alone,
      // the parallel/single branches above did not carry the tuning, so do it here.
      if (typeof props.parallelSubflowIdsVar === 'string' && props.parallelSubflowIdsVar) {
        specNode.parallelFlowsVariable = props.parallelSubflowIdsVar;
        if (!specNode.parallelFlows && !specNode.flow) {
          if (typeof props.concurrencyLimit === 'number' && props.concurrencyLimit > 0) specNode.concurrencyLimit = props.concurrencyLimit;
          if (typeof props.joinSeparator === 'string') specNode.joinSeparator = props.joinSeparator;
          if (props.errorStrategy === 'fail-fast' || props.errorStrategy === 'collect-all') specNode.errorStrategy = props.errorStrategy;
        }
      }
      if (typeof props.inputMode === 'string') specNode.inputMode = props.inputMode as FlowSpecNode['inputMode'];
      if (typeof props.outputMode === 'string') specNode.outputMode = props.outputMode as FlowSpecNode['outputMode'];
      if (typeof props.promptTemplate === 'string' && props.promptTemplate) specNode.prompt = props.promptTemplate;
      if (props.allowCallerPrompt === true) specNode.allowCallerPrompt = true;
      if (typeof props.captureVariable === 'string' && props.captureVariable) specNode.captureVariable = props.captureVariable;
      if (typeof props.captureResource === 'string' && props.captureResource) specNode.captureResource = props.captureResource;
      if (typeof props.captureKv === 'string' && props.captureKv) specNode.captureKv = props.captureKv;
    } else if (type === 'resource') {
      // Tier 3: round-trip the binding so AI-Improve never drops resource nodes.
      if (props.scope === 'run' && typeof props.runName === 'string' && props.runName) {
        specNode.runName = props.runName;
      } else {
        if (typeof props.boundServer === 'string' && props.boundServer) specNode.server = props.boundServer;
        if (typeof props.uri === 'string' && props.uri) specNode.uri = props.uri;
      }
    } else if (type === 'signal') {
      // Issue #117: round-trip topic/payload so AI-Improve never drops signal nodes.
      if (typeof props.topic === 'string' && props.topic) specNode.topic = props.topic;
      if (typeof props.payloadTemplate === 'string' && props.payloadTemplate) specNode.payloadTemplate = props.payloadTemplate;
    }
    // finish: no properties to carry.
    specNodes.push(specNode);
  }

  // Control edges only — MCP edges are rebuilt from `servers`. Guard against edges that
  // reference an MCP node on a control handle (shouldn't happen, but keeps the spec clean).
  const specEdges: FlowSpecEdge[] = [];
  for (const e of edges) {
    if ((e.data as { edgeType?: string } | undefined)?.edgeType === 'mcp') continue;
    if (!e.source || !e.target) continue;
    if (mcpById.has(e.source) || mcpById.has(e.target)) continue;
    const edgeData = e.data as { bidirectional?: boolean; condition?: EdgeCondition } | undefined;
    specEdges.push({
      from: e.source,
      to: e.target,
      ...(edgeData?.bidirectional ? { bidirectional: true } : {}),
      ...(edgeData?.condition ? { condition: edgeData.condition } : {}),
    });
  }

  return {
    ...(flow?.name ? { name: flow.name } : {}),
    ...(flow?.description ? { description: flow.description } : {}),
    nodes: specNodes,
    edges: specEdges,
  };
}

/**
 * Context-saving defaults for GENERATED flows (not part of compileFlowSpec: the
 * compile API and MCP authoring tools keep the runtime defaults — full-history /
 * full-conversation — so hand-authored specs behave exactly as documented).
 *
 * Auto-generated flows default every process node the spec left unset to
 * inputMode 'latest-message' and outputMode 'latest-message': each step runs
 * scoped to the current task and stops re-sending its tool calls/results to
 * every later step. The generator's system prompt tells the model about these
 * defaults so it can opt back into full-history/full-conversation explicitly.
 */
export function applyGenerationDefaults(flow: Flow): void {
  for (const node of flow.nodes) {
    if (node.type !== 'process') continue;
    const properties = (node.data.properties ?? {}) as Record<string, unknown>;
    if (properties.inputMode === undefined) properties.inputMode = 'latest-message';
    if (properties.outputMode === undefined) properties.outputMode = 'latest-message';
    node.data.properties = properties;
  }
}

/** Layered top-down layout: BFS depth over flow-control edges; MCP nodes beside their process.
 *  When `positions` is supplied (root improve), a node whose spec key has a pinned position
 *  keeps it verbatim; the rest are laid out and MCP nodes follow their process node. */
function layout(
  flowNodes: FlowNode[],
  nodesByKey: Map<string, FlowNode>,
  edges: Edge[],
  mcpAttachments: Array<{ processKey: string; mcpNode: FlowNode }>,
  positions?: Record<string, { x: number; y: number }>
): void {
  const controlAdj = new Map<string, string[]>();
  for (const e of edges) {
    const t = (e.data as { edgeType?: string } | undefined)?.edgeType;
    if (t === 'mcp' || t === 'resource') continue; // attachments are not flow control
    if (!controlAdj.has(e.source)) controlAdj.set(e.source, []);
    controlAdj.get(e.source)!.push(e.target);
  }

  // Resource nodes are satellites like MCP nodes: excluded from the layered
  // layout and parked beside the process node they touch (left side,
  // mirroring MCP on the right).
  const allSpecNodes = [...nodesByKey.values()];
  const resourceSpecNodes = allSpecNodes.filter((n) => n.type === 'resource');
  const specNodes = allSpecNodes.filter((n) => n.type !== 'resource');
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

  // Reverse lookup so a pinned position (keyed by spec key) can find its compiled node.
  const keyByNodeId = new Map<string, string>();
  for (const [key, node] of nodesByKey) keyByNodeId.set(node.id, key);

  const columnCounters = new Map<number, number>();
  for (const n of specNodes) {
    const key = keyByNodeId.get(n.id);
    const pinned = positions && key ? positions[key] : undefined;
    if (pinned && typeof pinned.x === 'number' && typeof pinned.y === 'number') {
      n.position = { x: pinned.x, y: pinned.y };
      continue;
    }
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

  // Resource nodes: to the LEFT of the first process node they touch, stacked.
  // A pinned position (improve round-trip) wins; an unattached resource node
  // falls back to the bottom row like any unreachable node.
  const nodeById = new Map(allSpecNodes.map((n) => [n.id, n]));
  const resourceCounters = new Map<string, number>();
  let unattachedCol = 0;
  for (const rNode of resourceSpecNodes) {
    const key = keyByNodeId.get(rNode.id);
    const pinned = positions && key ? positions[key] : undefined;
    if (pinned && typeof pinned.x === 'number' && typeof pinned.y === 'number') {
      rNode.position = { x: pinned.x, y: pinned.y };
      continue;
    }
    const touching = edges.find(
      (e) =>
        (e.data as { edgeType?: string } | undefined)?.edgeType === 'resource' &&
        (e.source === rNode.id || e.target === rNode.id)
    );
    const partnerId = touching ? (touching.source === rNode.id ? touching.target : touching.source) : undefined;
    const partner = partnerId ? nodeById.get(partnerId) : undefined;
    if (partner) {
      const idx = resourceCounters.get(partner.id) ?? 0;
      resourceCounters.set(partner.id, idx + 1);
      rNode.position = {
        x: partner.position.x - MCP_X_OFFSET,
        y: partner.position.y + idx * MCP_Y_SPACING,
      };
    } else {
      let maxY = 0;
      for (const n of specNodes) maxY = Math.max(maxY, n.position.y);
      rNode.position = { x: BASE_X + unattachedCol * X_SPACING, y: maxY + Y_SPACING };
      unattachedCol++;
    }
  }
}

function finalize(flow: Flow | null, flows: Flow[], issues: CompileIssue[]): CompileResult {
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  return { flow, flows, issues, errorCount, warningCount: issues.length - errorCount };
}
