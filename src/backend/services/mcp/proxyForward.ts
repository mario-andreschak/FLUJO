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
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const log = createLogger('backend/services/mcp/proxyForward');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** Extract the bare hostname from a Host header value (strips port; handles IPv6 brackets). */
function hostnameOf(hostHeader: string | null): string | null {
  if (!hostHeader) return null;
  const h = hostHeader.trim();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(1, end) : null;
  }
  return h.split(':')[0] || null;
}

/**
 * Localhost guard (#17A, single-user/localhost posture). Blocks the DNS-rebinding
 * vector: a browser tricked into hitting `localhost` carries the attacker's domain
 * in Host and an attacker Origin, while native MCP clients connect to a localhost
 * Host and send no Origin. We allow only localhost-family Hosts, and reject any
 * non-localhost Origin when present. We do our own check (predictable) rather than
 * relying on the SDK transport's allowedHosts semantics.
 */
export function isLocalRequest(host: string | null, origin: string | null): boolean {
  const h = hostnameOf(host);
  if (!h || !LOCAL_HOSTS.has(h)) return false;
  if (origin) {
    try {
      if (!LOCAL_HOSTS.has(new URL(origin).hostname)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

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
