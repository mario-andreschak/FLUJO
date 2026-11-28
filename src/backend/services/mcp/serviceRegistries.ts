// Process-global MCP registries, shared by every copy of the MCP service module and kept per workspace.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { DEFAULT_WORKSPACE, getCurrentWorkspace } from "@/utils/workspace";
import { MCPServiceResponse } from "@/shared/types/mcp";
import { isClientConnectionClosed } from "@/utils/mcp/utils";
import { createLogger } from "@/utils/logger";

const log = createLogger("backend/services/mcp/serviceRegistries");

// MCP connection state must be PROCESS-global, never per module instance: Next.js
// evaluates this module once per module graph (route bundles, the instrumentation/
// scheduler graph, every dev hot reload), so `export const mcpService = new MCPService()`
// yields several coexisting instances. A live client wraps process-wide state (an OS
// child process or an HTTP session), so all instances must share ONE map of them.
declare global {
  // THE client map, keyed by server name — the single source of truth every MCPService
  // instance reads and writes through its `clients` getter. Historically each instance
  // had a private map seeded once from a global "recovery" map; that private copy is
  // exactly what caused the poisoned-client bug: one instance tearing down a client
  // (e.g. after an OAuth token refresh changed the transport's config key) left every
  // other instance holding the closed client, whose aborted transport made each tool
  // call fail instantly with "This operation was aborted" until FLUJO was restarted.
  var __mcp_clients: Map<string, Client> | undefined;
  // Names of servers whose connection attempt is currently in flight (initial
  // startup sweep or a reconnect). Global-backed for the same reason as
  // __mcp_clients: the module instance that starts the servers may not be the
  // one that later serves getServerStatus(), and the status route must still be
  // able to see that a startup is in progress so it can report "connecting"
  // instead of a misleading "configured but not connected" error.
  var __mcp_connecting: Set<string> | undefined;
  // Startup and status routes may use different service instances. Keep expected
  // execution-approval failures visible and warning deduplication shared by both.
  var __mcp_approval_failures: Map<string, MCPServiceResponse> | undefined;
  // True from process boot until startEnabledServers() finishes its first sweep.
  var __mcp_starting_up: boolean | undefined;
  var __mcp_starting_up_by_workspace: Map<string, boolean> | undefined;
  // The CURRENT transport per server name. onclose/onerror handlers close over the
  // transport they were registered on and fire for ANY instance — including a zombie
  // process exiting minutes after it was replaced, and closes FLUJO itself initiated.
  // A handler may only clean up / schedule reconnection when its transport IS the one
  // registered here; FLUJO-initiated closes deregister BEFORE closing, so their close
  // events are ignored. Global-backed for the same cross-module-instance reason as
  // __mcp_clients.
  var __mcp_active_transports: Map<string, Transport> | undefined;
  // Issue #255: monotonic per-server "generation" counter, bumped every time a
  // client is (re)registered in __mcp_clients. A tool advertised to the model
  // records the generation in force at advertise time; at dispatch time a
  // mismatch means the client was re-created (reconnect / config change) and the
  // call is rejected as stale instead of being run against a different instance.
  // A numeric counter (not the Client reference) survives SharedState persistence.
  var __mcp_client_generation: Map<string, number> | undefined;
  // Issue #255: the CURRENT advertised input-schema hash per (server\0tool). Set
  // whenever a tool set is advertised; compared at dispatch time against the hash
  // frozen in the call's toolNameMap entry to detect a schema change.
  var __mcp_tool_schema_hash: Map<string, string> | undefined;
}

// Initialize the global client map if it doesn't exist
if (typeof global.__mcp_clients === "undefined") {
  global.__mcp_clients = new Map<string, Client>();
}
if (typeof global.__mcp_connecting === "undefined") {
  global.__mcp_connecting = new Set<string>();
}
if (typeof global.__mcp_approval_failures === "undefined") {
  global.__mcp_approval_failures = new Map<string, MCPServiceResponse>();
}
if (typeof global.__mcp_starting_up === "undefined") {
  global.__mcp_starting_up = true;
}
if (typeof global.__mcp_active_transports === "undefined") {
  global.__mcp_active_transports = new Map<string, Transport>();
}
if (typeof global.__mcp_client_generation === "undefined") {
  global.__mcp_client_generation = new Map<string, number>();
}
if (typeof global.__mcp_tool_schema_hash === "undefined") {
  global.__mcp_tool_schema_hash = new Map<string, string>();
}

// Per-workspace copies of the server-name-keyed registries above (#406). Only
// NON-default workspaces get an entry here: the default workspace keeps using
// the original objects, so every pre-existing consumer (including tests that
// manipulate global.__mcp_clients directly) is completely unaffected.
declare global {
  var __mcp_workspace_registries:
    | Map<string, Map<string, unknown>>
    | undefined;
}

/**
 * Return the registry `name` for the currently selected workspace.
 *
 * `base` is the pre-workspace object and is returned as-is for the default
 * workspace. For any other workspace an empty registry of the same kind (Map or
 * Set) is created on first use and then reused for the life of the process,
 * shared across MCPService instances exactly like the globals are.
 */
export function scopedRegistry<T extends Map<unknown, unknown> | Set<unknown>>(
  name: string,
  base: T,
): T {
  const workspace = getCurrentWorkspace();
  if (workspace === DEFAULT_WORKSPACE) return base;
  const all = (global.__mcp_workspace_registries ??= new Map<
    string,
    Map<string, unknown>
  >());
  let perWorkspace = all.get(workspace);
  if (!perWorkspace) {
    perWorkspace = new Map<string, unknown>();
    all.set(workspace, perWorkspace);
  }
  let registry = perWorkspace.get(name);
  if (!registry) {
    registry = base instanceof Set ? new Set() : new Map();
    perWorkspace.set(name, registry);
  }
  return registry as T;
}

/**
 * The live client of `serverName` in the current workspace, read when called.
 *
 * A client whose connection is already closed (transport detached, or its abort
 * signal fired, e.g. torn down elsewhere between polls) can never serve another
 * request: HTTP transports would reject every call at once with "This operation
 * was aborted". It is removed and reported as missing, so every caller's
 * missing-client path (callTool's pre-call reconnect, listWithReconnect, the
 * connection retry) builds a fresh connection instead. The map is shared by
 * every service instance, so a fresh client another instance registered is
 * returned here and never removed.
 */
export function liveClient(serverName: string): Client | undefined {
  const clients = scopedRegistry("clients", global.__mcp_clients!);
  const client = clients.get(serverName);
  if (client && isClientConnectionClosed(client)) {
    log.warn(`liveClient: client for ${serverName} has a closed/aborted connection — evicting it`);
    clients.delete(serverName);
    return undefined;
  }
  log.debug(`liveClient: Looking for client: ${serverName}`, client ? "Found" : "Not found");
  return client;
}
