import { NodeType } from '@/shared/types/flow/flow';
import { NodeExecutionTrackerEntry } from '@/shared/types/flow/response';
import { FlujoChatMessage } from '@/shared/types/chat';
import { EmitFn, UsageTotals } from '@/shared/types/execution/events';
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
    boundModel?: string;
    allowedTools?: string[];
    mcpNodes?: MCPNodeReference[];
    /**
     * Per-node override of the bound model's Max Turns cap (agentic turns for
     * self-orchestrating adapters). Unset/0 = inherit the model setting, then
     * the system default (DEFAULT_AGENTIC_MAX_TURNS = 50).
     */
    maxTurns?: number;
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
    /** Optional explicit input passed to the subflow as its user prompt. When
     *  empty, the subflow receives the parent conversation's latest message
     *  text. (Named-variable templating is a later enhancement.) */
    promptTemplate?: string;
    /** Output visibility: 'steps' (default) folds the child run's events into
     *  the parent conversation's live stream + log, nested by depth;
     *  'final-only' shows only the folded final output message. */
    outputMode?: 'steps' | 'final-only';
}

// Type-specific node params
export interface StartNodeParams extends BaseNodeParams<StartNodeProperties> {
    type: 'start';
}

export interface ProcessNodeParams extends BaseNodeParams<ProcessNodeProperties> {
    type: 'process';
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

// Union type for all node params
export type NodeParams = StartNodeParams | ProcessNodeParams | FinishNodeParams | MCPNodeParams | SubflowNodeParams;

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
    // Last response from the model
    lastResponse?: string | Record<string, unknown>;
    // MCP context for tool handling
    mcpContext?: MCPContext;
    // Current node ID for stateful execution
    currentNodeId?: string;
    // Flag to indicate if handoff was requested
    handoffRequested?: {
        edgeId: string;
        targetNodeId?: string;
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
    /** Sanitized parent conversation history passed into the subflow (the
     *  default when there is no promptTemplate override). FLUJO plumbing —
     *  system prompt, tool calls/results, and the synthetic handoff "Continue"
     *  message — is stripped so the child runs with genuine context and injects
     *  its own system prompt. */
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
}

// Union type for all exec results
export type ExecResult = StartNodeExecResult | ProcessNodeExecResult | FinishNodeExecResult | MCPNodeExecResult | SubflowNodeExecResult;

// Action constants for flow control
export const TOOL_CALL_ACTION = 'TOOL_CALL';
export const FINAL_RESPONSE_ACTION = 'FINAL_RESPONSE';
export const ERROR_ACTION = 'ERROR';
export const STAY_ON_NODE_ACTION = "STAY_ON_NODE";
// Handoff action is the edgeId string itself
