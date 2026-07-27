/**
 * Default protected-path denylist for the built-in `filesystem` and `bash`
 * servers (issue #260), modelled on opencode's `protected.ts`.
 *
 * FLUJO's existing confinement (see `confinement.ts`) is ALLOW-LIST only: when an
 * operator widens `FLUJO_FS_ROOTS`/persisted roots to e.g. `C:\Users\<name>` or
 * `/`, the built-in servers gain unbounded access to home documents, mail,
 * browser profiles and SSH keys with no backstop.
 *
 * This module adds a second, ALWAYS-APPLIED deny layer that runs BEFORE the
 * allow-list check and cannot be widened by a flow, node config, tool argument,
 * or the model. It fires even when a configured root would otherwise permit the
 * path. It is overridable ONLY by an explicit operator env var
 * (`FLUJO_ALLOW_PROTECTED_PATHS=1`), which is unreachable from a flow or model.
 *
 * The denied set is a hardcoded, platform-specific list derived from the user's
 * home directory. It is intentionally NOT sourced from any configurable roots.
 */
import path from 'path';
import os from 'os';
import { getHomeDir, getDataDir } from '@/utils/paths';
import { isInside } from './confinement';

/** A truthy operator env flag: "1", "true", "yes", "on" (case-insensitive). */
function isTruthyEnv(value: string | undefined): boolean {
  return typeof value === 'string' && /^(1|true|yes|on)$/i.test(value.trim());
}

/**
 * The env var an operator sets to DISABLE the protected-path deny layer entirely.
 * Env-only by design so a flow or the model can never reach it.
 */
export const ALLOW_PROTECTED_PATHS_ENV = 'FLUJO_ALLOW_PROTECTED_PATHS';

/**
 * Cache keyed by (home dir + override flag) so tests that mock `getHomeDir()` or
 * patch the override env var see a fresh computation, while normal runtime calls
 * stay memoized.
 */
let cache: { key: string; paths: string[] } | null = null;

/**
 * Compute the platform-specific denied absolute paths, all pre-normalized with
 * `path.resolve()`. Returns `[]` when the operator override env var is set.
 */
export function getProtectedPaths(): string[] {
  const overridden = isTruthyEnv(process.env[ALLOW_PROTECTED_PATHS_ENV]);
  const home = getHomeDir();
  const key = `${overridden ? 'off' : 'on'}::${home}`;
  if (cache && cache.key === key) return cache.paths;

  const paths = overridden ? [] : computeProtectedPaths(home);
  cache = { key, paths };
  return paths;
}

function underHome(home: string, ...segments: string[]): string {
  return path.resolve(home, ...segments);
}

function computeProtectedPaths(home: string): string[] {
  const list: string[] = [];

  if (process.platform === 'win32') {
    for (const dir of ['AppData', 'Downloads', 'Desktop', 'Documents', 'Pictures', 'Music', 'Videos', 'OneDrive']) {
      list.push(underHome(home, dir));
    }
  } else if (process.platform === 'darwin') {
    for (const dir of ['Downloads', 'Desktop', 'Documents', 'Pictures', 'Music', 'Movies']) {
      list.push(underHome(home, dir));
    }
    for (const dir of [
      'Library/Mail',
      'Library/Messages',
      'Library/Safari',
      'Library/Cookies',
      'Library/Calendars',
      'Library/Application Support/AddressBook',
      'Library/Application Support/com.apple.TCC',
      'Library/PersonalizationPortrait',
      'Library/Metadata/CoreSpotlight',
      'Library/Suggestions',
    ]) {
      list.push(underHome(home, dir));
    }
    // Volume metadata dirs (as opencode lists).
    for (const abs of ['/.Spotlight-V100', '/.fseventsd', '/.DocumentRevisions-V100']) {
      list.push(path.resolve(abs));
    }
  } else {
    // Linux / other: conservative default. Kept minimal so it can be tuned per
    // desktop environment without over-blocking.
    for (const dir of ['Documents', 'Downloads', 'Desktop', '.ssh', '.gnupg', '.aws', '.config']) {
      list.push(underHome(home, dir));
    }
  }

  return Array.from(new Set(list));
}

/**
 * Paths the deny layer must NEVER block even when they sit under a protected
 * location: FLUJO's own data/working directory (the default confinement root)
 * and the OS temp dir. On Windows the temp dir lives under `AppData\Local\Temp`
 * and a git-checkout install often lives under `Documents`, so without these
 * carve-outs FLUJO would deny its own working tree and scratch space.
 */
function exemptRoots(): string[] {
  const roots: string[] = [];
  try {
    roots.push(path.resolve(getDataDir()));
  } catch {
    /* ignore */
  }
  try {
    roots.push(path.resolve(os.tmpdir()));
  } catch {
    /* ignore */
  }
  return roots;
}

/**
 * True when `candidate` equals or is nested inside any protected path, using the
 * same `isInside()` semantics the allow-list uses (so Windows case-insensitivity
 * is consistent). Returns the matched protected root for a clear error message.
 * The FLUJO data dir and OS temp dir are always exempt (see `exemptRoots`).
 */
export function isProtected(candidate: string): { denied: boolean; matchedRoot?: string } {
  const resolved = path.resolve(candidate);
  if (exemptRoots().some((root) => isInside(root, resolved))) return { denied: false };
  for (const root of getProtectedPaths()) {
    if (isInside(root, resolved)) return { denied: true, matchedRoot: root };
  }
  return { denied: false };
}

/** Test-only: clear the memoization cache. */
export function __resetProtectedPathsCache(): void {
  cache = null;
}
