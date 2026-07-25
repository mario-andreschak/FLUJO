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
import { fileURLToPath } from 'url';
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
 * Resolve one raw root entry (a filesystem path, a `file://` URI, or a string
 * containing `${global:VAR}` references) into an absolute host path. Relative
 * paths resolve against the FLUJO data directory — the same posture the tools
 * themselves use for relative user paths. Returns null for blank/invalid input.
 */
async function resolveRootToPath(entry: string, dataDir: string): Promise<string | null> {
  const { resolveGlobalVars } = await import('@/backend/utils/resolveGlobalVars');
  const resolved = ((await resolveGlobalVars(entry)) as string).trim();
  if (!resolved) return null;
  if (resolved.startsWith('file://')) {
    try {
      return path.resolve(fileURLToPath(resolved));
    } catch (err) {
      log.warn(`resolveRootToPath: could not parse file URI "${resolved}"`, err);
      return null;
    }
  }
  return path.isAbsolute(resolved) ? path.resolve(resolved) : path.resolve(dataDir, resolved);
}

/**
 * The effective confinement roots for a built-in server, or an empty array when
 * no roots are configured (disallowing all access by default).
 *
 * The candidate set is the UNION of two sources:
 *  - persisted server-level roots (MCP manager override, issue #170), and
 *  - node-level roots contributed by FlowBuilder MCP nodes bound to this server
 *    (issue 46). Built-in servers enforce confinement directly (they never go
 *    through the `roots/list` protocol handler), so without this merge a root
 *    added on an MCP node would be silently ignored.
 *
 * Precedence (per issue #170 D5): the env var(s) are a HARD CEILING.
 *  - No env, no configured roots -> [] (no access by default).
 *  - No env, configured roots    -> confine to those roots.
 *  - Env set                     -> configured roots may only NARROW within the
 *                                   ceiling; any root outside the env is dropped,
 *                                   and if none remain the env roots themselves
 *                                   are the effective set.
 */
export async function loadEffectiveRoots(
  serverName: string,
  envVarNames: string | string[]
): Promise<string[]> {
  const { getDataDir } = await import('@/utils/paths');
  const dataDir = getDataDir();
  const env = envRoots(envVarNames);

  const candidates: string[] = [];
  try {
    for (const r of await getInternalServerRoots(serverName)) {
      candidates.push(path.isAbsolute(r) ? path.resolve(r) : path.resolve(dataDir, r));
    }
  } catch (err) {
    log.warn('loadEffectiveRoots: could not read persisted roots', err);
  }
  try {
    // Node-level roots (issue 46) are contributed by FlowBuilder MCP nodes and may
    // be paths, file:// URIs, or contain ${global:VAR} references — resolve them the
    // same way the roots/list handler does so both consumers agree.
    const { getNodeRoots } = await import('@/backend/services/mcp/roots');
    for (const raw of getNodeRoots(serverName)) {
      const resolved = await resolveRootToPath(raw, dataDir);
      if (resolved) candidates.push(resolved);
    }
  } catch (err) {
    log.warn('loadEffectiveRoots: could not read node roots', err);
  }

  const configured = Array.from(new Set(candidates));
  if (!env) return configured;
  const confined = configured.filter((p) => env.some((root) => isInside(root, p)));
  return confined.length ? confined : env;
}
