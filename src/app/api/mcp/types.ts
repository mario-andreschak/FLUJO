import { z } from 'zod';
import { ToolSchema } from '@modelcontextprotocol/sdk/types.js';
import { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';

// Constants
export const SERVER_DIR_PREFIX = 'mcp-servers';
export type MCPManagerConfig = {
  name: string;
  disabled: boolean;
  autoApprove: string[];
  rootPath: string;
  env: Record <string, string>
  _buildCommand: string;
  _installCommand: string;
}
// Types
export type MCPStdioConfig = StdioServerParameters & MCPManagerConfig & {
  transport: 'stdio';
};

export type MCPWebSocketConfig = MCPManagerConfig & { // there is no WebSocketServerParameters so we cant include anything here
  transport: 'websocket';
  websocketUrl: string;
};

export type MCPServerConfig = MCPStdioConfig | MCPWebSocketConfig;

export interface ServiceResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

// Using the official type from MCP SDK
export type ToolResponse = z.infer<typeof ToolSchema>;

export interface ConnectionAttempt {
  requestId: string;
  timestamp: number;
  status: 'pending' | 'success' | 'failed';
  error?: string;
}
