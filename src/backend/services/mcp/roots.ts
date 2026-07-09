import { pathToFileURL } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ListRootsRequestSchema, Root } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '@/utils/logger';
import { resolveGlobalVars } from '@/backend/utils/resolveGlobalVars';
import { MCPServerConfig } from '@/shared/types/mcp';

const log = createLogger('backend/services/mcp/roots');

// ---------------------------------------------------------------------------
// MCP roots (issues 15 + 46 + owner directive of 2026-07-06)
//
// The roots client capability is ALWAYS declared (`roots: { listChanged: true }`,
// see connection.ts) — the MCP spec treats roots as a client capability whose
// declaration is independent of how many roots currently exist, and an empty
// `roots/list` result is valid. Because the capability never changes, roots can
// NEVER force a client/connection rebuild: content is resolved fresh on every
// `roots/list` request, and changes are announced via
// `notifications/roots/list_changed` (mcpService.notifyRootsChanged).
//
// The effective roots of a server are, in order:
//   1. the server-level roots from its config (`config.roots`)
//   2. ∪ all node-level roots FlowBuilder MCP nodes currently contribute (issue 46)
//   3. fallback — when 1 ∪ 2 is empty: the server's own absolute path
//      (`config.rootPath`), "as per mcp configuration". A blank/invalid rootPath
//      yields an empty list, which is spec-valid.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Node-level roots overlay (FlowBuilder MCP nodes, issue 46)
//
// MCP connections are singletons keyed by server NAME, so an MCP node in
// FlowBuilder cannot get its own scoped connection. Instead a node's roots are
// an ADDITIVE overlay: executing the node registers its roots here, and
// roots/list answers with the union of the server-level roots and all
// currently-registered node roots for that server.
//
// Registrations are keyed by node id (last write wins) and survive until the
// node next runs with different — or no — roots. Like server-level roots this
// is advisory scoping, not a sandbox. Global-backed for the same cross-module-
// instance/hot-reload reason as __mcp_clients in ./index.ts.
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
 *
 * Returns the names of servers whose EFFECTIVE node-roots set actually changed (the
 * new server, and the previous one on a re-bind), so the caller can send
 * `notifications/roots/list_changed` to exactly those connections. No change → empty.
 */
export function setNodeRoots(serverName: string, nodeId: string, roots: string[] | undefined): string[] {
  const cleaned = (roots ?? []).filter((r) => typeof r === 'string' && r.trim().length > 0);
  const previous = nodeRootsRegistry().get(nodeId);

  const affected = new Set<string>([serverName]);
  if (previous) affected.add(previous.serverName);
  const before = new Map<string, string[]>();
  for (const name of affected) before.set(name, getNodeRoots(name));

  if (cleaned.length === 0) {
    if (nodeRootsRegistry().delete(nodeId)) {
      log.debug(`Cleared node roots for node ${nodeId}`);
    }
  } else {
    nodeRootsRegistry().set(nodeId, { serverName, roots: cleaned });
    log.debug(`Registered ${cleaned.length} node root(s) for node ${nodeId} on server ${serverName}`);
  }

  const changed: string[] = [];
  for (const name of affected) {
    const after = getNodeRoots(name);
    const prior = before.get(name) ?? [];
    if (after.length !== prior.length || after.some((r, i) => r !== prior[i])) {
      changed.push(name);
    }
  }
  return changed;
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

/** Test hook: wipe all node-level roots registrations. */
export function _resetNodeRootsForTests(): void {
  nodeRootsRegistry().clear();
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

/** Resolve one raw root entry (path / file:// URI / ${global:VAR}) into a Root, or null. */
async function resolveRootEntry(entry: string): Promise<Root | null> {
  const resolved = (await resolveGlobalVars(entry)) as string;
  const uri = normalizeRootUri(resolved);
  return uri ? { uri, name: rootName(uri) } : null;
}

/**
 * Resolve a server's roots into MCP `Root` objects: global-variable references are
 * substituted, paths are converted to `file://` URIs, and invalid/blank entries dropped.
 *
 * The result is the UNION of the server-level roots and any node-level roots currently
 * registered for this server (FlowBuilder MCP nodes, issue 46), de-duplicated by URI.
 * When that union is empty, the server's own path (`config.rootPath`) is the default
 * root — every connection declares the roots capability, so a rootless config would
 * otherwise answer with an empty list even though the server does have a defined
 * working folder. Reading everything live — not from a frozen snapshot — is what lets
 * roots changes take effect without a reconnect.
 */
export async function resolveServerRoots(config: MCPServerConfig): Promise<Root[]> {
  const raw = (config as { roots?: unknown }).roots;
  const serverRoots = Array.isArray(raw) ? raw : [];
  const entries = [...serverRoots, ...getNodeRoots(config.name)];

  const out: Root[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    const root = await resolveRootEntry(entry);
    if (root && !seen.has(root.uri)) {
      seen.add(root.uri);
      out.push(root);
    }
  }

  // Default root: the server's own path, when the user configured no roots anywhere.
  if (out.length === 0 && typeof config.rootPath === 'string' && config.rootPath.trim()) {
    const fallback = await resolveRootEntry(config.rootPath);
    if (fallback) return [fallback];
  }

  return out;
}

/**
 * The freshest config for a server: re-read from storage by name so a roots or rootPath
 * edit made AFTER connect is served correctly (roots changes never rebuild the client,
 * so the closed-over connect-time config can go stale). Falls back to the connect-time
 * config when storage can't provide one (e.g. load failure, or a rename that is about
 * to reconnect anyway).
 */
async function freshestConfig(connectTimeConfig: MCPServerConfig): Promise<MCPServerConfig> {
  try {
    // Dynamic import to keep module init order flat (roots.ts is imported by connection.ts).
    const { loadServerConfigs } = await import('./config');
    const configs = await loadServerConfigs();
    if (Array.isArray(configs)) {
      const current = configs.find((c) => c.name === connectTimeConfig.name);
      if (current) return current;
    }
  } catch (error) {
    log.warn(`Could not re-load config for ${connectTimeConfig.name}, using connect-time config:`, error);
  }
  return connectTimeConfig;
}

/**
 * Register the `roots/list` request handler on a client so the server can discover the
 * workspace folders FLUJO has scoped it to. Called for EVERY client (the roots
 * capability is always declared); roots are resolved fresh on each request — config
 * re-read from storage, node overlay and global-variable values read live — so they
 * always reflect the current state without ever needing a reconnect.
 */
export function registerRootsHandler(client: Client, config: MCPServerConfig): void {
  client.setRequestHandler(ListRootsRequestSchema, async () => {
    const roots = await resolveServerRoots(await freshestConfig(config));
    log.debug(`roots/list for ${config.name}: ${roots.length} root(s)`);
    return { roots };
  });
}
