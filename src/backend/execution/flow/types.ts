import { NodeType, Flow } from '@/shared/types/flow/flow';
import { NodeExecutionTrackerEntry } from '@/shared/types/flow/response';
import { FlujoChatMessage } from '@/shared/types/chat';
import { EmitFn, UsageTotals } from '@/shared/types/execution/events';
import { EdgeCondition } from '@/utils/shared/edgeConditions';
import OpenAI from 'openai';

// --- Custom Chat Message Type is now imported from shared/types/chat.ts ---


// --- Debugger Types ---

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
}

// FinishNode specific properties
export interface FinishNodeProperties {
    name?: string;
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
    /** Opt-in (issue #96): only meaningful in 'isolated' inputMode. When true,
     *  the handoff tool that targets this node exposes an optional `prompt`
     *  string parameter; a caller-supplied value OVERRIDES `promptTemplate`
     *  (which becomes the default/fallback used when the caller passes none).
     *  Defaults to false — existing isolated subflows keep sending their static
     *  prompt and their handoff tools stay parameter-less. Groundwork for
     *  running subflows as independent, callable workers. */
    allowCallerPrompt?: boolean;
    /** Fan-out / join (issue #102): when this list has >=1 entry, the node runs
     *  SEVERAL child flows CONCURRENTLY and joins their outputs, instead of the
     *  single-`subflowId` path. Empty/absent => today's single-child behavior
     *  (the default path is completely unchanged). The same resolved input
     *  (per `inputMode`) is fanned out to every lane. */
    parallelSubflowIds?: string[];
    /** Max child flows run at once in parallel mode (bounded worker pool). Default 4. */
    concurrencyLimit?: number;
    /** String placed between joined lane outputs (child order) in parallel mode.
     *  Default "\n\n". */
    joinSeparator?: string;
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
}

/** One resolved lane in a SubflowNode plan: a fan-out child (issue #102) or a
 *  map-over-list per-item run (Tier 2a). */
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
}

/** The outcome of one fan-out lane (issue #102), kept in child order. */
export interface SubflowLaneResult {
    subflowId: string;
    success: boolean;
    outputText?: string;
    error?: string;
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

// Union type for all node params
export type NodeParams = StartNodeParams | ProcessNodeParams | FinishNodeParams | MCPNodeParams | SubflowNodeParams | ResourceNodeParams;

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
    };
}

// Flow parameters
export interface FlowParams {
    flowId: string;
    flowName: string;
    nodeParams?: Record<string, NodeParams>;
}

// Shared state (minimized)
export interface SharedState {
    // Only tracking info in shared state
    trackingInfo: {
        executionId: string;
        startTime: number;
        nodeExecutionTracker: NodeExecutionTrackerEntry[];
    };
    // Messages as the single source of truth, now using our timestamped type
    messages: FlujoChatMessage[];
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
    // MCP context for tool handling
    mcpContext?: MCPContext;
    // Current node ID for stateful execution
    currentNodeId?: string;
    // Flag to indicate if handoff was requested
    handoffRequested?: {
        edgeId: string;
        targetNodeId?: string;
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
    };
    // Conversation ID for tracking multiple conversations
    conversationId?: string;
    // Current status of the conversation execution
    status?: 'running' | 'awaiting_tool_approval' | 'paused_debug' | 'completed' | 'error'; // Added 'paused_debug'
    // Tool calls awaiting user approval
    pendingToolCalls?: OpenAI.ChatCompletionMessageToolCall[];
    // Flag to indicate if cancellation was requested
    isCancelled?: boolean;
    // --- Added fields for UI listing ---
    title: string;
    createdAt: number; // Timestamp (Date.now())
    updatedAt: number; // Timestamp (Date.now())

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
    debugPendingToolCalls?: OpenAI.ChatCompletionMessageToolCall[];

    /**
     * Maps each model-facing MCP tool name (mcp_<slug>_<hash>, see toolNamespace.ts)
     * back to its (server, tool). Populated when tools are bound for a Process node
     * and persisted so a tool-approval resume (a separate request) can still decode
     * the call. Legacy `_-_-_SERVER_-_-_TOOL` names decode without this map.
     * `timeout` is the source MCP node's per-call timeout in seconds (-1 = none;
     * unset = 5-minute default).
     */
    toolNameMap?: Record<string, { server: string; tool: string; timeout?: number }>;

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
    /** Per-call timeout in seconds from the tool's MCP node (-1 = no timeout;
     *  unset = 5-minute default). Carried into SharedState.toolNameMap. */
    timeout?: number;
    description?: string;
    inputSchema: Record<string, unknown>;
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
    /** Whether tool calls require user approval (mirrors the run's requireApproval).
     *  Self-orchestrating adapters (Claude subscription) consult this in canUseTool. */
    requireToolApproval?: boolean;
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
    /** Parent conversation id, for nesting provenance. */
    parentRunId?: string;
    /** Whether the child run's events are folded into the parent conversation
     *  (outputMode 'steps', the default) or hidden ('final-only'). */
    showSteps: boolean;
    /** The parent run's emit (captured from sharedState during prep): child
     *  events are forwarded through it onto the PARENT's channel/log with
     *  depth + 1. Transient — stripped from debug snapshots, never persisted. */
    emit?: EmitFn;
    /** Display name of the child flow (for subflow:start events / attribution). */
    subflowName?: string;
    /** Display name of this node (for subflow event attribution). */
    nodeName?: string;
    /** Resolved lane plan. Present in parallel fan-out mode (issue #102,
     *  parallelSubflowIds non-empty) or map-over-list mode (Tier 2a); each entry
     *  is one child run. Fed to the same bounded worker pool either way. */
    lanes?: SubflowLanePlan[];
    /** True when prep resolved this node in map-over-list mode (Tier 2a). Lets
     *  execCore treat an EMPTY `lanes` as a clean "nothing to map" result rather
     *  than falling through to the single-child path. */
    mapOverList?: boolean;
    /** Bounded worker-pool size for parallel mode (default 4). */
    concurrencyLimit?: number;
    /** Separator used to join lane outputs in child order (default "\n\n"). */
    joinSeparator?: string;
    /** Error handling strategy for parallel mode (default 'collect-all'). */
    errorStrategy?: 'fail-fast' | 'collect-all';
}

// Union type for all prep results
export type PrepResult = StartNodePrepResult | ProcessNodePrepResult | FinishNodePrepResult | MCPNodePrepResult | SubflowNodePrepResult;

// Base exec result
export interface BaseExecResult {
    success: boolean;
}

// StartNode exec result
export interface StartNodeExecResult extends BaseExecResult {
    // StartNode typically just passes through the prep result
}

// ProcessNode exec result
export interface ProcessNodeExecResult extends BaseExecResult {
    content?: string;
    error?: string;
    errorDetails?: ErrorDetails;
    fullResponse?: OpenAI.ChatCompletion;
    toolCalls?: ToolCallInfo[];
    messages?: FlujoChatMessage[]; // Use timestamped type
}

// FinishNode exec result
export interface FinishNodeExecResult extends BaseExecResult {
    // FinishNode typically just passes through the prep result
}

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
// Handoff action is the edgeId string itself
