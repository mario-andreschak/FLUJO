import { REGISTRY_ORIGIN, registryGetJson } from '@/backend/utils/registryClient';
import { discoveryRelevance, discoverySearchTerms, canonicalDiscoveryQuery } from '@/shared/mcpDiscoverySearch';
import { supportedRegistrySearches } from '@/shared/mcpRecommendationPreferences';
import type { RegistryServerResult } from '@/utils/mcp/registry';

const TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 12;
const MAX_ACTIVE_SEARCHES = 8;
const TERM_LIMIT = 30;
const RESPONSE_BYTES = 256 * 1024;
const RESULT_BYTES = 16 * 1024;
const CACHE_BYTES = 8 * 1024 * 1024;

export interface RegistryDiscoveryResult {
  servers: RegistryServerResult[];
  discovery: {
    /** Aliases acquire bounded pages, not a complete semantic Registry index. */
    bounded: true;
    terms: string[];
    partial: boolean;
    truncated: boolean;
  };
}

const cache = new Map<string, { expiresAt: number; value: RegistryDiscoveryResult; bytes: number }>();
let cacheBytes = 0;
const pending = new Map<string | symbol, Promise<RegistryDiscoveryResult>>();

function deleteCached(key: string): void {
  const existing = cache.get(key);
  if (existing) cacheBytes -= existing.bytes;
  cache.delete(key);
}

/** Bounded read-only acquisition; duplicate concurrent searches share a request. */
export async function discoverRegistryServers(query: string, signal?: AbortSignal, extraTerms: readonly string[] = []): Promise<RegistryDiscoveryResult> {
  signal?.throwIfAborted();
  const canonical = canonicalDiscoveryQuery(query);
  if (canonical.length > 256) throw new Error('Discovery search must be at most 256 characters');
  const aliases = [...new Set(extraTerms.filter(term => typeof term === 'string').map(term => canonicalDiscoveryQuery(term).slice(0, 80)).filter(Boolean))].slice(0, 6);
  const key = aliases.length ? JSON.stringify([canonical, aliases]) : canonical;
  const stored = cache.get(key);
  if (stored && stored.expiresAt > Date.now()) return structuredClone(stored.value);
  deleteCached(key);
  const existing = signal ? undefined : pending.get(key);
  if (existing) return structuredClone(await existing);
  if (pending.size >= MAX_ACTIVE_SEARCHES) throw new Error('MCP Registry discovery is busy; try again shortly');
  const operation = acquire(canonical, signal, aliases);
  const operationKey = signal ? Symbol(key) : key;
  pending.set(operationKey, operation);
  try {
    const value = await operation;
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (!value.discovery.partial && bytes <= CACHE_BYTES) {
      while (cache.size >= MAX_CACHE_ENTRIES || cacheBytes + bytes > CACHE_BYTES) deleteCached(cache.keys().next().value!);
      deleteCached(key);
      cache.set(key, { expiresAt: Date.now() + TTL_MS, value, bytes });
      cacheBytes += bytes;
    }
    return structuredClone(value);
  } finally {
    pending.delete(operationKey);
  }
}

async function acquire(query: string, signal?: AbortSignal, extraTerms: readonly string[] = []): Promise<RegistryDiscoveryResult> {
  const preferred = query.includes('/') ? [] : supportedRegistrySearches(query).slice(0, 2);
  const lexical = discoverySearchTerms(query);
  const terms = query.includes('/') ? lexical : [...new Set([...preferred, ...lexical.slice(0, 2), ...extraTerms, ...lexical])].slice(0, 6);
  if (!terms.length) return { servers: [], discovery: { bounded: true, terms, partial: false, truncated: false } };
  const pages = await Promise.allSettled(terms.map(async term => {
    const url = new URL('/v0.1/servers', REGISTRY_ORIGIN);
    url.searchParams.set('version', 'latest');
    url.searchParams.set('limit', String(TERM_LIMIT));
    url.searchParams.set('search', term);
    const data = await registryGetJson(url, 15_000, { maxBytes: RESPONSE_BYTES, ...(signal ? { signal } : {}) }) as {
      servers?: unknown;
      metadata?: { nextCursor?: unknown };
    };
    if (!data || !Array.isArray(data.servers) || data.servers.length > TERM_LIMIT) {
      throw new Error('MCP Registry returned an invalid discovery page');
    }
    return data;
  }));
  signal?.throwIfAborted();
  if (pages.every(page => page.status === 'rejected')) throw new Error('Failed to reach the MCP Registry for discovery');
  const unique = new Map<string, RegistryServerResult>();
  let partial = pages.some(page => page.status === 'rejected');
  let truncated = false;
  for (const page of pages) {
    if (page.status !== 'fulfilled') continue;
    truncated ||= typeof page.value.metadata?.nextCursor === 'string' && page.value.metadata.nextCursor.length > 0;
    for (const value of page.value.servers as unknown[]) {
      if (!validResult(value)) { partial = true; continue; }
      if (value._meta?.['io.modelcontextprotocol.registry/official']?.isLatest === false) continue;
      if (['deleted', 'deprecated'].includes(value._meta?.['io.modelcontextprotocol.registry/official']?.status ?? '')) continue;
      if (discoveryRelevance(query, value.server) <= 0) continue;
      const name = value.server.name;
      const old = unique.get(name);
      // Parallel alias pages may race a publish; keep the newest dated receipt.
      const timestamp = (entry: RegistryServerResult) => Date.parse(entry._meta?.['io.modelcontextprotocol.registry/official']?.publishedAt ?? '') || 0;
      if (!old || timestamp(value) > timestamp(old)) unique.set(name, value);
    }
  }
  const servers = [...unique.values()].sort((a, b) =>
    Number(preferred.includes(b.server.name)) - Number(preferred.includes(a.server.name))
    || discoveryRelevance(query, b.server) - discoveryRelevance(query, a.server)
    || a.server.name.localeCompare(b.server.name, 'en'));
  // Preserve usable partial results, but never turn all failed/invalid pages
  // into a successful empty list or cache an outage for five minutes.
  if (partial && !servers.length) throw new Error('MCP Registry discovery was incomplete; try again');
  return { servers, discovery: { bounded: true, terms, partial, truncated } };
}

function validResult(value: unknown): value is RegistryServerResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as RegistryServerResult;
  const official = result._meta?.['io.modelcontextprotocol.registry/official'];
  return !!result.server && typeof result.server.name === 'string' && result.server.name.length > 0
    && result.server.name.length <= 256
    && (result.server.title === undefined || typeof result.server.title === 'string')
    && (result.server.description === undefined || typeof result.server.description === 'string')
    && (result.server.packages === undefined || (Array.isArray(result.server.packages) && result.server.packages.every(pkg =>
      !!pkg && typeof pkg === 'object' && typeof pkg.registryType === 'string' && typeof pkg.identifier === 'string'
      && validInputs(pkg.environmentVariables)
      && (pkg.transport === undefined || (!!pkg.transport && typeof pkg.transport === 'object'
        && (pkg.transport.type === undefined || typeof pkg.transport.type === 'string'))))))
    && (result.server.remotes === undefined || (Array.isArray(result.server.remotes) && result.server.remotes.every(remote =>
      !!remote && typeof remote === 'object' && typeof remote.type === 'string' && typeof remote.url === 'string' && validInputs(remote.headers))))
    && (result.server.icons === undefined || (Array.isArray(result.server.icons) && result.server.icons.every(icon =>
      !!icon && typeof icon === 'object' && typeof icon.src === 'string')))
    && (result.server.repository === undefined || (!!result.server.repository && typeof result.server.repository === 'object'
      && (result.server.repository.url === undefined || typeof result.server.repository.url === 'string')))
    && (result._meta === undefined || (!!result._meta && typeof result._meta === 'object' && !Array.isArray(result._meta)))
    && (official === undefined || (!!official && typeof official === 'object' && !Array.isArray(official)
      && (official.isLatest === undefined || typeof official.isLatest === 'boolean')
      && (official.status === undefined || typeof official.status === 'string')
      && (official.publishedAt === undefined || typeof official.publishedAt === 'string')))
    && Buffer.byteLength(JSON.stringify(result), 'utf8') <= RESULT_BYTES;
}

function validInputs(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(input =>
    !!input && typeof input === 'object' && typeof input.name === 'string'
    && (input.isRequired === undefined || typeof input.isRequired === 'boolean')
    && (input.isSecret === undefined || typeof input.isSecret === 'boolean')));
}
