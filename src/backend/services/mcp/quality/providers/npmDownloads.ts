/**
 * npm weekly-downloads quality provider — the PRIMARY tokenless popularity
 * signal (most MCP servers ship as npm packages, and api.npmjs.org needs no auth
 * and has no GitHub-style hourly cap). This is the degradation target when
 * GitHub is rate-limited/tokenless.
 *
 * `prefetch()` minimizes requests: unscoped package names go through the
 * comma-batched bulk endpoint (one request per ~100 names); scoped names
 * (@scope/name), which the bulk endpoint doesn't support, are fetched
 * individually. `fetch()` then reads the warmed map.
 */
import { createLogger } from '@/utils/logger';
import { ServerCandidate, QualitySignal, QualitySignalProvider } from '../types';
import { normalizeCount, WEEKLY_DOWNLOADS_SATURATION } from '../scorer';

const log = createLogger('backend/services/mcp/quality/providers/npmDownloads');

export const NPM_PROVIDER_ID = 'npm-downloads';
const NPM_API = 'https://api.npmjs.org';
const REQUEST_TIMEOUT_MS = 6000;
const BULK_CHUNK = 100;

// Warmed by prefetch(), keyed by npm package name → last-week downloads.
const downloads = new Map<string, number>();

/** First npm package identifier declared by the candidate, or null. */
export function npmPackageName(c: ServerCandidate): string | null {
  for (const pkg of c.server.packages ?? []) {
    if (pkg.registryType === 'npm' && pkg.identifier) return pkg.identifier;
  }
  return null;
}

function isScoped(name: string): boolean {
  return name.startsWith('@');
}

async function npmGet(path: string, signal: AbortSignal): Promise<Response | null> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${NPM_API}${path}`, { signal: controller.signal, cache: 'no-store' });
  } catch (error) {
    log.warn(`npm request failed (${path})`, error instanceof Error ? error.message : error);
    return null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

export const npmDownloadsProvider: QualitySignalProvider = {
  id: NPM_PROVIDER_ID,
  label: 'npm Weekly Downloads',
  defaultWeight: 0.35,

  isApplicable(c) {
    return npmPackageName(c) !== null;
  },

  cacheKey(c) {
    return npmPackageName(c);
  },

  async prefetch(_query, candidates, signal) {
    const names = candidates
      .map(npmPackageName)
      .filter((n): n is string => Boolean(n) && !downloads.has(n as string));
    const unscoped = names.filter((n) => !isScoped(n));
    const scoped = names.filter(isScoped);

    // Bulk endpoint for unscoped names (one request per chunk).
    for (let i = 0; i < unscoped.length; i += BULK_CHUNK) {
      const chunk = unscoped.slice(i, i + BULK_CHUNK);
      const res = await npmGet(`/downloads/point/last-week/${chunk.join(',')}`, signal);
      if (!res || !res.ok) continue;
      try {
        const body = (await res.json()) as Record<string, { downloads?: number } | null>;
        // A single-name bulk request returns the point shape directly, not a map.
        if (chunk.length === 1) {
          const one = body as unknown as { package?: string; downloads?: number };
          if (typeof one.downloads === 'number') downloads.set(chunk[0], one.downloads);
        } else {
          for (const name of chunk) {
            const point = body[name];
            downloads.set(name, point && typeof point.downloads === 'number' ? point.downloads : 0);
          }
        }
      } catch (error) {
        log.warn('Failed to parse npm bulk downloads response', error);
      }
    }

    // Scoped names one at a time (bulk endpoint rejects them).
    for (const name of scoped) {
      const res = await npmGet(`/downloads/point/last-week/${name}`, signal);
      if (!res || !res.ok) continue;
      try {
        const body = (await res.json()) as { downloads?: number };
        if (typeof body.downloads === 'number') downloads.set(name, body.downloads);
      } catch {
        /* skip unparseable */
      }
    }
  },

  async fetch(c) {
    const name = npmPackageName(c);
    if (!name) return null;
    const weekly = downloads.get(name);
    if (weekly === undefined) return null;
    return {
      providerId: NPM_PROVIDER_ID,
      score: normalizeCount(weekly, WEEKLY_DOWNLOADS_SATURATION),
      evidence: { package: name, weeklyDownloads: weekly },
    };
  },
};

/** Test-only: reset the warmed map between cases. */
export function __resetNpmProviderState(): void {
  downloads.clear();
}
