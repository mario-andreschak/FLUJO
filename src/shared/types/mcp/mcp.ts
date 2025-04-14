import { z } from 'zod';
import { ToolSchema } from '@modelcontextprotocol/sdk/types.js';
import { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
// import { StreamableHTTPClientTransport, StreamableHTTPClientTransportOptions } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StreamableHTTPClientTransportOptions } from '@/temp/typescript-sdk/dist/esm/client/streamableHttp.js'
import { SSEClientTransportOptions } from '@modelcontextprotocol/sdk/client/sse.js';

// Constants
export const SERVER_DIR_PREFIX = 'mcp-servers';

// Types
export type EnvVarValue = string | { 
  value: string; 
  metadata: { 
    isSecret: boolean 
  } 
};

export type MCPManagerConfig = { // TODO: replace with new ToolAnnotations
  name: string;
  disabled: boolean;
  autoApprove: string[];
  rootPath: string;
  env: Record<string, EnvVarValue>
  _buildCommand: string;
  _installCommand: string;
  transporttype: MCPStdioConfig["transport"] | MCPWebSocketConfig["transport"] | MCPStreamableHttpConfig["transport"] | MCPHttpSseConfig["transport"] | MCPDockerConfig["transport"]
}

export type MCPStdioConfig = StdioServerParameters & MCPManagerConfig & { 
  transport: 'stdio';
};

export type MCPWebSocketConfig = MCPManagerConfig & {
  transport: 'websocket';
  websocketUrl: string;
};

export type MCPDockerConfig = MCPManagerConfig & {
  transport: 'docker';
  image: string;         // Docker image name (e.g., 'ghcr.io/github/github-mcp-server')
  containerName?: string; // Optional custom container name
  transportMethod: MCPManagerConfig["transporttype"];
  websocketPort?: number; // Port for websocket if using websocket transport
  volumes?: string[];     // Optional volume mounts
  networkMode?: string;   // Optional network mode
  extraArgs?: string[];   // Additional docker run arguments
};

export type MCPStreamableHttpConfig = MCPManagerConfig & StreamableHTTPClientTransportOptions & {
  transport: 'sse-stream'
  url: URL;
};

export type MCPHttpSseConfig = MCPManagerConfig & SSEClientTransportOptions & {
  transport: 'sse-legacy'
  url: URL;
};

export type MCPServerConfig = MCPStdioConfig | MCPWebSocketConfig | MCPDockerConfig | MCPStreamableHttpConfig | MCPHttpSseConfig;

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
  containerName?: string; // Docker container name (auto-generated or custom)
};
