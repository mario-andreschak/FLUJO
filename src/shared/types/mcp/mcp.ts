import { Tool, Resource, ResourceTemplate, ReadResourceResult, Prompt, GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
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
  /**
   * When true, FLUJO re-exposes this server's tools to external MCP clients at
   * `/mcp-proxy/<name>` (#17A). Opt-in per server; defaults to false/undefined.
   */
  exposeAsMcpServer?: boolean;
  /**
   * MCP roots (#15): workspace folders this server is scoped to. Each entry is a
   * filesystem path or a `file://` URI (and may contain `${global:VAR}` references,
   * resolved at connection time). Opt-in: when empty/undefined, FLUJO declares NO roots
   * capability so servers behave exactly as before. Advisory scoping, NOT a hard sandbox.
   */
  roots?: string[];
  /**
   * MCP sampling (#15): the design-time trust policy that lets this server ask FLUJO to
   * run LLM calls on its behalf (server -> client `sampling/createMessage`). The MCP spec
   * assumes a human approves each call, which can't happen in headless flows, so instead
   * the user grants standing permission here. Opt-in: when absent/disabled, FLUJO declares
   * NO sampling capability and rejects any request. Sampling terminates at FLUJO (never
   * forwarded onward). Enabling this lets the server spend your model's API budget.
   */
  sampling?: MCPSamplingPolicy;
}

export type MCPSamplingPolicy = {
  /** Master switch. When false/undefined, FLUJO does not advertise sampling at all. */
  enabled: boolean;
  /** Which FLUJO model answers sampling requests. Required when enabled. */
  modelId?: string;
  /** Hard cap on output tokens per call, regardless of what the server asks for. */
  maxTokens?: number;
  /** Max sampling calls allowed in a rolling 60s window (runaway-loop guard). */
  maxCallsPerMinute?: number;
};

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

// Using the official type from MCP SDK (the SDK exports the inferred TS type directly,
// avoiding a cross-zod-version inference mismatch).
export type MCPToolResponse = Tool;

// #15 MCP capabilities — resources & prompts. Re-export the SDK's inferred types so the
// rest of FLUJO stays decoupled from the SDK import path (mirrors MCPToolResponse above).
export type MCPResource = Resource;
export type MCPResourceTemplate = ResourceTemplate;
export type MCPReadResourceResult = ReadResourceResult;
export type MCPPrompt = Prompt;
export type MCPGetPromptResult = GetPromptResult;

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
