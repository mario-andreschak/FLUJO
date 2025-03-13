// Base error interface
export interface FlowError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

// Model-related errors
export interface ModelError extends FlowError {
  type: 'model';
  modelId: string;
  requestId?: string;
}

// Tool-related errors
export interface ToolError extends FlowError {
  type: 'tool';
  toolName: string;
  toolArgs?: Record<string, unknown>;
}

// Node-related errors
export interface NodeError extends FlowError {
  type: 'node';
  nodeId: string;
  nodeType: string;
}

// MCP-related errors
export interface MCPError extends FlowError {
  type: 'mcp';
  serverName: string;
  operation: string;
}

// Union type for all errors
export type ExecutionError = ModelError | ToolError | NodeError | MCPError;

// Result type for operations that can fail
export type Result<T> = 
  | { success: true; value: T }
  | { success: false; error: ExecutionError };
