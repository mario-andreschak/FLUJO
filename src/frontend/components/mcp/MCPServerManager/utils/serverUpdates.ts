import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/mcp/MCPServerManager/utils/serverUpdates');

/**
 * Update status of a locally cloned server repository, as reported by the
 * `checkUpdates` / `checkUpdatesBatch` actions of /api/git.
 */
export interface ServerUpdateInfo {
  isGitRepo: boolean;
  /** Repository root; may be an ancestor of the server's rootPath (monorepo clones). */
  repoRoot?: string;
  remoteUrl?: string;
  branch?: string;
  localSha?: string;
  remoteSha?: string;
  updateAvailable: boolean;
  hasLocalChanges: boolean;
  dirtyFiles: string[];
  error?: string;
}

export interface UpdateCommitsPreview {
  behindBy: number | null;
  commits: Array<{ sha: string; message: string }>;
}

export interface PullUpdateResult {
  success: boolean;
  oldSha?: string;
  newSha?: string;
  updated?: boolean;
  error?: string;
}

// Checks hit the network (git ls-remote per repository), so results are cached
// for a while. A manual re-check or a completed update bypasses the cache.
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; info: ServerUpdateInfo }>();

export function invalidateUpdateCache(path?: string): void {
  if (path) {
    cache.delete(path);
  } else {
    cache.clear();
  }
}

/**
 * Check a set of cloned repositories for available updates. Returns a map keyed by
 * repository path. Paths that fail to check come back with `error` set rather than
 * rejecting the whole call.
 */
export async function checkServerUpdates(
  paths: string[],
  force: boolean = false
): Promise<Record<string, ServerUpdateInfo>> {
  const now = Date.now();
  const results: Record<string, ServerUpdateInfo> = {};
  const toFetch: string[] = [];

  for (const p of new Set(paths.filter(Boolean))) {
    const cached = cache.get(p);
    if (!force && cached && now - cached.at < CACHE_TTL_MS) {
      results[p] = cached.info;
    } else {
      toFetch.push(p);
    }
  }

  if (toFetch.length > 0) {
    try {
      const response = await fetch('/api/git', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'checkUpdatesBatch', paths: toFetch }),
      });
      const data = await response.json();
      if (response.ok && data.results) {
        for (const [p, info] of Object.entries<ServerUpdateInfo>(data.results)) {
          cache.set(p, { at: now, info });
          results[p] = info;
        }
      } else {
        log.warn('Batch update check failed', data.error);
      }
    } catch (error) {
      log.warn('Batch update check request failed', error);
    }
  }

  return results;
}

/**
 * Pull the latest commit into a cloned repository (shallow fetch + hard reset,
 * handled server-side). Untracked files like a user-created .env survive.
 */
export async function pullServerUpdate(path: string): Promise<PullUpdateResult> {
  try {
    const response = await fetch('/api/git', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'pullUpdates', savePath: path }),
    });
    const result = await response.json();
    if (!response.ok) {
      return { success: false, error: result.error || 'Failed to pull updates' };
    }
    return { success: true, oldSha: result.oldSha, newSha: result.newSha, updated: result.updated };
  } catch (error) {
    return { success: false, error: (error as Error).message || 'Failed to pull updates' };
  }
}

/**
 * Best-effort preview of what an update contains, via GitHub's compare API.
 * Returns null for non-GitHub remotes, rate-limited responses, or any failure —
 * the update flow works without it.
 */
export async function fetchUpdateCommitsPreview(
  remoteUrl: string,
  localSha: string,
  remoteSha: string
): Promise<UpdateCommitsPreview | null> {
  const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!match) {
    return null;
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${match[1]}/${match[2]}/compare/${localSha}...${remoteSha}`
    );
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    const commits = Array.isArray(data.commits) ? data.commits : [];
    return {
      behindBy: typeof data.total_commits === 'number' ? data.total_commits : null,
      // Newest last in the API response; show the most recent handful.
      commits: commits.slice(-10).reverse().map((c: any) => ({
        sha: (c.sha || '').slice(0, 7),
        message: ((c.commit?.message as string) || '').split('\n')[0],
      })),
    };
  } catch (error) {
    log.debug('GitHub compare preview failed (non-fatal)', error);
    return null;
  }
}

/** Short display form of a commit SHA. */
export function shortSha(sha?: string): string {
  return sha ? sha.slice(0, 7) : '';
}
