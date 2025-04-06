import { NodeType } from '@/shared/types/flow/flow';
import { NodeExecutionTrackerEntry } from '@/shared/types/flow/response';
import { FlujoChatMessage } from '@/shared/types/chat';
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
    promptTemplate?: string;
    excludeModelPrompt?: boolean;
    excludeStartNodePrompt?: boolean;
    boundModel?: string;
    allowedTools?: string[];
    mcpNodes?: MCPNodeReference[];
}

// FinishNode specific properties
export interface FinishNodeProperties {
    name?: string;
}

// MCPNode specific properties
export interface MCPNodeProperties {
    name?: string;
    boundServer?: string;
    enabledTools?: string[];
    env?: Record<string, string>;
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

// Union type for all node params
export type NodeParams = StartNodeParams | ProcessNodeParams | FinishNodeParams | MCPNodeParams;

// MCP Node Reference (used in ProcessNode)
export interface MCPNodeReference {
    id: string;
    properties: {
        boundServer?: string;
        enabledTools?: string[];
        env?: Record<string, string>;
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
    /** Stores the original requireApproval setting from the request that initiated the debug session. */
    originalRequireApproval?: boolean;
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
    mcpEnv?: Record<string, string>;
}

// Union type for all prep results
export type PrepResult = StartNodePrepResult | ProcessNodePrepResult | FinishNodePrepResult | MCPNodePrepResult;

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

// Union type for all exec results
export type ExecResult = StartNodeExecResult | ProcessNodeExecResult | FinishNodeExecResult | MCPNodeExecResult;

// Action constants for flow control
export const TOOL_CALL_ACTION = 'TOOL_CALL';
export const FINAL_RESPONSE_ACTION = 'FINAL_RESPONSE';
export const ERROR_ACTION = 'ERROR';
export const STAY_ON_NODE_ACTION = "STAY_ON_NODE";
// Handoff action is the edgeId string itself
