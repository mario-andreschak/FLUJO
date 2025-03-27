import { z } from 'zod';
import { ToolSchema } from '@modelcontextprotocol/sdk/types.js';

// Define the StdioServerParameters type ourselves to avoid import issues
type StdioServerParameters = {
  command: string;
  args: string[];
  stderr: string;
  env?: Record<string, string>;
};

// Constants
export const SERVER_DIR_PREFIX = 'mcp-servers';

// Types
export type EnvVarValue = string | { 
  value: string | number | boolean; 
  metadata?: { 
    isSecret: boolean 
  } 
};

export type MCPManagerConfig = {
  name: string;
  disabled: boolean;
  autoApprove: string[];
  rootPath: string;
  env: Record<string, any>
  _buildCommand: string;
  _installCommand: string;
}

export type MCPStdioConfig = StdioServerParameters & MCPManagerConfig & {
  transport: 'stdio';
  command: string;
  args: string[];
  stderr: string;
};

export type MCPWebSocketConfig = MCPManagerConfig & {
  transport: 'websocket';
  websocketUrl: string;
};

export type MCPServerConfig = MCPStdioConfig | MCPWebSocketConfig;

export interface MCPServiceResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  statusCode?: number;
  progressToken?: string;
  errorType?: string;
  toolName?: string;
  timeout?: number;
}

// Using the official type from MCP SDK
export type MCPToolResponse = z.infer<typeof ToolSchema>;

export interface MCPConnectionAttempt {
  requestId: string;
  timestamp: number;
  status: 'pending' | 'success' | 'failed';
  error?: string;
}

// Define ServerState as an intersection type
export type MCPServerState = MCPServerConfig & {
  status: 'connected' | 'disconnected' | 'error' | 'connecting' | 'initialization';
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, any>;
  }>;
  error?: string;
  stderrOutput?: string;
};
