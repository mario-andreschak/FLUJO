/**
 * GitHub quality provider — covers BOTH stars and recency from one source.
 *
 * Rate-limit posture (the whole reason this provider exists in this shape):
 * unauthenticated GitHub REST is 60 req/hr, so firing one `/repos/{o}/{r}` per
 * candidate exhausts the budget fast during unattended batch installs. Instead
 * `prefetch()` does ONE `/search/repositories?q=<term> mcp&sort=stars&order=desc`
 * request — up to 50 repos, pre-sorted by stars, each already carrying
 * `stargazers_count` + `pushed_at`. Candidates are joined to that result by their
 * `repository.url`, so stars/recency cost ZERO extra requests. `fetch()` is then
 * a pure map lookup.
 *
 * A bounded per-repo fallback (≤3 direct lookups) runs ONLY when a token is
 * configured — tokenless (the common case) stays at exactly one search request.
 * A token (settings first, then GITHUB_TOKEN env) merely lifts 60→5000/hr; it is
 * never required — public star counts are public data.
 */
import { createLogger } from '@/utils/logger';
import { ServerCandidate, QualitySignal, QualitySignalProvider } from '../types';
import { normalizeCount, normalizeRecency, clamp01, STARS_SATURATION } from '../scorer';

const log = createLogger('backend/services/mcp/quality/providers/githubStars');

export const GITHUB_PROVIDER_ID = 'github';
const GITHUB_API = 'https://api.github.com';
const SEARCH_PER_PAGE = 50;
const MAX_DIRECT_LOOKUPS = 3; // only used when a token is present
const REQUEST_TIMEOUT_MS = 6000;
// Internal blend of this provider's two dimensions into one 0..1 score.
const STARS_WEIGHT = 0.7;
const RECENCY_WEIGHT = 0.3;

interface RepoStats {
  stars: number;
  pushedAtMs: number | null;
}

// Warmed by prefetch(), keyed by lowercased "owner/repo". Module-level so
// fetch() can read it; entries only accumulate within a run and are backed by
// the persistent QualityCache across runs, so concurrent searches can't corrupt
// each other (worst case they add each other's repos).
const repoStats = new Map<string, RepoStats>();

let configuredToken: string | undefined;

/** Set (or clear) the GitHub token the provider uses. Called by the orchestrator. */
export function setGithubToken(token: string | undefined): void {
  configuredToken = token && token.length > 0 ? token : undefined;
}

function activeToken(): string | undefined {
  return configuredToken ?? (process.env.GITHUB_TOKEN || undefined);
}

/** Parse "owner/repo" (lowercased) from a repository URL, or null if not GitHub. */
export function parseGithubRepo(url: string | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url.replace(/^git\+/, ''));
  } catch {
    return null;
  }
  if (!/(^|\.)github\.com$/i.test(parsed.hostname)) return null;
  const parts = parsed.pathname.replace(/\.git$/i, '').split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[0]}/${parts[1]}`.toLowerCase();
}

function candidateRepo(c: ServerCandidate): string | null {
  const repo = c.server.repository;
  // Honor an explicit non-github source, but also just try to parse the url.
  if (repo?.source && repo.source.toLowerCase() !== 'github') return null;
  return parseGithubRepo(repo?.url);
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'FLUJO-mcp-quality',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = activeToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** GET with a bounded timeout, chained to an external abort signal. */
async function githubGet(path: string, signal: AbortSignal): Promise<Response | null> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${GITHUB_API}${path}`, {
      headers: githubHeaders(),
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (error) {
    log.warn(`GitHub request failed (${path})`, error instanceof Error ? error.message : error);
    return null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/** True when the response indicates the rate limit is exhausted (stop, don't retry). */
function isRateLimited(res: Response): boolean {
  return (
    (res.status === 403 || res.status === 429) &&
    res.headers.get('x-ratelimit-remaining') === '0'
  );
}

export const githubProvider: QualitySignalProvider = {
  id: GITHUB_PROVIDER_ID,
  label: 'GitHub Stars & Activity',
  defaultWeight: 0.5,

  isApplicable(c) {
    return candidateRepo(c) !== null;
  },

  cacheKey(c) {
    return candidateRepo(c);
  },

  async prefetch(query, candidates, signal) {
    // 1) One search, sorted by stars desc — the rate-limit-friendly bulk path.
    const term = `${query ?? ''} mcp`.trim();
    const search = `/search/repositories?q=${encodeURIComponent(term)}&sort=stars&order=desc&per_page=${SEARCH_PER_PAGE}`;
    const res = await githubGet(search, signal);
    if (res && res.ok) {
      try {
        const body = (await res.json()) as { items?: Array<{ full_name?: string; stargazers_count?: number; pushed_at?: string }> };
        for (const item of body.items ?? []) {
          if (!item.full_name) continue;
          repoStats.set(item.full_name.toLowerCase(), {
            stars: typeof item.stargazers_count === 'number' ? item.stargazers_count : 0,
            pushedAtMs: item.pushed_at ? Date.parse(item.pushed_at) : null,
          });
        }
      } catch (error) {
        log.warn('Failed to parse GitHub search response', error);
      }
    } else if (res && isRateLimited(res)) {
      log.warn('GitHub search rate-limited; ranking will degrade to other providers');
      return; // no point attempting direct lookups
    }

    // 2) Bounded direct lookups for candidates the search missed — ONLY with a
    //    token, so the tokenless path stays at exactly one request.
    if (!activeToken()) return;
    let budget = MAX_DIRECT_LOOKUPS;
    for (const c of candidates) {
      if (budget <= 0) break;
      const repo = candidateRepo(c);
      if (!repo || repoStats.has(repo)) continue;
      budget -= 1;
      const repoRes = await githubGet(`/repos/${repo}`, signal);
      if (!repoRes) continue;
      if (isRateLimited(repoRes)) break;
      if (!repoRes.ok) continue;
      try {
        const r = (await repoRes.json()) as { stargazers_count?: number; pushed_at?: string };
        repoStats.set(repo, {
          stars: typeof r.stargazers_count === 'number' ? r.stargazers_count : 0,
          pushedAtMs: r.pushed_at ? Date.parse(r.pushed_at) : null,
        });
      } catch {
        /* skip unparseable repo response */
      }
    }
  },

  async fetch(c) {
    const repo = candidateRepo(c);
    if (!repo) return null;
    const stats = repoStats.get(repo);
    if (!stats) return null; // search didn't surface it and no token fallback hit
    const starsScore = normalizeCount(stats.stars, STARS_SATURATION);
    const recencyScore = normalizeRecency(stats.pushedAtMs, Date.now());
    const score = clamp01(STARS_WEIGHT * starsScore + RECENCY_WEIGHT * recencyScore);
    const signal: QualitySignal = {
      providerId: GITHUB_PROVIDER_ID,
      score,
      evidence: {
        repo,
        stars: stats.stars,
        ...(stats.pushedAtMs ? { pushedAt: new Date(stats.pushedAtMs).toISOString() } : {}),
        starsScore,
        recencyScore,
      },
    };
    return signal;
  },
};

/** Test-only: reset the warmed map between cases. */
export function __resetGithubProviderState(): void {
  repoStats.clear();
  configuredToken = undefined;
}
