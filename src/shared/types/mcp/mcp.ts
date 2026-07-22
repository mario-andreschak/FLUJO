import { Tool, Resource, ResourceTemplate, ReadResourceResult, Prompt, GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransportOptions } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransportOptions } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { OAuthClientMetadata, OAuthClientInformation, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

// Constants
export const SERVER_DIR_PREFIX = 'mcp-servers';

/**
 * Default timeout for an MCP tool call made from a flow, in seconds (5 minutes).
 * An MCP node can override it via `properties.toolTimeout`; TOOL_CALL_TIMEOUT_INFINITE
 * (-1) disables the timeout entirely. Server progress notifications reset the timer
 * (see backend/services/mcp/tools.ts), so a finite timeout only kills silent calls.
 */
export const DEFAULT_TOOL_CALL_TIMEOUT_SECONDS = 300;
export const TOOL_CALL_TIMEOUT_INFINITE = -1;

// Types
export type EnvVarValue = string | { 
  value: string; 
  metadata: { 
    isSecret: boolean 
  } 
};

/**
 * A custom HTTP header value on a remote (SSE / Streamable-HTTP) MCP server. Reuses the
 * env-var shape (#84): a plain string is the legacy/non-secret form; the object form carries
 * a per-header `isSecret` flag. Secret values are masked to the browser and encrypted at
 * rest, and any value may be a `${global:VAR}` binding resolved fresh at connect time.
 */
export type MCPHeaderValue = EnvVarValue;

/**
 * How an MCP server was installed (#193). A machine-readable, discriminated
 * record of each server's install-origin, so downstream features (notably the
 * by-reference package export, #192) can serialize *installation instructions*
 * rather than files — and abort on `local` servers, which are not packageable.
 *
 *  - `github`      — cloned from a git repository (GitHub tab, Reference servers).
 *  - `registry`    — installed from registry.modelcontextprotocol.io (Marketplace,
 *                    Spotlight, headless registry install).
 *  - `marketplace` — installed from a curated marketplace entry (reserved).
 *  - `remote`      — a hosted sse/streamable endpoint (`serverUrl` is the reference).
 *  - `local`       — a hand-configured local server; explicitly NOT packageable.
 */
export type MCPServerSource =
  | { type: 'github'; repositoryUrl: string; ref?: string; subdirectory?: string }
  | { type: 'registry'; registryName: string; version?: string }
  | { type: 'marketplace'; id: string }
  | { type: 'remote' }
  | { type: 'local' };

export type MCPManagerConfig = {
  name: string;
  disabled: boolean;
  autoApprove: string[];
  rootPath: string;
  env: Record<string, EnvVarValue>
  _buildCommand: string;
  _installCommand: string;
  /**
   * Install-origin metadata (#193). Optional and additive: existing persisted
   * configs load unchanged, and `loadServerConfigs` best-effort backfills it on
   * read (git remote for clones under mcp-servers/, else `local`). Populated at
   * install time on every non-local path so package export can decide
   * packageable-vs-abort purely from `source.type`.
   */
  source?: MCPServerSource;
  /**
   * When true, FLUJO re-exposes this server's tools to external MCP clients at
   * `/mcp-proxy/<name>` (#17A). Opt-in per server; defaults to false/undefined.
   */
  exposeAsMcpServer?: boolean;
  /**
   * MCP Apps (SEP-1865 / #97): opt-in switch letting this server render its
   * interactive `ui://` UI resources in the chat tool-call timeline. Off by
   * default — when absent/false FLUJO never fetches or renders server-supplied
   * HTML for this server (the security opt-in is authoritative server-side: the
   * `ui` link is only attached to a tool message when this is enabled). Phase 1
   * renders read-only in a strict sandbox; there is no iframe->host bridge yet.
   */
  enableMcpApps?: boolean;
  /**
   * Optional, user-assigned folder for organizing server cards in the MCP
   * manager (#71). Absent/empty means "Ungrouped". Frontend-only organization —
   * has no effect on the server connection.
   */
  folder?: string;
  /**
   * Optional favorite flag (#146, mirrors flows #120). When true the server floats
   * to the top of the MCP manager and of every server picker. Additive and
   * optional: absence reads as "not a favorite". Frontend-only organization —
   * has no effect on the server connection.
   */
  favorite?: boolean;
  /**
   * Marks FLUJO's own built-in in-process server (the synthetic "flujo" entry
   * that exposes FLUJO's backend API as MCP tools to its own flows). Built-in
   * configs are synthesized at load time, never persisted (saveConfig drops
   * them), and cannot be edited, renamed, disabled, or deleted.
   */
  builtIn?: boolean;
  /**
   * MCP roots (#15/#46): workspace folders this server is scoped to. Each entry is a
   * filesystem path or a `file://` URI (and may contain `${global:VAR}` references,
   * resolved fresh on every roots/list request). The roots capability is ALWAYS
   * declared; when this list is empty/undefined (and no FlowBuilder node contributes
   * roots), the server's own `rootPath` is served as its single default root. Changes
   * are announced via notifications/roots/list_changed — never a reconnect. Advisory
   * scoping, NOT a hard sandbox.
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
  // Values may be secret (masked/encrypted) or bound to a global variable (#84).
  headers?: Record<string, MCPHeaderValue>;
};

export type MCPStreamableConfig = StreamableHTTPClientTransportOptions & MCPManagerConfig & {
  transport: 'streamable';
  serverUrl: string;
  // Custom HTTP headers sent on every request (e.g. Authorization, X-SAP-System-Id).
  // Values may be secret (masked/encrypted) or bound to a global variable (#84).
  headers?: Record<string, MCPHeaderValue>;
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
  /** Set on a test/connect result: the server advertises OAuth (RFC 9728), so the UI can
   * offer to authenticate rather than only hinting at a static Authorization header. */
  oauthCapable?: boolean;
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
