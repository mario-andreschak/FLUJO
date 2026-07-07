/**
 * Spotlight service: resolves the shipped curated-server list
 * (src/shared/config/spotlightServers.ts) against the official MCP Registry
 * and caches the results in storage.
 *
 * Refreshes happen at FLUJO startup (fire-and-forget from backend init) and on
 * demand via POST /api/mcp-registry/spotlight — never when the Spotlight tab
 * opens; the tab only reads the cache.
 */
import { SPOTLIGHT_SERVERS, normalizeSpotlightSource } from '@/shared/config/spotlightServers';
import { StorageKey } from '@/shared/types/storage';
import { loadItem, saveItem } from '@/utils/storage/backend';
import {
  SpotlightCache,
  SpotlightEntry,
  firstServerFromResponse,
  spotlightRequestPath
} from '@/utils/mcp/registry';
import { REGISTRY_ORIGIN, registryGetJson } from '@/backend/utils/registryClient';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/services/spotlight');

const FETCH_TIMEOUT_MS = 15000;
// Pause between the sequential registry calls — the registry tarpits
// aggressive clients, and the curated list is small enough that this is cheap.
const INTER_REQUEST_DELAY_MS = 250;

declare global {
  // Deduplicates concurrent refreshes (startup + a manual refresh click).
  // Global-backed for the same reason as __flujo_init_promise: in dev, route
  // bundles can instantiate this module more than once.
  // eslint-disable-next-line no-var
  var __flujo_spotlight_refresh: Promise<SpotlightCache> | undefined;
}

/** The cached spotlight data, or null when no refresh has succeeded yet. */
export async function loadSpotlightCache(): Promise<SpotlightCache | null> {
  return loadItem<SpotlightCache | null>(StorageKey.SPOTLIGHT_SERVERS, null);
}

/**
 * Re-resolve the curated list against the registry and persist the result.
 * Per-entry failures are recorded on the entry rather than failing the run,
 * so one dead URL can't blank the whole tab.
 */
export function refreshSpotlightServers(): Promise<SpotlightCache> {
  if (!global.__flujo_spotlight_refresh) {
    global.__flujo_spotlight_refresh = doRefresh().finally(() => {
      global.__flujo_spotlight_refresh = undefined;
    });
  }
  return global.__flujo_spotlight_refresh;
}

async function doRefresh(): Promise<SpotlightCache> {
  const sources = SPOTLIGHT_SERVERS.map(normalizeSpotlightSource);
  log.info(`Refreshing spotlight servers (${sources.length} entries)`);
  const entries: SpotlightEntry[] = [];

  for (const source of sources) {
    // env defaults always come from the current shipped config — never from a
    // previous cache — so stale defaults can't survive a code update.
    const { url, env } = source;
    const requestPath = spotlightRequestPath(url);
    if (!requestPath) {
      log.warn(`Unrecognized spotlight URL format: ${url}`);
      entries.push({ url, env, error: 'Unrecognized spotlight URL format' });
      continue;
    }

    try {
      const body = await registryGetJson(new URL(REGISTRY_ORIGIN + requestPath), FETCH_TIMEOUT_MS);
      const result = firstServerFromResponse(body);
      if (result) {
        entries.push({ url, env, result });
      } else {
        log.warn(`Spotlight URL resolved to no server: ${url}`);
        entries.push({ url, env, error: 'No matching server found in the registry' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      log.warn(`Failed to resolve spotlight URL ${url}: ${message}`);
      entries.push({ url, env, error: message });
    }

    await new Promise(resolve => setTimeout(resolve, INTER_REQUEST_DELAY_MS));
  }

  const cache: SpotlightCache = {
    updatedAt: new Date().toISOString(),
    entries
  };

  // Keep the previous good record for entries that failed this time, so a
  // transient registry outage doesn't empty the tab until the next refresh.
  const previous = await loadSpotlightCache();
  if (previous) {
    for (const entry of cache.entries) {
      if (!entry.result) {
        const old = previous.entries.find(e => e.url === entry.url && e.result);
        if (old?.result) {
          entry.result = old.result;
        }
      }
    }
  }

  await saveItem(StorageKey.SPOTLIGHT_SERVERS, cache);
  const resolved = cache.entries.filter(e => e.result).length;
  log.info(`Spotlight refresh complete: ${resolved}/${cache.entries.length} entries resolved`);
  return cache;
}
