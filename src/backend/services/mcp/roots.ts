import { pathToFileURL } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ListRootsRequestSchema, Root } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '@/utils/logger';
import { resolveGlobalVars } from '@/backend/utils/resolveGlobalVars';
import { MCPServerConfig } from '@/shared/types/mcp';

const log = createLogger('backend/services/mcp/roots');

// ---------------------------------------------------------------------------
// Node-level roots overlay (FlowBuilder MCP nodes, issue 46)
//
// MCP connections are singletons keyed by server NAME, so an MCP node in
// FlowBuilder cannot get its own scoped connection. Instead a node's roots are
// an ADDITIVE overlay: executing the node registers its roots here, and
// roots/list answers with the union of the server-level roots and all
// currently-registered node roots for that server. Because roots are resolved
// fresh on every roots/list request, changing the CONTENT of node roots needs
// no reconnect; only the DECLARED capability (no roots at all <-> some roots)
// is negotiated at connect time — see hasAnyRoots and connection.ts
// capabilityKey, which force a controlled client rebuild on that transition.
//
// Registrations are keyed by node id (last write wins) and survive until the
// node next runs with different — or no — roots. Like server-level roots this
// is advisory scoping, not a sandbox. Global-backed for the same hot-reload
// reason as __mcp_recovery in ./index.ts.
// ---------------------------------------------------------------------------
declare global {
  // eslint-disable-next-line no-var
  var __mcp_node_roots: Map<string, { serverName: string; roots: string[] }> | undefined;
}
if (typeof global.__mcp_node_roots === 'undefined') {
  global.__mcp_node_roots = new Map();
}

function nodeRootsRegistry(): Map<string, { serverName: string; roots: string[] }> {
  return global.__mcp_node_roots!;
}

/**
 * Register (or clear, when `roots` is empty/blank) the workspace folders a FlowBuilder
 * MCP node contributes to its bound server. Keyed by node id, so re-running a node
 * replaces its previous registration — including moving it when the node was re-bound
 * to a different server.
 */
export function setNodeRoots(serverName: string, nodeId: string, roots: string[] | undefined): void {
  const cleaned = (roots ?? []).filter((r) => typeof r === 'string' && r.trim().length > 0);
  if (cleaned.length === 0) {
    if (nodeRootsRegistry().delete(nodeId)) {
      log.debug(`Cleared node roots for node ${nodeId}`);
    }
    return;
  }
  nodeRootsRegistry().set(nodeId, { serverName, roots: cleaned });
  log.debug(`Registered ${cleaned.length} node root(s) for node ${nodeId} on server ${serverName}`);
}

/** All node-contributed roots currently registered for a server (raw strings, de-duped). */
export function getNodeRoots(serverName: string): string[] {
  const out: string[] = [];
  for (const entry of nodeRootsRegistry().values()) {
    if (entry.serverName !== serverName) continue;
    for (const root of entry.roots) {
      if (!out.includes(root)) out.push(root);
    }
  }
  return out;
}

/** Does any FlowBuilder node currently contribute roots to this server? */
export function hasNodeRoots(serverName: string): boolean {
  for (const entry of nodeRootsRegistry().values()) {
    if (entry.serverName === serverName) return true;
  }
  return false;
}

/**
 * Server-level OR node-level roots present — gates the roots client capability.
 * A server with neither keeps the exact pre-roots behaviour (no capability declared).
 */
export function hasAnyRoots(config: MCPServerConfig): boolean {
  return hasRoots(config) || hasNodeRoots(config.name);
}

/** Test hook: wipe all node-level roots registrations. */
export function _resetNodeRootsForTests(): void {
  nodeRootsRegistry().clear();
}

/** Does this server have any roots configured? Gates the roots client capability. */
export function hasRoots(config: MCPServerConfig): boolean {
  const roots = (config as { roots?: unknown }).roots;
  return Array.isArray(roots) && roots.some((r) => typeof r === 'string' && r.trim().length > 0);
}

/**
 * Stable key of a server's configured roots, used to detect roots changes (so the client
 * is rebuilt — both the declared capability and the handler's closed-over config change).
 */
export function rootsConfigKey(config: MCPServerConfig): string {
  const roots = (config as { roots?: unknown }).roots;
  const list = Array.isArray(roots) ? roots.filter((r) => typeof r === 'string' && r.trim()) : [];
  return JSON.stringify(list);
}

/**
 * Normalize a configured root (a filesystem path or a `file://` URI) into a `file://` URI,
 * as the MCP spec requires for roots. Returns null for blank/invalid input.
 */
export function normalizeRootUri(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (s.startsWith('file://')) return s;
  // Reject other URI schemes — roots are filesystem locations.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) {
    log.warn(`Ignoring non-file root URI: ${s}`);
    return null;
  }
  try {
    return pathToFileURL(s).href;
  } catch (error) {
    log.warn(`Could not convert root "${s}" to a file URI:`, error);
    return null;
  }
}

/** A friendly name for a root: its last path segment. */
function rootName(uri: string): string | undefined {
  try {
    const pathname = new URL(uri).pathname.replace(/\/+$/, '');
    const segment = pathname.split('/').pop();
    return segment ? decodeURIComponent(segment) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a server's roots into MCP `Root` objects: global-variable references are
 * substituted, paths are converted to `file://` URIs, and invalid/blank entries dropped.
 *
 * The result is the UNION of the server-level roots and any node-level roots currently
 * registered for this server (FlowBuilder MCP nodes, issue 46), de-duplicated by URI.
 * Reading the node overlay live — not from the frozen config the handler closed over —
 * is what lets node roots take effect without a reconnect.
 */
export async function resolveServerRoots(config: MCPServerConfig): Promise<Root[]> {
  const raw = (config as { roots?: unknown }).roots;
  const serverRoots = Array.isArray(raw) ? raw : [];
  const entries = [...serverRoots, ...getNodeRoots(config.name)];

  const out: Root[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    const resolved = (await resolveGlobalVars(entry)) as string;
    const uri = normalizeRootUri(resolved);
    if (uri && !seen.has(uri)) {
      seen.add(uri);
      out.push({ uri, name: rootName(uri) });
    }
  }
  return out;
}

/**
 * Register the `roots/list` request handler on a client so the server can discover the
 * workspace folders FLUJO has scoped it to. Roots are resolved fresh on each request, so
 * they always reflect the current config (and current global-variable values).
 *
 * Only call this when hasAnyRoots(config) is true — registering requires the client to
 * have declared the roots capability, and declaring an empty roots list could make a
 * roots-aware server refuse everything.
 */
export function registerRootsHandler(client: Client, config: MCPServerConfig): void {
  client.setRequestHandler(ListRootsRequestSchema, async () => {
    const roots = await resolveServerRoots(config);
    log.debug(`roots/list for ${config.name}: ${roots.length} root(s)`);
    return { roots };
  });
}
