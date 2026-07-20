/**
 * Shared filesystem-confinement helpers for the built-in MCP servers
 * (issues #170 + #175).
 *
 * Both the `filesystem` and `bash` built-in servers confine host access with the
 * SAME two-layer model, so the logic lives here once instead of being duplicated
 * (and drifting) across the two tool modules:
 *
 *  - an operator "hard ceiling" read from environment variable(s) — no path may
 *    ever escape it, and
 *  - user-configured roots persisted via the MCP manager UI, which may only
 *    NARROW within the env ceiling (never widen it).
 *
 * When neither is set the server is unconfined (full host access).
 */
import path from 'path';
import { createLogger } from '@/utils/logger';
import { getInternalServerRoots } from './registry';

const log = createLogger('backend/services/mcp/internal/confinement');

/** True when `candidate` is `root` itself or a path nested inside it. */
export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Confinement roots read from the given env var(s) — an operator HARD CEILING —
 * or null when none are set. When multiple names are given the FIRST one that is
 * set wins (e.g. bash prefers `FLUJO_BASH_ROOTS` but falls back to
 * `FLUJO_FS_ROOTS` so an existing filesystem ceiling also confines bash).
 */
export function envRoots(envVarNames: string | string[]): string[] | null {
  const names = Array.isArray(envVarNames) ? envVarNames : [envVarNames];
  for (const name of names) {
    const raw = process.env[name];
    if (!raw || !raw.trim()) continue;
    const list = raw
      .split(path.delimiter)
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => path.resolve(r));
    if (list.length) return list;
  }
  return null;
}

/**
 * The effective confinement roots for a built-in server, or null when unconfined.
 *
 * Precedence (per issue #170 D5): the env var(s) are a HARD CEILING.
 *  - No env, no persisted roots  -> null (full host access).
 *  - No env, persisted roots     -> confine to the persisted roots.
 *  - Env set                     -> persisted roots may only NARROW within the
 *                                   ceiling; any persisted root outside the env
 *                                   is dropped, and if none remain the env roots
 *                                   themselves are the effective set.
 */
export async function loadEffectiveRoots(
  serverName: string,
  envVarNames: string | string[]
): Promise<string[] | null> {
  const env = envRoots(envVarNames);
  let persisted: string[] = [];
  try {
    persisted = (await getInternalServerRoots(serverName)).map((r) => path.resolve(r));
  } catch (err) {
    log.warn('loadEffectiveRoots: could not read persisted roots', err);
  }
  if (!env) return persisted.length ? persisted : null;
  const confined = persisted.filter((p) => env.some((root) => isInside(root, p)));
  return confined.length ? confined : env;
}
