import { NodeType } from '@/shared/types/flow/flow';
import { NodeExecutionTrackerEntry } from '@/shared/types/flow/response';
import { ChatCompletionMessageParam, ChatCompletion } from 'openai/resources/chat/completions/completions';

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
    // Messages as the single source of truth
    messages: ChatCompletionMessageParam[];
    // Flow ID needed by some nodes
    flowId: string;
    // Last response from the model
    lastResponse?: string | Record<string, unknown>;
    // MCP context for tool handling
    mcpContext?: MCPContext;
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
    messages: ChatCompletionMessageParam[];
    toolCalls?: ToolCallInfo[];
}

// FinishNode prep result
export interface FinishNodePrepResult extends BasePrepResult {
    nodeType: 'finish';
    messages: ChatCompletionMessageParam[];
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
    fullResponse?: ChatCompletion;
    toolCalls?: ToolCallInfo[];
    messages?: ChatCompletionMessageParam[];
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
