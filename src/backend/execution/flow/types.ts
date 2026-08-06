import { NodeType, Flow } from '@/shared/types/flow/flow';
import { NodeExecutionTrackerEntry } from '@/shared/types/flow/response';
import { FlujoChatMessage, type McpAppModelContextMap } from '@/shared/types/chat';
import { EmitFn, RecoveryLaneIdentity, RecoveryRecord, UsageTotals } from '@/shared/types/execution/events';
import { EdgeCondition } from '@/utils/shared/edgeConditions';
import { PermissionRule, SavedPermissionRule } from '@/shared/types/permissions';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import OpenAI from 'openai';
import type { VisualCompactionDiagnostic } from '@/shared/types/visualArchive';
import type { ModelMediaPart } from '@/shared/types/model/media';

// --- Custom Chat Message Type is now imported from shared/types/chat.ts ---

/**
 * Explicit origin for every runFlow invocation (issue #339). Chat and direct
 * API calls have an interactive caller; scheduled/triggered, subflow, MCP, and
 * internal-tool runs are headless and therefore unattended.
 */
export const FLOW_INVOCATION_SOURCES = [
  'chat',
  'api',
  'schedule',
  'trigger',
  'subflow',
  'mcp',
  'internal',
] as const;

export type FlowInvocationSource = typeof FLOW_INVOCATION_SOURCES[number];

export function isFlowInvocationSource(value: unknown): value is FlowInvocationSource {
  return typeof value === 'string' &&
    (FLOW_INVOCATION_SOURCES as readonly string[]).includes(value);
}

export function isUnattendedFlowInvocation(source: FlowInvocationSource): boolean {
  return source !== 'chat' && source !== 'api';
}

// --- Debugger Types ---

/**
 * Why a message from the node's full THREADED history is (or isn't) in the exact
 * wire conversation the model receives. Derived from the SAME pipeline functions
 * the runtime uses (deriveModelInputView in buildNodeContext.ts), so the
 * explanation can never drift from behaviour. Issue #153.
 *   - 'system'           — the resolved system message the node used.
 *   - 'sent'             — present in the final wire view (what the model sees).
 *   - 'folded'           — removed by collapseNodeOutputs (outputMode fold).
 *   - 'scoped-out'       — removed by scopeMessagesForInput (inputMode narrowing).
 *   - 'handoff-stripped' — removed/rewritten by stripHandoffPlumbing (handoff
 *                          tool-call/result + synthetic "Continue").
 */
export type WireStatus = 'system' | 'sent' | 'folded' | 'scoped-out' | 'handoff-stripped';

/** Per-message provenance in a ModelInputSnapshot (see WireStatus). Carries only
 *  a short content preview, never the full payload, so the snapshot stays bounded. */
export interface ModelInputProvenanceEntry {
  id?: string;
  role: string;
  status: WireStatus;
  /** Human-readable why (for scoped-out/folded/handoff-stripped). */
  reason?: string;
  /** Truncated content preview for the annotated history view. */
  preview?: string;
  /** Names of any tool calls this assistant turn made (for annotation). */
  toolCallNames?: string[];
}

/**
 * A purpose-built, debug-mode-gated snapshot of exactly what a Process node's
 * model call receives (issue #153): the resolved system message, the exact wire
 * conversation (after fold + scope + handoff-plumbing strip), and per-message
 * provenance explaining how the wire differs from the threaded history.
 *
 * SECURITY: conversation content ONLY. Never carries provider credentials,
 * modelId-resolved keys, or headers — honours "API keys never to the frontend".
 */
export interface ModelInputSnapshot {
  /** The resolved system text the model saw (null for none). */
  systemMessage: { content: string } | null;
  /** The exact final wire conversation (post-strip), for rich rendering. Content
   *  is per-message capped to keep the trace roughly constant size per step. */
  wireMessages: FlujoChatMessage[];
  /** One entry per message in the node's full threaded history. */
  provenance: ModelInputProvenanceEntry[];
  /** Summary counts for a one-line "18 in history → 11 sent · 5 folded …". */
  counts: { threaded: number; sent: number; folded: number; scopedOut: number; handoffStripped: number };
  inputMode?: 'full-history' | 'latest-message' | 'isolated';
  /** Final wire-time visual routing metrics, captured by ModelHandler. */
  visualCompaction?: VisualCompactionDiagnostic;
}

/**
 * Represents a single step in the execution trace for debugging.
 */
export interface DebugStep {
  stepIndex: number; // Sequential index of the step
  nodeId: string;
  nodeType: NodeType;
  nodeName: string;
  timestamp: string; // ISO timestamp
  actionTaken: string; // The action returned by the node's post method
  // Snapshots of state and results for inspection
  stateBefore: Partial<SharedState>; // Snapshot before node execution
  stateAfter: Partial<SharedState>; // Snapshot after node execution
  prepResultSnapshot: any; // Snapshot of the result from prep()
  execResultSnapshot: any; // Snapshot of the result from execCore()
  /** Model-input visualization for a Process node's model call (issue #153).
   *  Populated only in debug mode; absent for non-model nodes / older traces. */
  modelInput?: ModelInputSnapshot;
  /** Per-model-call wire snapshots captured across the node's tool loop
   *  (issue #167, Phase 2 of #162). One entry per model call the node made
   *  during this visit, in call order. `modelInput` above remains the FIRST /
   *  representative snapshot for backward compatibility with older traces and
   *  the singular renderer. Populated only in debug mode; absent for non-model
   *  nodes / older traces. The frontend pages through this array. */
  modelInputs?: ModelInputSnapshot[];
}

// --- Core Flow Types ---

// Base node params interface with generic properties
export interface BaseNodeParams<T = Record<string, unknown>> {
    id: string;
    label: string;
    type: NodeType;
    properties: T;
}

// StartNode specific properties
export interface StartNodeProperties {
    name?: string;
    promptTemplate?: string;
}

// ProcessNode specific properties
/** Status of a single `todo` task (issue #259), mirroring opencode's set. */
export type TodoStatus = 'pending' | 'in_progress' | 'done' | 'cancelled';

/** One run-scoped task tracked by the synthetic `todo` tool (issue #259). */
export interface TodoItem {
    id: string;
    content: string;
    status: TodoStatus;
    createdAt: number;
    updatedAt: number;
}

export interface ProcessNodeProperties {
    name?: string;
    /** True once the user edits the node's label by hand; suppresses auto-naming
     *  the node after its bound model on (re)binding (issue #38, Item C). */
    nameIsCustom?: boolean;
    promptTemplate?: string;
    excludeModelPrompt?: boolean;
    excludeStartNodePrompt?: boolean;
    /** When true, suppress the hardcoded `# GENERAL INFORMATION:` system block
     *  (workflow/handoff guidance) from the rendered prompt. Independent of
     *  excludeModelPrompt. Defaults to false (block shown). Issue #67. */
    excludeSystemPrompt?: boolean;
    /** How much of the conversation the node's MODEL sees. Mirrors the subflow
     *  node's input modes so a process node can run scoped to the current task
     *  or fully self-contained:
     *    - 'full-history' (default): the node's rendered prompt (system) plus
     *      the whole conversation. Today's behavior; existing flows are unchanged.
     *    - 'latest-message': the node's prompt plus only the most recent user
     *      message (and any in-flight tool exchange for the current turn).
     *    - 'isolated': the node's prompt plus `isolatedPrompt` as a single user
     *      message; the prior conversation is not shown to the model.
     *  Scoping applies to the WIRE view only — the persisted conversation is
     *  never truncated (see scopeMessagesForInput / ModelHandler wireMessages). */
    inputMode?: 'full-history' | 'latest-message' | 'isolated';
    /** The user message sent to the model in 'isolated' inputMode. Wire-only:
     *  it shapes the model's input but is not persisted into the conversation
     *  transcript (analogous to the subflow node's isolated prompt). */
    isolatedPrompt?: string;
    /** Opt-out (issue #96): only meaningful in 'isolated' inputMode. When unset
     *  or true, an upstream routing model MAY pass a `prompt` through the handoff
     *  tool that overrides this node's authored `isolatedPrompt` (so the previous
     *  node can hand a message to this isolated step, like an isolated subflow).
     *  Set false to forbid it — the handoff tool then exposes no `prompt` param
     *  and only the authored `isolatedPrompt` is used. Mirrors the subflow node's
     *  `allowCallerPrompt`. */
    allowCallerPrompt?: boolean;
    /** How much of THIS node's work later model calls see (the output-side
     *  counterpart of inputMode, for context-token control):
     *    - 'full-conversation' (default): everything the node produced — tool
     *      calls, tool results, intermediate turns — stays on the wire for
     *      subsequent nodes/turns. Today's behavior; existing flows unchanged.
     *    - 'latest-message': once the node's tool loop has settled, only its
     *      plain assistant responses stay visible to models; its
     *      assistant(tool_calls) turns and their tool results are collapsed.
     *  Like inputMode, this shapes the WIRE view only — the persisted
     *  conversation/log keeps every message (see collapseNodeOutputs). */
    outputMode?: 'full-conversation' | 'latest-message';
    /** Issue #258: opt in to the synthetic `question` tool so this node's model
     *  can ask the user a structured multiple-choice question mid-run and keep
     *  working with the answer. Off by default; leave off for unattended flows
     *  (or deny action `question` via permissionRules). */
    allowQuestion?: boolean;
    /** Issue #259: opt in to the synthetic `todo` tool so this node's model can
     *  maintain a run-scoped task list (SharedState.todos) across a multi-turn
     *  visit. The list is re-injected into the system prompt each turn and shown
     *  live in the UI. Off by default (undefined/false = off). */
    enableTodoTool?: boolean;
    boundModel?: string;
    allowedTools?: string[];
    mcpNodes?: MCPNodeReference[];
    /** Tier 3: resource nodes wired to this step (derived from resource edges
     *  by FlowConverter, like mcpNodes). Consumed ones are injected into the
     *  prompt at prep; a produce one sets captureResource to its runName. */
    resourceNodes?: ResourceNodeReference[];
    /**
     * Per-node override of the bound model's Max Turns cap (agentic turns for
     * self-orchestrating adapters). Unset/0 = inherit the model setting, then
     * the system default (DEFAULT_AGENTIC_MAX_TURNS = 50).
     */
    maxTurns?: number;
    /**
     * Per-node override of the bound model's Max Output Tokens cap (upper bound
     * on tokens the provider may generate for a single completion). Highest
     * precedence: node override → bound-model `maxTokens` → adapter default.
     * Unset/0 = inherit the model setting, then let the adapter decide (no
     * numeric system default). Not enforced by the Claude subscription adapter.
     */
    maxTokens?: number;
    /**
     * Per-node summarizing-compaction control (issue #248). `'off'` opts this
     * node OUT of compaction even when the global experimental flag is on;
     * `'auto'` (or unset) inherits the global setting. A node cannot turn
     * compaction ON by itself — it stays gated behind `compactionEnabled`.
     */
    compactionMode?: 'auto' | 'off';
    /**
     * Per-node override of how many tokens of the recent conversation tail are
     * kept verbatim when compacting (everything older is summarized). Unset =
     * inherit the global `compactionKeepTokens`, then the default (8000).
     */
    compactionKeepTokens?: number;

    /** Tier 2c (named variables): when set, this node writes its final output
     *  (the model's assistant text) into `SharedState.variables[captureVariable]`
     *  in post(). Any later step can inject it with `${var:NAME}` in its prompt /
     *  isolatedPrompt, surviving `latest-message`/`isolated` scoping that would
     *  otherwise drop it from the visible history. Run-scoped, plaintext — NOT a
     *  secret (distinct from `${global:VAR}`). */
    captureVariable?: string;
    /** Tier 3 (resource-tracked data flow): when set, this node's final output is
     *  ALSO stored as a named run-scoped resource (flujo://run/<conv>/…) with
     *  lineage, via the run-resource store. Later steps inject it with
     *  `${res:NAME}`; external MCP clients read it via the internal "flujo"
     *  server. The big/structured sibling of `captureVariable` (which stays the
     *  right tool for short strings). */
    captureResource?: string;
    /** Tier 4 (persistent kv): when set, this node's final output is ALSO saved
     *  to a PERSISTENT key-value entry that survives ACROSS runs, injected
     *  elsewhere with `${kv:NAME}`. The name may carry a scope prefix
     *  (`folder/` default, `flow/`, `global/`). Unlike captureVariable/
     *  captureResource (run-scoped), a scheduled flow uses it to carry state to
     *  its next pulse. Plaintext, never secrets. */
    captureKv?: string;
}

// FinishNode specific properties
export interface FinishNodeProperties {
    name?: string;
}

// SignalNode specific properties (issue #117)
export interface SignalNodeProperties {
    name?: string;
    /** The event topic this node emits when execution traverses it. Matched by a
     *  `flow-event` trigger configured with `source: { topic }`. Free-form name
     *  (no registry), like a webhook id. */
    topic?: string;
    /** The payload template emitted with the signal. `${var:NAME}` (run-scoped
     *  scratchpad) is resolved at emit time via resolveRunVars; the result is the
     *  signal's `payload`.
     *  NOTE (issue #164): this is no longer surfaced in the primary manual
     *  FlowBuilder UI (a signal is authored as just a *named* signal). It stays
     *  in the data model / FlowSpec authoring path and is preserved on existing
     *  nodes, so payload-carrying signals and `flow-event` payload filters keep
     *  working; the modal exposes it behind an "Advanced" disclosure. */
    payloadTemplate?: string;
}

// MCPNode specific properties
export interface MCPNodeProperties {
    name?: string;
    /** True once the user edits the node's label by hand; suppresses auto-naming
     *  the node after its bound server on (re)binding (issue #38, Item C). */
    nameIsCustom?: boolean;
    boundServer?: string;
    enabledTools?: string[];
    /**
     * @deprecated Never applied. MCP connections are singletons keyed by server
     * name (shared across all nodes/flows) and a stdio server's process env is
     * fixed at spawn, so a per-node env overlay cannot be honored by the current
     * shared-connection model. The FlowBuilder UI that wrote this was removed
     * (issue #63); set env on the MCP *server config* instead, which is the
     * supported and effective place. Kept only so existing flows that persisted
     * this key still load without error; do not read it. */
    env?: Record<string, string>;
    /** Per-tool-call timeout in seconds for this node's tools. -1 = no timeout;
     *  unset = DEFAULT_TOOL_CALL_TIMEOUT_SECONDS (5 minutes). */
    toolTimeout?: number;
    /** Extra workspace folders (MCP roots, issue 46) this node contributes to its bound
     *  server. Additive: the server sees the union of its own roots and these via
     *  roots/list (connections are singletons keyed by server name); when neither is
     *  set, the server's own rootPath is the default root. Advisory scoping, not a
     *  sandbox. Supports `${global:VAR}`. */
    roots?: string[];
    /**
     * Native MCP resource exposure (issue #239). Controls which of the bound
     * server's MCP resources are visible to the model at runtime:
     *   - `undefined` or `'all'` — expose all resources (default).
     *   - `string[]` with entries — expose only resources whose URI is in the list.
     *   - `string[]` empty (`[]`) — disable native resource exposure for this node.
     */
    enabledResources?: string[] | 'all';
}

// SubflowNode specific properties
export interface SubflowNodeProperties {
    name?: string;
    /** The id of the flow this node runs as a subflow (flow-as-callable). */
    subflowId?: string;
    /** The user prompt sent to the subflow in 'isolated' inputMode. When
     *  `inputMode` is unset but this is non-empty, the node is treated as
     *  'isolated' (back-compat: this field used to override the history
     *  unconditionally). (Named-variable templating is a later enhancement.) */
    promptTemplate?: string;
    /** How the parent conversation is mapped into the subflow (issue #74):
     *    - 'full-history' (default): the whole sanitized parent transcript is
     *      passed, so the subflow continues with genuine context. This can make
     *      an orchestrator-driven worker re-anchor on an earlier task, so
     *    - 'latest-message': only the most recent user instruction is passed,
     *      scoping each subflow invocation to the current task.
     *    - 'isolated': the parent conversation is ignored; `promptTemplate` is
     *      sent as the subflow's single user prompt.
     *  Default stays 'full-history' so existing flows are unaffected. */
    inputMode?: 'full-history' | 'latest-message' | 'isolated';
    /** Output visibility: 'steps' (default) folds the child run's events into
     *  the parent conversation's live stream + log, nested by depth;
     *  'final-only' shows only the folded final output message. */
    outputMode?: 'steps' | 'final-only';
    /** Opt-out (issue #96 / #138): only meaningful in 'isolated' inputMode. When
     *  not explicitly `false`, the handoff tool that targets this node exposes an
     *  optional `prompt` string parameter; a caller-supplied value OVERRIDES
     *  `promptTemplate` (which becomes the default/fallback used when the caller
     *  passes none). Canonical default is ON — an ABSENT value is treated as ON
     *  at runtime, matching the properties modal's display (issue #138 fixed the
     *  frontend/backend default mismatch). Set explicitly to `false` to keep an
     *  isolated subflow sending only its static prompt with a parameter-less
     *  handoff tool. Groundwork for running subflows as independent, callable
     *  workers. */
    allowCallerPrompt?: boolean;
    /** @deprecated Queueing no longer requires opt-in. Every Subflow handoff
     *  exposes a `task` and repeated calls create queued jobs automatically.
     *  Kept only so older saved flows and FlowSpecs continue to deserialize. */
    allowCallerFanout?: boolean;
    /** Author-defined spawn briefs (issue #156): when this list is non-empty,
     *  every visit to this node spawns ONE PARALLEL INSTANCE of the sub-agent
     *  (`subflowId`) PER BRIEF — the author-defined twin of the agentic
     *  spawn-with-brief above, running through the same lane engine (bounded
     *  pool, ordered join, `errorStrategy`). Each brief resolves `${var:}` /
     *  `${res:}` / `${kv:}` refs like a promptTemplate. Caller-supplied `task`
     *  briefs (allowCallerFanout) override this list for that visit. Requires a
     *  single `subflowId`; mutually exclusive with `parallelSubflowIds` and
     *  `mapOverList`. */
    spawnBriefs?: string[];
    /** Fan-out / join (issue #102): when this list has >=1 entry, the node runs
     *  SEVERAL child flows CONCURRENTLY and joins their outputs, instead of the
     *  single-`subflowId` path. Empty/absent => today's single-child behavior
     *  (the default path is completely unchanged). The same resolved input
     *  (per `inputMode`) is fanned out to every lane. */
    parallelSubflowIds?: string[];
    /** Dynamic fan-out target selection (issue #130): the NAME of a run-scoped
     *  variable (${var:NAME}, captured upstream via captureVariable) whose value
     *  lists the fan-out target flow ids to run CONCURRENTLY. This lets a running
     *  model/process node decide WHICH (and how many) flows fan out at RUNTIME.
     *  The value is split with the same itemSplit semantics as map-over-list (a
     *  JSON array of ids — default — or a newline list), trimmed, de-duplicated,
     *  capped at MAX_DYNAMIC_FANOUT_LANES, and each id is validated against the
     *  flows store (unknown ids and a self-reference are dropped with a warning).
     *  When it resolves to a NON-EMPTY set it OVERRIDES the static
     *  parallelSubflowIds; an empty/absent resolution falls back to the static
     *  list (today's behavior). Resolved ONLY through the plaintext run-var path
     *  — never resolveGlobalVars (no secret decryption). Mutually exclusive with
     *  mapOverList. The single-outgoing-edge rule is unchanged (this is about
     *  multiple CHILDREN, not successors). */
    parallelSubflowIdsVar?: string;
    /** Maximum child jobs active simultaneously. Additional jobs stay queued;
     *  this never limits the total job count. Set 1 for sequential execution.
     *  Default 4. */
    concurrencyLimit?: number;
    /** String placed between joined lane outputs (child order) in parallel mode.
     *  Default "\n\n". */
    joinSeparator?: string;
    /** Result presentation mode for parallel subflows (issue #359):
     *    - 'separate' (default for newly created parallel/spawn nodes): each lane
     *      produces its own framed assistant message in the parent conversation,
     *      carrying structured lane metadata (index, title, status).
     *    - 'joined': retain the current behavior — one framed message with joined
     *      outputs and failure summary (back-compat: absent is treated as 'joined').
     *  Applies only to parallel/spawn/fan-out/map-over-list executions with
     *  multiple lanes; single-child subflows are unaffected. */
    resultPresentation?: 'separate' | 'joined';
    /** Parallel error handling (issue #102):
     *    - 'collect-all' (default): every lane runs to completion; successful
     *      outputs are folded plus a marked failure summary; the node still
     *      hands off to its successor (partial success is surfaced via `partial`).
     *    - 'fail-fast': the first lane error fails the whole node (mirrors the
     *      single-child ERROR_ACTION semantics) and no further lanes are started. */
    errorStrategy?: 'fail-fast' | 'collect-all';
    /** Map-over-list (Tier 2a): run `subflowId` ONCE PER ITEM parsed from the
     *  resolved input, instead of once. Mutually exclusive with
     *  `parallelSubflowIds` (fan-out). Empty/absent => today's behavior. The
     *  per-item runs reuse the parallel worker pool / join / error strategy, so
     *  `concurrencyLimit`, `joinSeparator`, and `errorStrategy` apply unchanged. */
    mapOverList?: boolean;
    /** Map-over-list: how to split the resolved input into items:
     *    - 'json-array' (default): parse the input as a JSON array; each element
     *      becomes one item (objects/arrays are re-stringified for the child).
     *    - 'lines': split on newlines; blank lines are dropped; each line is one item. */
    itemSplit?: 'json-array' | 'lines';
    /** Map-over-list: run items one at a time in order instead of through the
     *  concurrent pool. Implemented by pinning the pool to size 1, so no second
     *  execution path exists. Default false (concurrent, bounded by concurrencyLimit). */
    sequential?: boolean;
    /** Tier 2c (named variables): when set, this node writes the subflow's final
     *  output (the folded `outputText`) into `SharedState.variables[captureVariable]`
     *  in post(). Capture happens on the PARENT's subflow node in the CURRENT run —
     *  a var set INSIDE an ephemeral child run is discarded, not smuggled up. Any
     *  later step injects it with `${var:NAME}`. Run-scoped, plaintext. */
    captureVariable?: string;
    /** Tier 3: store the subflow's folded output as a named run-scoped resource
     *  (see ProcessNodeProperties.captureResource). Capture happens on the
     *  PARENT's subflow node in the current run, like captureVariable. */
    captureResource?: string;
    /** Tier 4 (persistent kv): store the subflow's folded output to a PERSISTENT
     *  key-value entry surviving ACROSS runs (see ProcessNodeProperties.captureKv).
     *  Capture happens on the PARENT's subflow node, like captureVariable. */
    captureKv?: string;
    /** Debugging (issue #125): when true, this subflow's OWN run is persisted as
     *  its own conversation in the chat sidebar (deep-linkable, linked to the
     *  parent run via parentRunId) instead of running ephemerally. Mirrors the
     *  planned-execution `saveConversations` opt-in and is routed through
     *  runFlow's `mode: 'conversation'` — NOT a persistConversationState call-site
     *  bypass, so the ephemeral-by-default invariant is preserved. Honored on the
     *  single-child path AND on every parallel lane (spawn / fan-out /
     *  map-over-list — issue #156 defect 1): each lane persists as its own
     *  sidebar conversation, titled by its brief/item and linked to the parent
     *  run via parentRunId. Canonical default is ON — an
     *  ABSENT value is treated as persist at runtime, matching the properties
     *  modal's display (issue #138 fixed the frontend/backend default mismatch
     *  where the UI showed ON while the backend ran ephemerally). Only an explicit
     *  `false` opts out; the modal no longer seeds a value into stored data, so an
     *  unrelated save can never silently bake in this key. */
    saveConversation?: boolean;
}

/** One resolved job in a SubflowNode queue. Legacy code and event payloads still
 *  use the word "lane" for wire compatibility. */
export interface SubflowLanePlan {
    subflowId: string;
    subflowName?: string;
    /** Map-over-list: this lane's OWN input, overriding the node's shared
     *  runInput. Absent for fan-out lanes, which all share one input. */
    input?: { prompt: string } | { messages: FlujoChatMessage[] };
    /** Map-over-list: 0-based item index, for attribution / live-view labels. */
    itemIndex?: number;
    /** Map-over-list: total item count, paired with `itemIndex`. */
    itemCount?: number;
    /** Sidebar title for this lane's persisted conversation (issue #156):
     *  derived from the lane's brief/item so saved spawn lanes are tellable
     *  apart. Only used when the node persists lane conversations. */
    laneTitle?: string;
    /** Stable durable lane identity when this queue belongs to a recoverable
     *  persisted Subflow invocation. */
    laneId?: string;
    /** Stable child conversation id reused by every recovery attempt. */
    conversationId?: string;
}

/** The outcome of one queued child job, kept in request order. */
export interface SubflowLaneResult {
    subflowId: string;
    success: boolean;
    outputText?: string;
    /** Generated media returned by this lane, in child-message order. */
    outputMedia?: ModelMediaPart[];
    error?: string;
    /** Author-defined or caller-supplied lane title for attribution (issue #359). */
    laneTitle?: string;
    laneId?: string;
    conversationId?: string;
}

export type SubflowInvocationLaneStatus =
    | 'pending'
    | 'running'
    | 'completed'
    | 'error'
    | 'cancelled';

/** One durable child job belonging to a specific visit of a Subflow node. The
 *  resolved input is frozen here because a caller-created task queue is consumed
 *  before the node runs and cannot be reconstructed safely on a later retry. */
export interface SubflowInvocationLane extends SubflowLanePlan {
    id: string;
    index: number;
    count: number;
    conversationId: string;
    status: SubflowInvocationLaneStatus;
    attempt: number;
    outputText?: string;
    outputMedia?: ModelMediaPart[];
    error?: string;
    updatedAt: number;
}

export type SubflowInvocationStatus = 'running' | 'blocked' | 'ready' | 'folded';

/** Durable join record for one visit to a Subflow node. It is stored on the
 *  parent SharedState, making lane reuse and child-to-parent completion work
 *  across HTTP requests and process restarts without preserving a JS call stack. */
export interface SubflowInvocation {
    version: 1;
    id: string;
    parentConversationId: string;
    parentNodeId: string;
    parentRunId?: string;
    status: SubflowInvocationStatus;
    depth: number;
    chainDepth?: number;
    plannedExecutionId?: string;
    showSteps: boolean;
    nodeName?: string;
    subflowName?: string;
    concurrencyLimit: number;
    joinSeparator: string;
    errorStrategy: 'fail-fast' | 'collect-all';
    /** Shared node input stored once for fan-out lanes. Per-lane briefs/items
     *  remain on the lane itself, avoiding N copies of a full chat transcript. */
    sharedInput?: { prompt: string } | { messages: FlujoChatMessage[] };
    lanes: SubflowInvocationLane[];
    createdAt: number;
    updatedAt: number;
    foldedAt?: number;
    resumeRequestedAt?: number;
}

// Type-specific node params
export interface StartNodeParams extends BaseNodeParams<StartNodeProperties> {
    type: 'start';
}

export interface ProcessNodeParams extends BaseNodeParams<ProcessNodeProperties> {
    type: 'process';
    /**
     * Tier 2b (deterministic conditions on edges): predicates carried off this
     * node's outgoing control edges, keyed by edge id (the same string used as
     * the routing action / successor key). Populated by FlowConverter from
     * `edge.data.condition`; read by ProcessNode.post to auto-route on the last
     * message. Absent/empty ⇒ the node routes exactly as before (model-decided
     * handoff, terminate on plain text).
     */
    edgeConditions?: Record<string, EdgeCondition>;
    /**
     * Tier 2b: this node's outgoing CONTROL edge ids in author order (MCP edges
     * excluded), so "first matching edge wins" and "the bare fallback edge" are
     * deterministic. Populated alongside `edgeConditions`.
     */
    orderedOutgoingEdges?: string[];
}

export interface FinishNodeParams extends BaseNodeParams<FinishNodeProperties> {
    type: 'finish';
}

export interface MCPNodeParams extends BaseNodeParams<MCPNodeProperties> {
    type: 'mcp';
}

export interface SubflowNodeParams extends BaseNodeParams<SubflowNodeProperties> {
    type: 'subflow';
}

export interface ResourceNodeParams extends BaseNodeParams<ResourceNodeProperties> {
    type: 'resource';
}

export interface SignalNodeParams extends BaseNodeParams<SignalNodeProperties> {
    type: 'signal';
}

export interface StaticNodeParams extends BaseNodeParams<StaticNodeProperties> {
    type: 'static';
}

/**
 * Static node (issue #358): a deterministic, non-LLM, pass-through node that
 * INJECTS pre-authored entries into the conversation when traversed. Each entry
 * is either a plain message (system/user/assistant) or a synthetic assistant
 * tool-call plus its matching tool result (two messages).
 */
export type StaticEntry =
    | { kind: 'message'; role: 'system' | 'user' | 'assistant'; content: string }
    | { kind: 'toolCall'; toolName: string; argumentsJson: string; result: string };

export interface StaticNodeProperties {
    name?: string;
    /** Entries injected, in order, onto sharedState.messages. */
    entries?: StaticEntry[];
    /** When true, inject only the first time the node is traversed in a run. */
    injectOnce?: boolean;
}

// Union type for all node params
export type NodeParams = StartNodeParams | ProcessNodeParams | FinishNodeParams | MCPNodeParams | SubflowNodeParams | ResourceNodeParams | SignalNodeParams | StaticNodeParams;

// Resource node (Tier 3) — a config-holder like the MCP node: it represents a
// data artifact in the graph and is never executed. FlowConverter folds its
// binding into the connected Process node's params (`resourceNodes`) exactly
// like mcpNodes; resource edges never become successors.
export interface ResourceNodeProperties {
    name?: string;
    /** 'mcp' = a static resource on an MCP server (boundServer + uri);
     *  'run' = a run-scoped artifact steps produce/consume (runName). */
    scope?: 'mcp' | 'run';
    boundServer?: string;
    /** Resource uri (or uriTemplate) on boundServer, scope 'mcp'. */
    uri?: string;
    mimeType?: string;
    /** Artifact name for scope 'run' — the captureResource / ${res:NAME} name. */
    runName?: string;
}

/** A resource node folded onto a Process node by FlowConverter (Tier 3). */
export interface ResourceNodeReference {
    /** The RESOURCE node's id — resource:read events carry it so the canvas
     *  can light the resource node up, not just the process node. */
    id: string;
    /** 'consume' = resource→process edge (contents injected into the prompt);
     *  'produce' = process→resource edge (output saved under runName). */
    role: 'consume' | 'produce';
    properties: ResourceNodeProperties;
}

// MCP Node Reference (used in ProcessNode)
export interface MCPNodeReference {
    id: string;
    properties: {
        boundServer?: string;
        enabledTools?: string[];
        /** @deprecated Never applied — see MCPNodeProperties.env (issue #63). Set env
         *  on the MCP server config instead. Retained only for back-compat loading. */
        env?: Record<string, string>;
        /** Per-tool-call timeout in seconds. -1 = no timeout; unset = 5-minute default. */
        toolTimeout?: number;
        /** Extra workspace folders (MCP roots) this node adds to the bound server — see
         *  MCPNodeProperties.roots (issue 46). */
        roots?: string[];
        /**
         * Native MCP resource exposure (issue #239). Mirrors MCPNodeProperties.enabledResources.
         * `undefined` or `'all'` exposes all; `string[]` filters by URI; `[]` disables.
         */
        enabledResources?: string[] | 'all';
    };
}

// Flow parameters
export interface FlowParams {
    flowId: string;
    flowName: string;
    nodeParams?: Record<string, NodeParams>;
}

/** Durable Codex SDK thread metadata, scoped to one Process node. */
export interface CodexSessionMetadata {
    adapter: string;
    provider: string;
    threadId: string;
    configurationHash: string;
    prefixHash: string;
    historyHash: string;
    seenMessageCount: number;
    updatedAt: number;
}

// Shared state (minimized)
export interface SharedState {
    /** Stable logical execution id used only for metadata-only statistics. It is
     * preserved while approval/debug is paused, then replaced for a new turn. */
    logicalRunId?: string;
    /**
     * Additive durable recovery metadata (issue #355). Legacy status values stay
     * authoritative for compatibility; this versioned record supplies the more
     * precise cancellation/interruption/failure classification and safe boundary.
     */
    recovery?: RecoveryRecord;
    /** Recoverable Subflow-node visits owned by this parent conversation. */
    subflowInvocations?: Record<string, SubflowInvocation>;
    /** Unfolded invocation per Subflow node. A completed/folded visit clears its
     *  entry so a later graph loop creates a genuinely new batch. */
    activeSubflowInvocationByNode?: Record<string, string>;
    /** On a persisted child conversation, identifies the exact parent lane that
     *  this conversation must satisfy after a retry or continued turn. */
    subflowLane?: RecoveryLaneIdentity;
    /** UTC epoch used to measure the logical run across pause/resume boundaries. */
    statisticsRunStartedAt?: number;
    /** Prevents a resumed approval/debug request from emitting a second start. */
    statisticsRunStarted?: boolean;
    /** Guards terminal lifecycle emission in reconciliation/error paths. */
    statisticsRunFinished?: boolean;
    /** Display-name snapshots captured once for this logical run. */
    statisticsFlowName?: string;
    statisticsPlannedExecutionName?: string;
    // Only tracking info in shared state
    trackingInfo: {
        executionId: string;
        startTime: number;
        nodeExecutionTracker: NodeExecutionTrackerEntry[];
    };
    // Messages as the single source of truth, now using our timestamped type
    messages: FlujoChatMessage[];
    /** Codex SDK threads persisted with the conversation, keyed by Process node id. */
    codexSessions?: Record<string, CodexSessionMetadata>;
    /** Server-owned anchors for undoing a confirmed per-message revert. */
    revertOperations?: Record<string, {
        messageId: string;
        root: string;
        snapshotId: string;
        paths: string[];
        createdAt: number;
        undoneAt?: number;
    }>;
    /**
     * Latest `ui/update-model-context` payload per MCP App. This is persisted
     * separately from chat messages and injected only into future model wire
     * contexts; an app update overwrites its previous entry.
     */
    mcpAppContexts?: McpAppModelContextMap;
    // Flow ID needed by some nodes
    flowId: string;
    /**
     * Quick-Chats (issue #61): a self-contained flow definition that travels
     * WITH the conversation state instead of living in the flows store. When
     * present, the engine resolves the flow from this snapshot (bypassing
     * flowService.getFlow); when absent, it falls back to the store lookup by
     * flowId (the unchanged path for every saved flow). Persisted for
     * mode:'conversation' quick chats by the normal persistConversationState
     * path, which is what makes follow-up turns, crash recovery and app
     * restarts work without any temp-flow store or GC. The snapshot is
     * immutable for the life of the conversation. Removed by the "Save as flow"
     * promotion, after which the conversation behaves like any flow-backed one.
     */
    flowSnapshot?: Flow;
    // Last response from the model
    lastResponse?: string | Record<string, unknown>;
    /**
     * Tier 2c (named variables): a run-scoped scratchpad of string values a node
     * can CAPTURE (`captureVariable`) and any later step can INJECT via
     * `${var:NAME}` in its prompt / isolatedPrompt / subflow input. Seeded from
     * FlowRunInput.variables at run start. Persists with the conversation for a
     * top-level run (plain serializable field), and dies with an ephemeral child
     * run (never written back to the parent — see SubflowNode capture gotcha).
     * Plaintext and run-scoped: NOT config and NOT secrets (distinct from
     * `${global:VAR}`, which is storage-backed, encrypted, and never on the
     * prompt path). Resolved by resolveRunVars.ts.
     */
    variables?: Record<string, string>;
    /**
     * Issue #259 (`todo` tool): a run-scoped task list a node's model can
     * CREATE/UPDATE via the synthetic `todo` tool when the node opts in
     * (`enableTodoTool`). Plain JSON-serializable, so it persists with the
     * conversation (persistConversationState), survives wire-only compaction
     * (compaction never touches SharedState) and is re-injected into the system
     * prompt each turn by ProcessNode.prep. NOT seeded for child runs, so spawned
     * workers cannot scribble over the parent's plan (non-inheritance AC).
     */
    todos?: TodoItem[];
    // MCP context for tool handling
    mcpContext?: MCPContext;
    /** Issue #239: the MCP node references for the currently executing ProcessNode.
     *  Set in ProcessNode.prep() and read by runFlow.ts when calling processToolCalls
     *  so native resource tools (list_mcp_resources, native read_resource) receive
     *  the correct server context. Cleared / overwritten on each node transition. */
    currentMCPNodes?: MCPNodeReference[];
    /**
     * Synthetic tools (`read_resource`, `list_mcp_resources`) that have been
     * armed at any point in this conversation.
     *
     * These two tools used to be armed LAZILY — read_resource the first turn a
     * `flujo://run/` URI appeared on the wire, list_mcp_resources whenever a live
     * `resources/list` probe happened to succeed. Both decisions could flip
     * mid-conversation, and because the tool block serializes AHEAD of the
     * messages, a flip invalidates 100% of the provider's prefix cache for that
     * turn (#89). Recording the arming here makes it MONOTONE: once a synthetic
     * tool has been offered on this conversation it keeps being offered, even if
     * the triggering condition transiently disappears (e.g. a server's resource
     * listing fails on a later turn). Combined with the front-loaded arming
     * decision in ProcessNode.prep, the tool block is byte-stable for the life of
     * a run. Plain string[] so it persists with the conversation.
     */
    armedSyntheticTools?: string[];
    /**
     * Frozen system-prompt string per process node, captured on first render of
     * a conversation and re-sent byte-identically thereafter (#249). Keyed by
     * nodeId because one run can visit multiple process nodes via handoffs.
     * Persisted with the conversation state (plain serializable field, like
     * armedSyntheticTools); only replaced at a compaction boundary. Freezing the
     * system prompt makes it a stable provider cache prefix; drift in
     * `${resource:}` / `${kv:}` pills is surfaced as a synthetic `[System
     * update]` tail message instead of mutating the frozen prefix.
     */
    frozenSystemPrompts?: Record<string, string>;
    // Current node ID for stateful execution
    currentNodeId?: string;
    // Flag to indicate if handoff was requested
    handoffRequested?: {
        edgeId: string;
        targetNodeId?: string;
    };
    /**
     * Runtime-only call/return marker for a Process -> terminal Subflow handoff.
     * A one-way Subflow with no explicit successor is semantically a sub-agent:
     * after its child flow completes it returns to the Process node that actually
     * invoked it. The marker is caller-specific (so several Process nodes may
     * share one terminal Subflow), survives debug/approval persistence, and is
     * cleared on the next graph transition. Sequential Subflows never set it.
     */
    pendingSubflowReturn?: {
        subflowNodeId: string;
        callerNodeId: string;
    };
    /** Transient, single-shot caller-supplied prompt captured at a handoff
     *  transition (issue #96) when the model passes a `prompt` argument to a
     *  handoff tool targeting an isolated subflow with `allowCallerPrompt`.
     *  Consumed and cleared by the NEXT node's prep (SubflowNode.prep), matched
     *  by `targetNodeId` so a stale value can never apply to the wrong node.
     *  Never persisted meaningfully across nodes. */
    handoffInput?: {
        targetNodeId: string;
        prompt: string;
        /** Process → Signal (#307): caller-supplied event payload. The
         *  `fromHandoffTool` marker lets SignalNode defensively reject malformed
         *  legacy/parameterless calls without affecting direct traversal. */
        signalBody?: string;
        fromHandoffTool?: boolean;
        /** One entry per handoff tool call the routing model made to this target
         *  in the same assistant turn. Each task becomes one queued execution of
         *  the node's `subflowId`; concurrencyLimit controls only active workers.
         *  Single-shot and node-id-scoped like `prompt`. */
        tasks?: string[];
        /** Legacy Phase 4 (issue #130): caller-chosen fan-out target flow ids.
         *  No handoff tool exposes this parameter anymore (superseded by the
         *  spawn-with-brief `task` calls above — issue #156), but the capture
         *  path still honors it so an old conversation resumed mid-handoff keeps
         *  working. Validated in SubflowNode.prep (unknown ids dropped, capped). */
        parallelFlows?: string[];
        concurrencyLimit?: number;
    };
    // Conversation ID for tracking multiple conversations
    conversationId?: string;
    // Current status of the conversation execution.
    // 'capped' (issue #253): the run hit a Process node's agentic-turn budget and
    // landed gracefully with a forced text-only summary. It is a SUCCESS-like
    // terminal state (distinct from 'error'), so captureVariable/lastOutput
    // chaining still fires on the summary content.
    status?: 'running' | 'awaiting_tool_approval' | 'paused_debug' | 'completed' | 'error' | 'capped';
    // Graceful-landing bookkeeping (issue #253).
    // `forceSummaryTurn` is a one-shot directive set by runFlow when the turn cap
    // fires: the next ProcessNode.prep strips all tools so the model can only
    // produce a text summary. Cleared once the summary turn completes.
    forceSummaryTurn?: boolean;
    // True once the run landed at the turn cap; carried onto the run result.
    capped?: boolean;
    // Why the run was capped (currently only 'maxTurns').
    cappedReason?: 'maxTurns';
    // Per-Process-node effective agentic-turn cap, resolved by ModelHandler and
    // written back in ProcessNode.post, keyed by node id. runFlow reads it to
    // drive the per-node turn counter on the request/response tool loop.
    turnBudgets?: Record<string, number>;
    // Tool calls awaiting user approval
    pendingToolCalls?: OpenAI.ChatCompletionMessageFunctionToolCall[];
    // Flag to indicate if cancellation was requested
    isCancelled?: boolean;
    // --- Added fields for UI listing ---
    title: string;
    createdAt: number; // Timestamp (Date.now())
    updatedAt: number; // Timestamp (Date.now())
    /** Timestamp of the most recent user-role message. Used by the sidebar to
     *  sort conversations by user activity, not AI response activity. Optional
     *  for backward-compatibility with persisted conversations that lack it. */
    lastUserMessageAt?: number;

    // --- Debugger Fields ---
    /** Indicates if the flow is currently running in debug mode. */
    debugMode?: boolean;
    /** Stores the sequence of steps taken during execution for debugging. */
    executionTrace?: DebugStep[];
    /** Whether tool calls require user approval for this conversation. A single
     *  persisted per-conversation setting: the chat UI's "Require Tool Approval"
     *  checkbox writes it immediately (PATCH) and every run/resume reads it live.
     *  Read by the chat loop (OpenAI path) and by self-orchestrating adapters
     *  (Claude subscription) to gate tool calls. */
    requireApproval?: boolean;
    /**
     * Tool permission rules (issue #246): merged at ProcessNode.prep() from the
     * flow's `permissionRules` + per-server `autoApprove` desugaring. Evaluated
     * per-call in ModelHandler.processToolCalls() to allow/deny/ask before
     * dispatching. Reset on each node transition (re-merged from the flow).
     */
    permissionRules?: PermissionRule[];
    /**
     * Saved "always" permission rules (issue #246): user choices from "Always
     * Allow" / "Always Deny" approval prompts. Scoped to this conversation;
     * persisted with the conversation state. Evaluated after `permissionRules`
     * but cannot override a flow-level deny.
     */
    savedPermissionRules?: SavedPermissionRule[];
    /** Unattended execution (issue #218/#339), derived for this run solely from
     *  its invocation source. When true, a Process node that ends its turn on
     *  plain text is driven forward along its single non-returning successor
     *  instead of silently completing the run. Runtime-only: persisted flow
     *  definitions cannot override this value. */
    unattended?: boolean;
    /** Node IDs with an active breakpoint (used by the visual debugger). */
    breakpoints?: string[];
    /** The node we most recently paused at for a breakpoint, so a resume from it does not immediately re-break. */
    lastBreakNodeId?: string;
    /**
     * Tool calls a Process node's model just produced that are waiting to be
     * executed, captured ONLY while single-stepping in the debugger. It lets a
     * step pause *before* running the tools (so the user can inspect the model's
     * tool calls); the next step executes them at the top of the loop and pauses
     * *after* the results come back. Unset during normal (non-debug) runs.
     */
    debugPendingToolCalls?: OpenAI.ChatCompletionMessageFunctionToolCall[];

    /**
     * Maps each model-facing MCP tool name (mcp_<slug>_<hash>, see toolNamespace.ts)
     * back to its (server, tool). Populated when tools are bound for a Process node
     * and persisted so a tool-approval resume (a separate request) can still decode
     * the call. Legacy `_-_-_SERVER_-_-_TOOL` names decode without this map.
     * `timeout` is the source MCP node's per-call timeout in seconds (-1 = none;
     * unset = 5-minute default).
     */
    toolNameMap?: Record<string, { server: string; tool: string; timeout?: number; nodeId?: string; clientGeneration?: number; schemaHash?: string; annotations?: ToolAnnotations; uiResourceUri?: string }>;

    /**
     * Maps each handoff tool's model-facing name (`handoff_to_<slug>`, see
     * handoffNaming.ts) back to its target node id. Handoff tool names no longer
     * embed the node UUID (issue #38, Item A), so routing in
     * ProcessNode.processHandoffToolCalls decodes the call through this map.
     * Repopulated whenever a Process node generates its handoff tools; a
     * tool-approval resume reads the persisted map. Legacy `handoff_to_<uuid>`
     * names (from conversations paused before this change) still decode by
     * stripping the prefix.
     */
    handoffNameMap?: Record<string, string>;
    /** Target node types keyed by node id, populated alongside handoffNameMap so
     *  transition handling can enforce target-specific runtime contracts. */
    handoffTargetTypes?: Record<string, string>;

    // --- Token / cost accounting (aggregated from per-message usage) ---
    /** Running totals of token usage and estimated cost for this conversation. */
    usage?: UsageTotals;

    /**
     * Depth of this run in the subflow-call tree (0 for a top-level run). Set by
     * runFlow from FlowRunInput.depth; a SubflowNode passes runDepth + 1 to the
     * child run, and runFlow refuses to start a run past MAX_SUBFLOW_DEPTH. This
     * is the re-entrancy guard against infinite subflow recursion.
     */
    runDepth?: number;

    /**
     * Conversation id of the run that spawned this one (subflow child runs).
     * Cancellation propagates DOWN the run tree through this link: runFlow's
     * loop guard walks the ancestor chain and stops the child once any
     * ancestor's isCancelled flag is set (issue #109). Unset for top-level runs.
     */
    parentRunId?: string;

    /**
     * Conversation-level parent link (issue #182): the conversationId of the
     * conversation that spawned this one (subflow child conversations). This is
     * the conversation-record equivalent of `parentRunId` (set on the same
     * subflow-invocation path), surfaced explicitly so the chat sidebar can
     * render Flow->Subflow->... chains without reverse-engineering run internals.
     * Additive/optional: a conversation without it renders as a root, so no
     * migration of existing db/conversations/*.json is needed. `parentRunId`
     * still drives cancellation ancestry; this field is purely for the sidebar.
     */
    parentConversationId?: string;

    /**
     * Top-level conversation of this chain (issue #182): computed eagerly at
     * creation as `parent.rootConversationId ?? parent.conversationId`, so the
     * sidebar can bucket a whole chain by root in O(1) without walking the
     * ancestor chain on every list request. Unset (or equal to its own id) for
     * a top-level conversation.
     */
    rootConversationId?: string;

    /**
     * Where this run originated (issue #113/#339). Set by runFlow from the
     * required FlowRunInput.source at every run boundary and surfaced read-only
     * by GET /api/runs/active. Optional only for persisted legacy states created
     * before the invocation-context contract existed.
     */
    source?: FlowInvocationSource;

    /**
     * For scheduler-originated runs (source === 'schedule'): the planned
     * execution id that fired this run (issue #113). Unset otherwise.
     */
    plannedExecutionId?: string;

    /**
     * Event-chain depth of this run (issue #116/#117). 0 for an organic run
     * (chat/API/manual, or any scheduled/webhook/file/poll fire); +1 per
     * flow-event hop. Threaded in from FlowRunInput.chainDepth so a `signal`
     * node mid-run (SignalNode.post) can stamp the emitting run's depth onto the
     * event it publishes, and a subflow child inherits the parent's depth. The
     * downstream `flow-event` trigger increments it and enforces maxChainDepth,
     * breaking runaway A→B→A loops. Distinct from runFlow's subflow `runDepth`.
     */
    chainDepth?: number;

    /**
     * Headless approval policy (issue #115): what a run with no interactive
     * approver does when it reaches a tool that needs approval. 'auto' runs the
     * tool (legacy behavior), 'fail' ends the run with a structured
     * approval-required error, 'pause' parks the run (awaiting_tool_approval)
     * for later resume via /api/approvals. Only consulted when requireApproval
     * is true. Threaded in from FlowRunInput.onApprovalRequired and persisted so
     * a resumed 'pause' run keeps re-pausing on later tool calls. Default 'auto'.
     */
    onApprovalRequired?: 'auto' | 'fail' | 'pause';

    /**
     * True for a transient run (subflow child, future scheduler runs): this
     * state must NEVER reach the conversations/* store, so it never appears in
     * the chat sidebar. The policy travels ON the state and is enforced inside
     * persistConversationState (the single chokepoint) — call-site guards
     * proved leaky (a Claude-adapter incremental persist wrote a subflow child
     * to disk). Set by runFlow from FlowRunInput.mode; never unset.
     */
    ephemeral?: boolean;

    /**
     * Transient emit callback for execution events, attached for the duration
     * of a single step by the engine. NOT persisted (functions are dropped by
     * JSON serialization and it is deleted after each step).
     */
    emit?: EmitFn;
}


// Handoff tool information
export interface HandoffToolInfo {
    edgeId: string;
    targetNodeId: string;
    targetNodeLabel: string;
}

// Tool definition
export interface ToolDefinition {
    name: string;
    originalName?: string;
    /** Source MCP server, used to decode the model-facing name back to (server, tool). */
    server?: string;
    /** MCP node that advertised this tool, for per-node confinement. */
    nodeId?: string;
    /** Per-call timeout in seconds from the tool's MCP node (-1 = no timeout;
     *  unset = 5-minute default). Carried into SharedState.toolNameMap. */
    timeout?: number;
    description?: string;
    inputSchema: Record<string, unknown>;
    /** Issue #255 — identity captured at advertise time; copied into
     *  SharedState.toolNameMap so a stale dispatch can be detected. */
    clientGeneration?: number;
    schemaHash?: string;
    /** Server-declared MCP safety hints, preserved for agentic adapters. */
    annotations?: ToolAnnotations;
    /** MCP Apps UI resource declared on this tool definition. */
    uiResourceUri?: string;
}

// MCP Context
export interface MCPContext {
    server: string;
    availableTools: ToolDefinition[];
}

// Tool call information
export interface ToolCallInfo {
    name: string;
    args: Record<string, unknown>;
    id: string;
    result: string;
}

// Error details
export interface ErrorDetails {
    message: string;
    name?: string;
    type?: string;
    code?: string;
    param?: string;
    status?: number;
    stack?: string;
}

// Base prep result
export interface BasePrepResult {
    nodeId: string;
    nodeType: NodeType;
}

// StartNode prep result
export interface StartNodePrepResult extends BasePrepResult {
    nodeType: 'start';
    systemPrompt: string;
}

// ProcessNode prep result
export interface ProcessNodePrepResult extends BasePrepResult {
    nodeType: 'process';
    currentPrompt: string;
    boundModel: string;
    modelDisplayName?: string;
    availableTools?: ToolDefinition[];
    mcpContext?: MCPContext;
    messages: FlujoChatMessage[]; // Use timestamped type
    /** The scoped view actually sent to the model when `inputMode` is not
     *  'full-history'. `messages` above stays the lossless threaded history (it
     *  is written back to SharedState by post); this narrows only what the
     *  provider sees. Unset ⇒ the model sees `messages` verbatim. */
    wireMessages?: FlujoChatMessage[];
    toolCalls?: ToolCallInfo[];
    /** Conversation id, forwarded so self-orchestrating adapters can surface
     *  mid-run tool-approval prompts on the conversation's event stream. */
    conversationId?: string;
    /** Metadata-only logical run id for model/tool attribution. */
    runId?: string;
    /** Whether tool calls require user approval (mirrors the run's requireApproval).
     *  Self-orchestrating adapters (Claude subscription) consult this in canUseTool. */
    requireToolApproval?: boolean;
    /** Unattended run (issue #258): forwarded so the synthetic `question` tool
     *  degrades to a tool-error instead of blocking for an answer. */
    unattended?: boolean;
    /** Graceful landing (issue #253): set from SharedState.forceSummaryTurn when
     *  the turn cap fired. When true, execCore sends NO tools so the model can
     *  only produce a final text summary. */
    forceSummaryTurn?: boolean;
    /** Debugger model-input visualization (issue #153). Computed in prep (where
    *  the threaded/folded/scoped views are all in scope) and promoted onto the
    *  DebugStep by FlowExecutor. Populated only when the run is in debug mode /
    *  the execution tracker is on; unset otherwise so normal runs pay nothing. */
    modelInput?: ModelInputSnapshot;
    /** Issue #167 (Phase 2 of #162): every per-model-call wire snapshot this
     *  node produced during the visit, in call order (see DebugStep.modelInputs).
     *  `modelInput` above is the first/representative entry. Same debug gate. */
    modelInputs?: ModelInputSnapshot[];
    /** Durable Codex session for this node and a state-owned replacement hook. */
    codexSession?: CodexSessionMetadata;
    onCodexSessionChange?: (session: CodexSessionMetadata | undefined) => void;
}

// FinishNode prep result
export interface FinishNodePrepResult extends BasePrepResult {
    nodeType: 'finish';
    messages: FlujoChatMessage[]; // Use timestamped type
}

// MCPNode prep result
export interface MCPNodePrepResult extends BasePrepResult {
    nodeType: 'mcp';
    mcpServer: string;
    enabledTools: string[];
    /** Node-level workspace folders (MCP roots) to overlay on the bound server (issue 46). */
    nodeRoots?: string[];
}

// SubflowNode prep result
export interface SubflowNodePrepResult extends BasePrepResult {
    nodeType: 'subflow';
    subflowId?: string;
    /** Explicit prompt passed into the subflow (set only when the node has a
     *  promptTemplate override). Mutually exclusive with `messages`. */
    inputText?: string;
    /** Sanitized parent conversation passed into the subflow (the default when
     *  there is no promptTemplate override). FLUJO plumbing — system prompt and
     *  tool calls/results — is stripped so the child runs with genuine context
     *  and injects its own system prompt. In 'latest-message' inputMode this is
     *  narrowed to just the most recent user instruction (issue #74). */
    messages?: FlujoChatMessage[];
    /** This run's depth in the subflow-call tree (parent depth + 1). */
    depth: number;
    /** The parent run's event-chain depth (issue #117), passed unchanged to the
     *  child so a `signal` node inside the subflow emits at the parent chain's
     *  depth (a subflow call is not an event hop). Keeps maxChainDepth effective
     *  for signals nested in subflows. */
    chainDepth?: number;
    /** Parent conversation id, for nesting provenance. */
    parentRunId?: string;
    /** The parent run's planned-execution id (issue #220), passed unchanged to
     *  each child run so a persisted sub-flow conversation inherits the parent's
     *  wave membership instead of falling into the "Ad-hoc" bucket. Undefined for
     *  ad-hoc parent runs (no wave), which keeps the child ad-hoc too. */
    plannedExecutionId?: string;
    /** Whether the child run's events are folded into the parent conversation
     *  (outputMode 'steps', the default) or hidden ('final-only'). */
    showSteps: boolean;
    /** Debugging (issue #125): when true, the single-child run is executed in
     *  runFlow `mode: 'conversation'` so it persists as its own sidebar
     *  conversation; otherwise it runs ephemerally. Applied per parallel lane
     *  too (issue #156 defect 1) — each spawn/fan-out/map lane persists as its
     *  own sidebar conversation when enabled. */
    persistConversation?: boolean;
    /** The parent run's emit (captured from sharedState during prep): child
     *  events are forwarded through it onto the PARENT's channel/log with
     *  depth + 1. Transient — stripped from debug snapshots, never persisted. */
    emit?: EmitFn;
    /** Display name of the child flow (for subflow:start events / attribution). */
    subflowName?: string;
    /** Display name of this node (for subflow event attribution). */
    nodeName?: string;
    /** Resolved child-job queue. Present for ordinary one-child execution and
     *  repeated model handoffs alike. Deprecated fan-out/map configurations are
     *  normalized here for saved-flow compatibility. */
    lanes?: SubflowLanePlan[];
    /** True when prep resolved this node in map-over-list mode (Tier 2a). Lets
     *  execCore treat an EMPTY `lanes` as a clean "nothing to map" result rather
     *  than falling through to the single-child path. */
    mapOverList?: boolean;
    /** True when prep resolved this node as a DYNAMIC fan-out (issue #130,
     *  `parallelSubflowIdsVar`) that, after validating ids against the flows
     *  store, produced ZERO runnable lanes. Like `mapOverList`, it lets execCore
     *  fold a clean empty result instead of falling through to the single-child
     *  path. */
    fanOutResolvedEmpty?: boolean;
    /** Set when the lane plan FAILED to resolve in a way the user/model must
     *  see (issue #156 defect 2: a caller-requested fan-out set naming only
     *  nonexistent flows). execCore returns this as a real error — never the
     *  old silent zero-lane success. */
    laneResolutionError?: string;
    /** Maximum simultaneous workers; never a total-job limit (default 4). */
    concurrencyLimit?: number;
    /** Separator used to join lane outputs in child order (default "\n\n"). */
    joinSeparator?: string;
    /** Error handling strategy for parallel mode (default 'collect-all'). */
    errorStrategy?: 'fail-fast' | 'collect-all';
    /** Result presentation mode for parallel subflows (issue #359):
     *  'separate' or 'joined' (default 'joined' when absent for back-compat). */
    resultPresentation?: 'separate' | 'joined';
    /** Durable parent join record backing this execution, when recoverable. */
    invocationId?: string;
}

// Union type for all prep results
export type PrepResult = StartNodePrepResult | ProcessNodePrepResult | FinishNodePrepResult | MCPNodePrepResult | SubflowNodePrepResult;

// Base exec result
export interface BaseExecResult {
    success: boolean;
}

// StartNode exec result
// StartNode typically just passes through the base result.
export type StartNodeExecResult = BaseExecResult;

// ProcessNode exec result
export interface ProcessNodeExecResult extends BaseExecResult {
    content?: string;
    error?: string;
    errorDetails?: ErrorDetails;
    fullResponse?: OpenAI.ChatCompletion;
    toolCalls?: ToolCallInfo[];
    messages?: FlujoChatMessage[]; // Use timestamped type
    /** The effective agentic-turn cap ModelHandler resolved for this call
     *  (issue #253). post() writes it onto SharedState.turnBudgets so runFlow
     *  can enforce the cap on the request/response tool loop. */
    effectiveMaxTurns?: number;
    /**
     * The provider rejected tool use, so execCore safely retried this node
     * without its handoff-only tool block. post() uses this marker to traverse
     * a sole unconditional control edge without requiring a handoff call.
     * Conditioned edges continue through their normal deterministic router.
     */
    usedToolFreeFallback?: boolean;
}

// FinishNode exec result
// FinishNode typically just passes through the base result.
export type FinishNodeExecResult = BaseExecResult;

// MCPNode exec result
export interface MCPNodeExecResult extends BaseExecResult {
    server?: string;
    tools?: ToolDefinition[];
    enabledTools?: string[];
    error?: string;
}

// SubflowNode exec result
export interface SubflowNodeExecResult extends BaseExecResult {
    /** Final assistant text produced by the subflow run. */
    outputText?: string;
    /** Generated media produced by the subflow run. */
    outputMedia?: ModelMediaPart[];
    error?: string;
    errorDetails?: ErrorDetails;
    /** The subflow run's terminal status (completed/error). */
    subStatus?: string;
    /** Per-lane results in parallel mode (issue #102), in child order. */
    lanes?: SubflowLaneResult[];
    /** True when SOME (but not all) lanes succeeded under 'collect-all'. */
    partial?: boolean;
}

// Union type for all exec results
export type ExecResult = StartNodeExecResult | ProcessNodeExecResult | FinishNodeExecResult | MCPNodeExecResult | SubflowNodeExecResult;

// Action constants for flow control
export const TOOL_CALL_ACTION = 'TOOL_CALL';
export const FINAL_RESPONSE_ACTION = 'FINAL_RESPONSE';
export const ERROR_ACTION = 'ERROR';
export const STAY_ON_NODE_ACTION = "STAY_ON_NODE";
/** Internal handoff emitted by a terminal one-way Subflow to resume its caller. */
export const IMPLICIT_SUBFLOW_RETURN_ACTION = 'IMPLICIT_SUBFLOW_RETURN';
// Handoff action is the edgeId string itself
