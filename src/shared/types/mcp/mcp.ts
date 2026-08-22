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
 * Parameters fixed by the user before an MCP tool is advertised to a model.
 * The outer key is the server tool name and the inner key is a top-level input
 * parameter. Values may be literals, `${global:NAME}`, or dynamic `@` refs.
 */
export type MCPToolParameterPresets = Record<string, Record<string, unknown>>;

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

/**
 * Optional host-path security contract for a persisted stdio server. It is
 * attached to the installed record and therefore survives rename operations;
 * runtime code never infers these privileges from the server display name.
 */
export type MCPHostPathAccessConfig = {
  environmentRootVariables: string[];
  snapshots: boolean;
};

/**
 * Presentation metadata for an MCP server. Registry installs retain the safe
 * http(s) icons published in server.json; FLUJO's bundled servers use trusted
 * same-origin SVG assets. The metadata is optional so existing configs remain
 * fully compatible.
 */
export type MCPServerIcon = {
  src: string;
  sizes?: string[];
  mimeType?: string;
  theme?: 'light' | 'dark';
};

export type MCPManagerConfig = {
  name: string;
  disabled: boolean;
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
  /** Optional logo variants displayed by MCP management and picker cards. */
  icons?: MCPServerIcon[];
  /** Name-independent host-path security metadata supplied by an installer. */
  hostPathAccess?: MCPHostPathAccessConfig;
  /**
   * When true, FLUJO re-exposes this server's tools to external MCP clients at
   * `/mcp-proxy/<name>` (#17A). Opt-in per server; defaults to false/undefined.
   */
  exposeAsMcpServer?: boolean;
  /**
   * MCP Apps (SEP-1865 / #97): opt-in switch letting this server render its
   * interactive `ui://` UI resources in chat or the docked canvas. Off by
   * default — when absent/false FLUJO never fetches or renders server-supplied
   * HTML for this server (the security opt-in is authoritative server-side: the
   * `ui` link is only attached to a tool message when this is enabled). Enabling
   * it also negotiates the UI extension and allows the isolated AppBridge to
   * broker same-server app tool/resource requests.
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
  /**
   * MCP elicitation (#238): opt-in capability letting this server ask the user for
   * additional input during a tool call (server -> client `elicitation/create`, spec
   * revision 2026-07-28). Opt-in: when absent/disabled, FLUJO declares NO elicitation
   * form capability and rejects form requests. Unattended/scheduled runs auto-cancel
   * elicitation requests rather than blocking. URL-mode is separately available only
   * while the user is explicitly starting a negotiated mcp-stdio-oauth flow.
   */
  elicitation?: MCPElicitationPolicy;
  /**
   * Issue #252: optional cap on how many of this server's tool calls FLUJO runs
   * concurrently within a single model turn. A turn's tool calls are dispatched
   * in parallel (bounded), but each server is limited to this many in flight at
   * once so a server that tolerates little parallelism is never overwhelmed.
   * Absent / non-positive ⇒ the conservative module default
   * (DEFAULT_TOOL_CALL_CONCURRENCY). Config-only for now (no dedicated UI).
   */
  maxConcurrency?: number;
  /** Server-wide tool argument defaults. A node may override individual keys. */
  toolParameterPresets?: MCPToolParameterPresets;
}

export type MCPElicitationPolicy = {
  /** Master switch. When false/undefined, FLUJO does not advertise elicitation at all. */
  enabled: boolean;
};

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

export type MCPStdioConfig = Omit<StdioServerParameters, 'env'> & MCPManagerConfig & {
  transport: 'stdio';
};

/**
 * Launch-and-connect (#392): the process FLUJO would start before connecting to
 * `serverUrl`. Deliberately ORTHOGONAL to `transport` — the discriminant keeps
 * answering "how do we talk to it", while `launch` answers "who starts it".
 * Modelling this as a fifth union member would force a review of ~67 transport
 * discriminant checks across 15+ files; as an optional field every existing
 * check keeps its exact meaning and code that ignores `launch` behaves as today.
 *
 * NOTE (Phase 1): FLUJO does NOT spawn this process yet. The spec is persisted
 * and displayed read-only so the user can start it themselves; owning the
 * process lifecycle (readiness polling, teardown, orphan reaping) is Phase 2.
 */
export type MCPLaunchSpec = {
  command: string;
  args?: string[];
  env?: Record<string, EnvVarValue>;
  cwd?: string;
  /** How long to poll serverUrl before declaring failure (Phase 2). Default 30_000. */
  readyTimeoutMs?: number;
};

export type MCPSSEConfig = SSEClientTransportOptions & MCPManagerConfig & {
  transport: 'sse';
  serverUrl: string;
  // Custom HTTP headers sent on every request (e.g. Authorization, X-SAP-System-Id).
  // Values may be secret (masked/encrypted) or bound to a global variable (#84).
  headers?: Record<string, MCPHeaderValue>;
  /** Optional launch-and-connect spec (#392). Not spawned by FLUJO yet. */
  launch?: MCPLaunchSpec;
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
  /** Opaque, single-use callback binding for an in-flight OAuth authorization. */
  oauthState?: string;
  /** Workspace which created oauthState; defense-in-depth beyond workspace-local storage. */
  oauthStateWorkspace?: string;
  oauthStateCreatedAt?: number;
  authorizationUrl?: string; // OAuth authorization URL when authentication is required
  /** Optional launch-and-connect spec (#392). Not spawned by FLUJO yet. */
  launch?: MCPLaunchSpec;
};

export type MCPWebSocketConfig = MCPManagerConfig & {
  transport: 'websocket';
  websocketUrl: string;
};

export type MCPServerConfig = MCPStdioConfig | MCPWebSocketConfig | MCPSSEConfig | MCPStreamableConfig;

// ---------------------------------------------------------------------------
// MCP Tasks extension (SEP-2663 / spec 2026-07-28)
// Servers that support the Tasks extension may respond to tools/call with a
// task handle instead of a CallToolResult. FLUJO detects this shape, enters a
// poll loop (tasks/get), and maps tasks/cancel onto its cancellation ancestry.
// ---------------------------------------------------------------------------

/** SEP-2663 task handle returned by tools/call instead of a CallToolResult */
export interface MCPTaskHandle {
  taskId: string;
  status: 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';
  /** Server-suggested poll interval in ms */
  pollInterval?: number;
  /** Present when status === 'completed' */
  result?: unknown;
  /** Present when status === 'failed' */
  error?: string;
}

/** Top-level result shape from tools/call when the server returns a task */
export interface MCPTaskCallResponse {
  task: MCPTaskHandle;
}

/**
 * Type guard: distinguishes a task-handle response from a classic CallToolResult.
 * The discriminator is the presence of a `task` object with a string `taskId`.
 */
export function isTaskCallResponse(r: unknown): r is MCPTaskCallResponse {
  return (
    typeof r === 'object' &&
    r !== null &&
    'task' in r &&
    typeof (r as MCPTaskCallResponse).task?.taskId === 'string'
  );
}

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

/** A downstream OAuth authorization reported by the mcp-stdio-oauth extension. */
export interface MCPStdioOAuthAuthorization {
  /** Stable, opaque identifier supplied back to the server when authorization starts. */
  id: string;
  /** Optional provider display hint. It must not be used for security decisions. */
  provider?: string;
  /** Human-readable account/provider name, for example "Google Workspace". */
  label: string;
  /** Extension-defined state. `ready` is the only universally non-blocking state. */
  state: string;
  /** Whether a headless flow must stop until this requirement is ready. */
  blocksUnattendedUse: boolean;
  /** Optional safe-to-display explanation from the server. */
  message?: string;
}

/** Negotiated mcp-stdio-oauth readiness included with an MCP server's status. */
export interface MCPStdioOAuthStatus {
  supported: boolean;
  authorizations: MCPStdioOAuthAuthorization[];
  /** The first authorization currently preventing unattended tool execution. */
  blockingAuthorization?: MCPStdioOAuthAuthorization;
}

type WithMCPServerState<T extends MCPServerConfig> = T extends MCPServerConfig ? Omit<T, 'env'> & {
  status: 'connected' | 'disconnected' | 'error' | 'connecting' | 'initialization' | 'requires_authentication';
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
  error?: string;
  stderrOutput?: string;
  authorizationUrl?: string; // OAuth authorization URL when authentication is required
  stdioOAuth?: MCPStdioOAuthStatus;
  env: Record<string, EnvVarValue>;
} : never;

export type MCPServerState = WithMCPServerState<MCPServerConfig>;
