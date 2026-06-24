import { pathToFileURL } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ListRootsRequestSchema, Root } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '@/utils/logger';
import { resolveGlobalVars } from '@/backend/utils/resolveGlobalVars';
import { MCPServerConfig } from '@/shared/types/mcp';

const log = createLogger('backend/services/mcp/roots');

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
 * Resolve a server's configured roots into MCP `Root` objects: global-variable references
 * are substituted, paths are converted to `file://` URIs, and invalid/blank entries dropped.
 */
export async function resolveServerRoots(config: MCPServerConfig): Promise<Root[]> {
  const raw = (config as { roots?: unknown }).roots;
  if (!Array.isArray(raw)) return [];

  const out: Root[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    const resolved = (await resolveGlobalVars(entry)) as string;
    const uri = normalizeRootUri(resolved);
    if (uri) {
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
 * Only call this when hasRoots(config) is true — registering requires the client to have
 * declared the roots capability, and declaring an empty roots list could make a
 * roots-aware server refuse everything.
 */
export function registerRootsHandler(client: Client, config: MCPServerConfig): void {
  client.setRequestHandler(ListRootsRequestSchema, async () => {
    const roots = await resolveServerRoots(config);
    log.debug(`roots/list for ${config.name}: ${roots.length} root(s)`);
    return { roots };
  });
}
