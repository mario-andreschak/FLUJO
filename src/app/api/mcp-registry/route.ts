import { NextRequest, NextResponse } from 'next/server';
import http2 from 'http2';
import { createLogger } from '@/utils/logger';
import { v4 as uuidv4 } from 'uuid';

const log = createLogger('app/api/mcp-registry/route');

const REGISTRY_ORIGIN = 'https://registry.modelcontextprotocol.io';
const REGISTRY_LIST_PATH = '/v0.1/servers';
const FETCH_TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 50;

interface CacheEntry {
  timestamp: number;
  body: unknown;
}

// Short-lived in-memory cache so repeated searches (and the initial unfiltered
// listing every user sees first) don't hammer the public registry. The registry
// docs ask aggregators to poll infrequently; per-query caching is our share of that.
const cache = new Map<string, CacheEntry>();

function getCached(key: string): unknown | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.body;
}

function setCached(key: string, body: unknown): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // Evict the oldest entry (Map preserves insertion order)
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { timestamp: Date.now(), body });
}

/**
 * GET a registry URL over HTTP/2.
 *
 * The registry's load balancer reliably answers HTTP/2 but lets HTTP/1.1
 * requests to the API paths stall until timeout (verified: `curl` succeeds in
 * ~0.5s while `curl --http1.1` and Node's HTTP/1.1-only `fetch` hang). Node's
 * built-in http2 client avoids that without extra dependencies.
 */
function http2GetJson(url: URL, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const client = http2.connect(url.origin);
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
      client.close();
    };

    client.setTimeout(timeoutMs, () =>
      finish(() => reject(new Error(`HTTP/2 session timed out after ${timeoutMs}ms`)))
    );
    client.on('error', err => finish(() => reject(err)));

    const req = client.request({
      ':method': 'GET',
      ':path': url.pathname + url.search,
      accept: 'application/json'
    });
    req.setTimeout(timeoutMs, () =>
      finish(() => reject(new Error(`HTTP/2 request timed out after ${timeoutMs}ms`)))
    );
    req.on('error', err => finish(() => reject(err)));

    let status = 0;
    let body = '';
    req.setEncoding('utf8');
    req.on('response', headers => {
      status = Number(headers[':status'] || 0);
    });
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => finish(() => resolve({ status, body })));
    req.end();
  });
}

/** HTTP/1.1 fallback for environments where HTTP/2 is blocked (e.g. some proxies). */
async function http1GetJson(url: URL, timeoutMs: number): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      cache: 'no-store'
    });
    return { status: response.status, body: await response.text() };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * GET /api/mcp-registry — server-side proxy for the official MCP Registry.
 *
 * The browser talks to this route instead of registry.modelcontextprotocol.io
 * directly so we are independent of the registry's CORS policy, can cache, and
 * can work around the HTTP/1.1 issue described at http2GetJson.
 *
 * Query parameters (all optional, passed through):
 *   search — substring match on server name
 *   cursor — pagination cursor from a previous response's metadata.nextCursor
 *   limit  — page size (clamped to 1..100, default 30)
 */
export async function GET(request: NextRequest) {
  const requestId = uuidv4();
  const { searchParams } = new URL(request.url);

  const search = searchParams.get('search') || '';
  const cursor = searchParams.get('cursor') || '';
  const rawLimit = parseInt(searchParams.get('limit') || '30', 10);
  const limit = Math.min(Math.max(Number.isNaN(rawLimit) ? 30 : rawLimit, 1), 100);

  const upstream = new URL(REGISTRY_ORIGIN + REGISTRY_LIST_PATH);
  // Only the latest version of each server is meaningful in a marketplace listing.
  upstream.searchParams.set('version', 'latest');
  upstream.searchParams.set('limit', String(limit));
  if (search) upstream.searchParams.set('search', search);
  if (cursor) upstream.searchParams.set('cursor', cursor);

  const cacheKey = upstream.toString();
  const cached = getCached(cacheKey);
  if (cached !== null) {
    log.debug(`Cache hit for registry query [${requestId}]`, cacheKey);
    return NextResponse.json({ success: true, ...(cached as object) });
  }

  log.info(`Fetching from MCP Registry [RequestID: ${requestId}]`, cacheKey);

  try {
    let result: { status: number; body: string };
    try {
      result = await http2GetJson(upstream, FETCH_TIMEOUT_MS);
    } catch (h2Error) {
      log.warn(
        `HTTP/2 request to registry failed, retrying over HTTP/1.1 [${requestId}]`,
        h2Error instanceof Error ? h2Error.message : h2Error
      );
      result = await http1GetJson(upstream, FETCH_TIMEOUT_MS);
    }

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
