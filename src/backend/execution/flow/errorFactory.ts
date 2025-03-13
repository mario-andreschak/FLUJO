import { 
  FlowError, 
  ModelError, 
  ToolError, 
  NodeError, 
  MCPError 
} from './errors';

export const createModelError = (
  code: string,
  message: string,
  modelId: string,
  requestId?: string,
  details?: Record<string, unknown>
): ModelError => ({
  type: 'model',
  code,
  message,
  modelId,
  requestId,
  details
});

export const createToolError = (
  code: string,
  message: string,
  toolName: string,
  toolArgs?: Record<string, unknown>,
  details?: Record<string, unknown>
): ToolError => ({
  type: 'tool',
  code,
  message,
  toolName,
  toolArgs,
  details
});

export const createNodeError = (
  code: string,
  message: string,
  nodeId: string,
  nodeType: string,
  details?: Record<string, unknown>
): NodeError => ({
  type: 'node',
  code,
  message,
  nodeId,
  nodeType,
  details
});

export const createMCPError = (
  code: string,
  message: string,
  serverName: string,
  operation: string,
  details?: Record<string, unknown>
): MCPError => ({
  type: 'mcp',
  code,
  message,
  serverName,
  operation,
  details
});
