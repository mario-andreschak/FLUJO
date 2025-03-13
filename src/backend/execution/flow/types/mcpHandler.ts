import { ToolDefinition } from '../types';

// Input for MCP execution
export interface MCPExecutionInput {
  mcpServer: string;
  enabledTools: string[];
  mcpEnv?: Record<string, string>;
}

// Result of MCP execution
export interface MCPExecutionResult {
  server: string;
  tools: ToolDefinition[];
  enabledTools: string[];
}
