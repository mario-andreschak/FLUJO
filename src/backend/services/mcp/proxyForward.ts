/**
 * Proxy forwarding for FLUJO-as-an-MCP-server (#17A).
 *
 * This module is the actual "proxy brain": it forwards inbound MCP requests
 * (from an external client connected to `/mcp-proxy/<server>`) to the
 * corresponding downstream MCP server via `mcpService`. It is deliberately
 * transport-agnostic — the inbound HTTP/transport shell lives in the route
 * handler, so this logic stays small, pure-ish, and unit-testable.
 *
 * Two separate sessions are involved and never need correlating:
 *  - inbound: external client <-> FLUJO (handled by the route's MCP transport)
 *  - downstream: FLUJO <-> the real server (a persistent `mcpService` connection,
 *    keyed by server name and shared across all inbound clients).
 */
import { createLogger } from '@/utils/logger';
import { mcpService } from '@/backend/services/mcp';
import { isLocked } from '@/utils/encryption/lockGate';
import type { Tool, CallToolResult, Resource, ResourceTemplate, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

const log = createLogger('backend/services/mcp/proxyForward');

/**
 * Message surfaced downstream when FLUJO is locked (issue #77, Stage 2). Kept in
 * sync with the `encryption_locked` sentinel used by the HTTP route gate so an
 * external MCP client can detect the locked state.
 */
const LOCKED_MESSAGE = 'FLUJO encryption is locked (encryption_locked). Unlock FLUJO to continue.';

/**
 * Localhost guard (#17A, single-user/localhost posture). Re-exported from the
 * shared util (#131) so the command-executing `/api/*` routes can reuse the exact
 * same DNS-rebinding defense without importing from `backend/services/mcp`. This
 * module's original callers (`/mcp-flows`, `/mcp-proxy/[server]`, `/api/webhooks/[id]`)
 * keep importing it from here unchanged.
 */
export { isLocalRequest } from '@/utils/http/localRequest';

/**
 * Whether a server is opted in to being re-exposed. Requires the config to
 * exist, be enabled, and have `exposeAsMcpServer === true`. The route returns
 * 404 when this is false so non-exposed servers are indistinguishable from
 * unknown ones.
 */
export async function isServerExposed(serverName: string): Promise<boolean> {
  const configs = await mcpService.loadServerConfigs();
  if (!Array.isArray(configs)) {
    log.warn('isServerExposed: failed to load server configs', { error: configs.error });
    return false;
  }
  const cfg = configs.find((c) => c.name === serverName);
  return !!cfg && !cfg.disabled && cfg.exposeAsMcpServer === true;
}

/**
 * Forward a `tools/list` to the downstream server. Ensures the server is
 * connected first (mirrors ToolHandler.processMCPNodes), then lists. Throws on
 * a genuine failure so the MCP SDK surfaces a proper JSON-RPC error.
 */
export async function proxyListTools(serverName: string): Promise<{ tools: Tool[] }> {
  if (await isLocked()) {
    throw new Error(LOCKED_MESSAGE);
  }
  const connect = await mcpService.connectServer(serverName);
  if (!connect.success) {
    throw new Error(`Failed to connect to MCP server '${serverName}': ${connect.error}`);
  }
  const result = await mcpService.listServerTools(serverName);
  if (result.error) {
    throw new Error(`Failed to list tools for '${serverName}': ${result.error}`);
  }
  return { tools: (result.tools ?? []) as Tool[] };
}

/**
 * Forward a `tools/call` to the downstream server. `mcpService.callTool`'s
 * `data` is already the downstream `CallToolResult`, so a success passes
 * through unchanged; a failure is mapped to an MCP error result.
 */
export async function proxyCallTool(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  if (await isLocked()) {
    return {
      content: [{ type: 'text', text: LOCKED_MESSAGE }],
      isError: true,
    };
  }
  const connect = await mcpService.connectServer(serverName);
  if (!connect.success) {
    return {
      content: [{ type: 'text', text: `Error connecting to '${serverName}': ${connect.error}` }],
      isError: true,
    };
  }
  const result = await mcpService.callTool(serverName, toolName, args);
  if (result.success) {
    return result.data as CallToolResult;
  }
  return {
    content: [{ type: 'text', text: `Error: ${result.error ?? 'Unknown error'}` }],
    isError: true,
  };
}

/**
 * Forward a `resources/list` to the downstream server (Tier 3: for the internal
 * "flujo" server this surfaces the run-scoped resources to external clients).
 * Same lock gate → connect → list → throw-on-error shape as proxyListTools.
 */
export async function proxyListResources(serverName: string): Promise<{ resources: Resource[] }> {
  if (await isLocked()) {
    throw new Error(LOCKED_MESSAGE);
  }
  const connect = await mcpService.connectServer(serverName);
  if (!connect.success) {
    throw new Error(`Failed to connect to MCP server '${serverName}': ${connect.error}`);
  }
  const result = await mcpService.listServerResources(serverName);
  if (result.error) {
    throw new Error(`Failed to list resources for '${serverName}': ${result.error}`);
  }
  return { resources: (result.resources ?? []) as Resource[] };
}

/** Forward a `resources/templates/list` to the downstream server. */
export async function proxyListResourceTemplates(serverName: string): Promise<{ resourceTemplates: ResourceTemplate[] }> {
  if (await isLocked()) {
    throw new Error(LOCKED_MESSAGE);
  }
  const connect = await mcpService.connectServer(serverName);
  if (!connect.success) {
    throw new Error(`Failed to connect to MCP server '${serverName}': ${connect.error}`);
  }
  const result = await mcpService.listServerResourceTemplates(serverName);
  if (result.error) {
    throw new Error(`Failed to list resource templates for '${serverName}': ${result.error}`);
  }
  return { resourceTemplates: (result.resourceTemplates ?? []) as ResourceTemplate[] };
}

/** Forward a `resources/read` to the downstream server. */
export async function proxyReadResource(serverName: string, uri: string): Promise<ReadResourceResult> {
  if (await isLocked()) {
    throw new Error(LOCKED_MESSAGE);
  }
  const connect = await mcpService.connectServer(serverName);
  if (!connect.success) {
    throw new Error(`Failed to connect to MCP server '${serverName}': ${connect.error}`);
  }
  const result = await mcpService.readResource(serverName, uri);
  if (!result.success || !result.data) {
    throw new Error(`Failed to read resource '${uri}' from '${serverName}': ${result.error ?? 'unknown error'}`);
  }
  return result.data as ReadResourceResult;
}
