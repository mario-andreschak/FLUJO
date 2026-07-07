import { ToolDefinition } from '../types';

// Input for MCP execution
export interface MCPExecutionInput {
  mcpServer: string;
  enabledTools: string[];
  mcpEnv?: Record<string, string>;
  /** Id of the FlowBuilder MCP node driving this execution — keys its node-roots
   *  registration (issue 46). */
  nodeId?: string;
  /** Node-level workspace folders (MCP roots) to overlay on the bound server. Passing
   *  an empty list clears a previous registration for this node. */
  nodeRoots?: string[];
}

// Result of MCP execution
export interface MCPExecutionResult {
  server: string;
  tools: ToolDefinition[];
  enabledTools: string[];
}
