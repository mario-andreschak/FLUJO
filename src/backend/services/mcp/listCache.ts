/**
 * Reuse of MCP tool and resource lists between requests (#1408).
 *
 * A flow turn lists a server's tools several times (the pre-run check, the
 * tool preparation for each model call) and its resources and resource
 * templates once per model call. Each listing is a network round trip for a
 * remote server. A list is reused only for a server that announces
 * changes to it (the `listChanged` capability of the MCP specification), and
 * only on the same connection. It is dropped at once when the server sends
 * `notifications/tools/list_changed` or `notifications/resources/list_changed`,
 * when FLUJO reconnects (a new client), and in any case after
 * MCP_LIST_CACHE_MAX_AGE_MS, so a lost notification heals by itself.
 *
 * Failed listings, paged requests and protected execution contexts are never
 * cached; resource contents are never cached.
 */

export type McpListKind = 'tools' | 'resources';

export const MCP_LIST_CACHE_MAX_AGE_MS = 60_000;

interface Entry { at: number; value: unknown }

/** Keyed by the client object: a reconnect creates a new client and starts empty. */
const entries = new WeakMap<object, Map<string, Entry>>();

/** Whether the server promised to announce changes to this list. */
export function announcesListChanges(client: unknown, kind: McpListKind): boolean {
  try {
    const capabilities = (client as { getServerCapabilities?: () => Record<string, { listChanged?: boolean } | undefined> | undefined })
      .getServerCapabilities?.();
    return capabilities?.[kind]?.listChanged === true;
  } catch {
    return false;
  }
}

/**
 * Return the cached list for this client and key, or load it. `load` results
 * that carry an `error` are returned but never kept.
 */
export async function cachedMcpList<T extends { error?: string }>(
  client: object | undefined,
  kind: McpListKind,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  if (!client || !announcesListChanges(client, kind)) return load();
  const lists = entries.get(client);
  const cacheKey = `${kind}:${key}`;
  const hit = lists?.get(cacheKey);
  if (hit && Date.now() - hit.at < MCP_LIST_CACHE_MAX_AGE_MS) return structuredClone(hit.value) as T;
  const value = await load();
  if (!value.error) {
    const map = entries.get(client) ?? new Map<string, Entry>();
    map.set(cacheKey, { at: Date.now(), value: structuredClone(value) });
    entries.set(client, map);
  }
  return value;
}

/** Drop this client's cached lists of one kind (or all), for example on a change notice. */
export function invalidateMcpLists(client: object | undefined, kind?: McpListKind): void {
  if (!client) return;
  const lists = entries.get(client);
  if (!lists) return;
  if (!kind) { entries.delete(client); return; }
  for (const key of [...lists.keys()]) if (key.startsWith(`${kind}:`)) lists.delete(key);
}
