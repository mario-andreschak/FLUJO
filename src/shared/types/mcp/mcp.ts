import { z } from 'zod';
import { ToolSchema } from '@modelcontextprotocol/sdk/types.js';
import { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';

// Constants
export const SERVER_DIR_PREFIX = 'mcp-servers';

// Types
export type MCPManagerConfig = {
  name: string;
  disabled: boolean;
  autoApprove: string[];
  rootPath: string;
  env: Record<string, string>
  _buildCommand: string;
  _installCommand: string;
}

export type MCPStdioConfig = StdioServerParameters & MCPManagerConfig & {
  transport: 'stdio';
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
