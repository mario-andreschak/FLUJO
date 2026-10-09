import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { v4 as uuidv4 } from 'uuid';
import { REGISTRY_ORIGIN, registryGetRaw } from '@/backend/utils/registryClient';
import { rankRegistryResults } from '@/backend/services/mcp/registryInstall';
import { RegistryServerResult } from '@/utils/mcp/registry';
import { discoverRegistryServers } from '@/backend/services/mcp/registryDiscovery';
import { canonicalDiscoveryQuery } from '@/shared/mcpDiscoverySearch';

const log = createLogger('app/api/mcp-registry/route');

const REGISTRY_LIST_PATH = '/v0.1/servers';
const FETCH_TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 50;
const CACHE_MAX_BYTES = 8 * 1024 * 1024;

interface CacheEntry {
  timestamp: number;
  body: unknown;
  bytes: number;
}

interface DiscoverySnapshot {
  id: string;
  servers: RegistryServerResult[];
  discovery: Awaited<ReturnType<typeof discoverRegistryServers>>['discovery'];
}
const pendingSnapshots = new Map<string, Promise<DiscoverySnapshot>>();

// Short-lived in-memory cache so repeated searches (and the initial unfiltered
// listing every user sees first) don't hammer the public registry. The registry
// docs ask aggregators to poll infrequently; per-query caching is our share of that.
const cache = new Map<string, CacheEntry>();
let cacheBytes = 0;

function deleteCached(key: string): void {
  const existing = cache.get(key);
  if (existing) cacheBytes -= existing.bytes;
  cache.delete(key);
}

function getCached(key: string): unknown | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    deleteCached(key);
    return null;
  }
  return entry.body;
}

function setCached(key: string, body: unknown): void {
  const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  if (bytes > CACHE_MAX_BYTES) return;
  deleteCached(key);
  while (cache.size >= CACHE_MAX_ENTRIES || cacheBytes + bytes > CACHE_MAX_BYTES) {
    // Evict the oldest entry (Map preserves insertion order)
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) deleteCached(oldest);
  }
  cache.set(key, { timestamp: Date.now(), body, bytes });
  cacheBytes += bytes;
}

/**
 * GET /api/mcp-registry — server-side proxy for the official MCP Registry.
 *
 * The browser talks to this route instead of registry.modelcontextprotocol.io
 * directly so we are independent of the registry's CORS policy, can cache, and
 * can work around the HTTP/1.1 issue described at http2GetJson.
 *
 * Query parameters (all optional, passed through):
 *   search — bounded capability/name discovery (iconsOnly remains exact metadata)
 *   cursor — pagination cursor from a previous response's metadata.nextCursor
 *   limit  — page size (clamped to 1..100, default 30)
 */
async function GET_handler(request: NextRequest) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  const requestId = uuidv4();
  const { searchParams } = new URL(request.url);

  const search = searchParams.get('search') || '';
  const cursor = searchParams.get('cursor') || '';
  if (search.length > 256 || cursor.length > 1024) {
    return NextResponse.json({ success: false, error: 'Registry search or cursor is too long' }, { status: 400 });
  }
  // Installed-card logo discovery only needs registry metadata; skip the
  // comparatively expensive GitHub/npm quality enrichment for that request.
  const iconsOnly = searchParams.get('iconsOnly') === 'true';
  const rawLimit = parseInt(searchParams.get('limit') || '30', 10);
  const limit = Math.min(Math.max(Number.isNaN(rawLimit) ? 30 : rawLimit, 1), 100);

  if (search.trim() && !iconsOnly) {
    return discoveryPage(search, cursor, limit, requestId);
  }

  const upstream = new URL(REGISTRY_ORIGIN + REGISTRY_LIST_PATH);
  // Only the latest version of each server is meaningful in a marketplace listing.
  upstream.searchParams.set('version', 'latest');
  upstream.searchParams.set('limit', String(limit));
  if (search) upstream.searchParams.set('search', search);
  if (cursor) upstream.searchParams.set('cursor', cursor);

  const cacheKey = `${upstream.toString()}#${iconsOnly ? 'icons' : 'ranked'}`;
  const cached = getCached(cacheKey);
  if (cached !== null) {
    log.debug(`Cache hit for registry query [${requestId}]`, cacheKey);
    return NextResponse.json({ success: true, ...(cached as object) });
  }

  log.info(`Fetching from MCP Registry [RequestID: ${requestId}]`, cacheKey);

  try {
    const result = await registryGetRaw(upstream, FETCH_TIMEOUT_MS, { maxBytes: 1024 * 1024 });

    if (result.status < 200 || result.status >= 300) {
      log.warn(`Registry returned ${result.status} [${requestId}]`);
      return NextResponse.json(
        {
          success: false,
          error: `MCP Registry responded with status ${result.status}`
        },
        { status: 502 }
      );
    }

    const body = JSON.parse(result.body);

    // Rank + annotate the page by blended quality so the Marketplace shows the
    // best/most-working servers first with star/download badges — the same
    // ranking the headless install path uses. Best-effort; never blocks the
    // listing. Cache the enriched body so repeat searches skip re-enrichment.
    if (Array.isArray(body?.servers) && !iconsOnly) {
      body.servers = await rankRegistryResults(search, body.servers as RegistryServerResult[]);
    }
    setCached(cacheKey, body);

    return NextResponse.json({ success: true, ...body });
  } catch (error) {
    const aborted = error instanceof Error && (error.name === 'AbortError' || /timed out/.test(error.message));
    log.error(`Error fetching from MCP Registry [${requestId}]`, error);
    return NextResponse.json(
      {
        success: false,
        error: aborted
          ? 'Request to the MCP Registry timed out'
          : `Failed to reach the MCP Registry: ${error instanceof Error ? error.message : 'Unknown error'}`
      },
      { status: 502 }
    );
  }
}

/** Search pagination freezes one bounded candidate set and its quality order.
 * No alias fetch or ranking occurs on later pages, even if upstream changes. */
async function discoveryPage(search: string, cursor: string, limit: number, requestId: string) {
  const key = `discovery:${canonicalDiscoveryQuery(search)}`;
  let snapshot = getCached(key) as DiscoverySnapshot | null;
  let offset = 0;
  if (cursor) {
    const parsed = /^d1\.([0-9a-f-]{36})\.(\d{1,3})\.(\d{1,3})$/.exec(cursor);
    if (!parsed || Number(parsed[3]) !== limit || Number(parsed[2]) % limit !== 0) {
      return NextResponse.json({ success: false, error: 'Invalid discovery cursor for this search and page size' }, { status: 400 });
    }
    if (!snapshot || snapshot.id !== parsed[1]) {
      return NextResponse.json({ success: false, error: 'This search expired. Start the search again.' }, { status: 410 });
    }
    offset = Number(parsed[2]);
    if (offset >= snapshot.servers.length) {
      return NextResponse.json({ success: false, error: 'Invalid discovery page offset' }, { status: 400 });
    }
  }
  try {
    if (!snapshot) {
      let pending = pendingSnapshots.get(key);
      if (!pending) {
        if (pendingSnapshots.size >= 8) {
          return NextResponse.json({ success: false, error: 'Registry discovery is busy; try again shortly' }, { status: 503 });
        }
        pending = (async () => {
          const acquired = await discoverRegistryServers(search);
          const servers = await rankRegistryResults(search, acquired.servers);
          const value = { id: uuidv4(), servers, discovery: acquired.discovery };
          setCached(key, value);
          return value;
        })();
        pendingSnapshots.set(key, pending);
      }
      try { snapshot = await pending; }
      finally { if (pendingSnapshots.get(key) === pending) pendingSnapshots.delete(key); }
    }
    const servers = snapshot.servers.slice(offset, offset + limit);
    const next = offset + limit;
    return NextResponse.json({ success: true, servers, metadata: {
      count: servers.length,
      ...(next < snapshot.servers.length ? { nextCursor: `d1.${snapshot.id}.${next}.${limit}` } : {}),
      discovery: snapshot.discovery,
    } });
  } catch (error) {
    log.warn(`Registry discovery failed [${requestId}]`, error);
    return NextResponse.json({ success: false, error: 'Failed to search the MCP Registry. Try again shortly.' }, { status: 502 });
  }
}

export const GET = withWorkspaceRoute(GET_handler);
