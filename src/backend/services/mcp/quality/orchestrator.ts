/**
 * Enrichment orchestrator: turn a set of registry candidates into a best-first
 * ranking by blending the enabled providers' signals.
 *
 * Flow per provider:
 *   1. split applicable candidates into cache-fresh vs stale (24h QualityCache);
 *   2. `prefetch()` the stale ones (each provider does its own bulk/rate-limit-
 *      friendly network there);
 *   3. `fetch()` each stale candidate (a map lookup) and cache the result;
 *   4. reuse cached signals for the fresh ones.
 * Then score each candidate with `compositeScore` over its APPLICABLE providers
 * and sort descending (stable — ties keep registry order).
 *
 * Robustness: this NEVER throws for the caller. A dead/rate-limited provider
 * yields missing signals (score 0, weight kept); a total failure falls back to
 * the original registry order (all scores 0). Only the top `topN` candidates are
 * enriched — the rest are appended unscored in their original order.
 */
import { createLogger } from '@/utils/logger';
import { QualityCache } from './cache';
import { compositeScore, WeightedContribution } from './scorer';
import { ServerCandidate, QualitySignal, ScoredCandidate } from './types';
import { PROVIDERS } from './providers';
import { setGithubToken } from './providers/githubStars';
import {
  McpQualitySettings,
  loadQualitySettings,
  effectiveWeight,
  isProviderEnabled,
} from './settings';

const log = createLogger('backend/services/mcp/quality/orchestrator');

const DEFAULT_TOP_N = 10;
const PREFETCH_TIMEOUT_MS = 12_000;
const FETCH_TIMEOUT_MS = 2_000;

export interface EnrichOptions {
  /** How many top registry hits to enrich (rest appended unscored). Default 10. */
  topN?: number;
  /** Injectable clock for deterministic tests. */
  now?: number;
  /** Pre-loaded settings (tests / callers that already have them). */
  settings?: McpQualitySettings;
}

/** Run `fn` with an abort signal that fires after `ms`. Rejections propagate. */
async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Rank candidates best-first by blended quality. `query` is the search term used
 * by providers that discover in bulk (GitHub search).
 */
export async function enrichAndRank(
  query: string,
  candidates: ServerCandidate[],
  options: EnrichOptions = {}
): Promise<ScoredCandidate[]> {
  const topN = options.topN ?? DEFAULT_TOP_N;
  try {
    const settings = options.settings ?? (await loadQualitySettings());
    const enabled = PROVIDERS.filter((p) => isProviderEnabled(settings, p.id));
    if (enabled.length === 0) {
      return candidates.map((c) => ({ candidate: c, score: 0, signals: [] }));
    }

    // The GitHub provider reads its token from module state; push it in per run.
    setGithubToken(settings.githubToken);

    const head = candidates.slice(0, topN);
    const tail = candidates.slice(topN);
    const cache = new QualityCache(options.now ?? Date.now());
    await cache.load();

    // Per-candidate signal accumulator (index-aligned with `head`).
    const signalsByCandidate: QualitySignal[][] = head.map(() => []);

    for (const provider of enabled) {
      const applicable = head
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => provider.isApplicable(c));

      // Split into cache-fresh (reuse) and stale (needs a fetch).
      const stale: Array<{ c: ServerCandidate; i: number }> = [];
      const cached: Array<{ i: number; signal: QualitySignal }> = [];
      for (const item of applicable) {
        const key = provider.cacheKey(item.c);
        if (key) {
          const hit = cache.get(provider.id, key);
          if (hit) {
            cached.push({ i: item.i, signal: hit });
            continue;
          }
        }
        stale.push(item);
      }

      // Bulk warm-up for the stale set (provider owns its rate-limit strategy).
      if (provider.prefetch && stale.length > 0) {
        try {
          await withTimeout(
            (signal) => provider.prefetch!(query, stale.map((s) => s.c), signal),
            PREFETCH_TIMEOUT_MS
          );
        } catch (error) {
          log.warn(`Provider "${provider.id}" prefetch failed; degrading`, error);
        }
      }

      // Fetch each stale candidate (mostly a warmed-map lookup) and cache it.
      for (const { c, i } of stale) {
        try {
          const signal = await withTimeout((s) => provider.fetch(c, s), FETCH_TIMEOUT_MS);
          if (signal) {
            signalsByCandidate[i].push(signal);
            const key = provider.cacheKey(c);
            if (key) cache.set(provider.id, key, signal);
          }
        } catch (error) {
          log.warn(`Provider "${provider.id}" fetch failed for "${c.registryName}"`, error);
        }
      }

      // Reuse the cache-fresh signals.
      for (const { i, signal } of cached) signalsByCandidate[i].push(signal);
    }

    await cache.flush();

    // Score each head candidate over its APPLICABLE providers.
    const scoredHead: ScoredCandidate[] = head.map((c, i) => {
      const signals = signalsByCandidate[i];
      const byId = new Map(signals.map((s) => [s.providerId, s]));
      const contributions: WeightedContribution[] = enabled
        .filter((p) => p.isApplicable(c))
        .map((p) => ({
          providerId: p.id,
          weight: effectiveWeight(settings, p.id),
          score: byId.get(p.id)?.score ?? 0, // applicable-but-missing → 0, keeps weight
        }));
      const { score } = compositeScore(contributions);
      return { candidate: c, score, signals };
    });

    // Stable sort by score desc; ties fall back to original registry order.
    const rankedHead = scoredHead
      .map((s, idx) => ({ s, idx }))
      .sort((a, b) => b.s.score - a.s.score || a.idx - b.idx)
      .map((x) => x.s);

    const scoredTail: ScoredCandidate[] = tail.map((c) => ({ candidate: c, score: 0, signals: [] }));
    return [...rankedHead, ...scoredTail];
  } catch (error) {
    // Never let ranking break the caller — fall back to registry order.
    log.warn('enrichAndRank failed; returning unranked candidates', error);
    return candidates.map((c) => ({ candidate: c, score: 0, signals: [] }));
  }
}
