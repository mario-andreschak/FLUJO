import { z } from 'zod';
import { ToolSchema } from '@modelcontextprotocol/sdk/types.js';
import { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransportOptions } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransportOptions } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { OAuthClientMetadata, OAuthClientInformation, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

// Constants
export const SERVER_DIR_PREFIX = 'mcp-servers';

// Types
export type EnvVarValue = string | { 
  value: string; 
  metadata: { 
    isSecret: boolean 
  } 
};

export type MCPManagerConfig = {
  name: string;
  disabled: boolean;
  autoApprove: string[];
  rootPath: string;
  env: Record<string, EnvVarValue>
  _buildCommand: string;
  _installCommand: string;
}

export type MCPStdioConfig = StdioServerParameters & MCPManagerConfig & {
  transport: 'stdio';
};

export type MCPSSEConfig = SSEClientTransportOptions & MCPManagerConfig & {
  transport: 'sse';
  serverUrl: string;
  // Custom HTTP headers sent on every request (e.g. Authorization, X-SAP-System-Id).
  headers?: Record<string, string>;
};

export type MCPStreamableConfig = StreamableHTTPClientTransportOptions & MCPManagerConfig & {
  transport: 'streamable';
  serverUrl: string;
  // Custom HTTP headers sent on every request (e.g. Authorization, X-SAP-System-Id).
  headers?: Record<string, string>;
  // OAuth configuration fields
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthScopes?: string[];
  // Stored OAuth data
  oauthClientMetadata?: OAuthClientMetadata;
  oauthClientInformation?: OAuthClientInformation;
  oauthTokens?: OAuthTokens;
  oauthCodeVerifier?: string;
  authorizationUrl?: string; // OAuth authorization URL when authentication is required
};

export type MCPWebSocketConfig = MCPManagerConfig & {
  transport: 'websocket';
  websocketUrl: string;
};

export type MCPServerConfig = MCPStdioConfig | MCPWebSocketConfig | MCPSSEConfig | MCPStreamableConfig;

export interface MCPServiceResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  statusCode?: number;
  progressToken?: string;
  errorType?: string;
  toolName?: string;
  timeout?: number;
  requiresAuthentication?: boolean;
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
  status: 'connected' | 'disconnected' | 'error' | 'connecting' | 'initialization' | 'requires_authentication';
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, any>;
  }>;
  error?: string;
  stderrOutput?: string;
  authorizationUrl?: string; // OAuth authorization URL when authentication is required
};
