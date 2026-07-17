import { promises as fs } from 'fs';
import path from 'path';
import { createLogger } from '@/utils/logger';
import { getDataDir } from '@/utils/paths';
import { loadItem, writeFileAtomic, runInWriteChain } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import {
  KvEntry,
  KvScopeId,
  KvStoreSettings,
  DEFAULT_KV_STORE_SETTINGS,
} from '@/shared/types/kvStore';

/**
 * Persistent (cross-run) key-value store — Tier 4 state (`${kv:NAME}`).
 *
 * Persists small plain-string scalars that SURVIVE ACROSS FLOW RUNS under
 *   db/kv-store/<scope>/index.json   (KvEntry[] — values inline, no payload files)
 * and serves them back to the engine (`resolveKvNodeRefs`) and the internal
 * `flujo` MCP tools (`kv_get`/`kv_set`).
 *
 * Mirrors the shape of `services/runResources` (global-backed cache, atomic
 * writes, per-scope write-chain, SAFE_ID path-traversal gate). The one genuinely
 * new concern versus run-scoped vars is CONCURRENCY across runs — two scheduled
 * pulses writing the same scope must not corrupt the index. This is handled by
 * `mutateIndex`, which runs the WHOLE read-modify-write inside a single
 * `runInWriteChain(chainKey(scope), ...)` critical section, so no await boundary
 * lets a concurrent writer to the same scope observe a stale base index (a lost
 * update). Writes to DIFFERENT scopes still run in parallel (distinct keys).
 *
 * Deliberately dependency-light: this module must never import mcpService or
 * flow modules (both import THIS), to stay out of the internalTools import cycle.
 *
 * Writes NEVER throw at a run: `kvSet` returns a `{ skipped }` marker when a cap
 * or the master switch refuses the write, and call sites treat that as a no-op.
 */

const log = createLogger('backend/services/kvStore');

// Mutable so tests can point the store at a temp directory (same seam as
// runResources' _setRunResourcesDirForTests).
let kvStoreDir = path.join(getDataDir(), 'db', 'kv-store');

// Scope ids and key names become directory / index-entry names; they must pass
// the same gate as storage collection ids so nothing can escape the store dir
// (path traversal). Windows-safe: only these shapes ever reach the filesystem.
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function assertSafeScope(scope: string): void {
  if (typeof scope !== 'string' || !SAFE_ID.test(scope)) {
    throw new Error(`Unsafe kv scope id: ${JSON.stringify(scope)}`);
  }
}

function assertSafeName(name: string): void {
  if (typeof name !== 'string' || !SAFE_ID.test(name)) {
    throw new Error(`Unsafe kv key name: ${JSON.stringify(name)}`);
  }
}

const scopeDir = (scope: KvScopeId) => path.join(kvStoreDir, scope);
const indexPath = (scope: KvScopeId) => path.join(scopeDir(scope), 'index.json');
const chainKey = (scope: KvScopeId) => `kv-store/${scope}`;

// --- Settings ---------------------------------------------------------------

let settingsCache: { value: KvStoreSettings; at: number } | null = null;
const SETTINGS_TTL_MS = 30_000;

export async function getKvStoreSettings(): Promise<KvStoreSettings> {
  if (settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL_MS) {
    return settingsCache.value;
  }
  let value: KvStoreSettings;
  try {
    const stored = await loadItem<Partial<KvStoreSettings>>(
      StorageKey.KV_STORE_SETTINGS,
      DEFAULT_KV_STORE_SETTINGS
    );
    value = { ...DEFAULT_KV_STORE_SETTINGS, ...stored };
  } catch (error) {
    log.warn('Failed to load kv-store settings; using defaults', error);
    value = DEFAULT_KV_STORE_SETTINGS;
  }
  settingsCache = { value, at: Date.now() };
  return value;
}

/** Test seam: drop the settings cache. */
export function _clearKvStoreSettingsCache(): void {
  settingsCache = null;
}

// --- Index cache -------------------------------------------------------------

// Global-backed like runResources' __flujo_run_resources: Next.js can
// instantiate this module more than once and every instance must share the
// cache. Disk is the cold-start source of truth.
declare global {
  // eslint-disable-next-line no-var
  var __flujo_kv_store: Map<string, KvEntry[]> | undefined;
}
const indexCache: Map<string, KvEntry[]> =
  global.__flujo_kv_store ?? (global.__flujo_kv_store = new Map());

async function loadIndex(scope: KvScopeId): Promise<KvEntry[]> {
  const cached = indexCache.get(scope);
  if (cached) return cached;
  let entries: KvEntry[] = [];
  try {
    const content = await fs.readFile(indexPath(scope), 'utf-8');
    if (content.trim().length > 0) {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) entries = parsed as KvEntry[];
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.error(`Failed to read kv index for scope ${scope}; treating as empty`, error);
    }
  }
  indexCache.set(scope, entries);
  return entries;
}

/**
 * Run the ENTIRE read-modify-write inside one runInWriteChain(chainKey(scope))
 * critical section. `loadIndex` happens INSIDE the chain, so two concurrent
 * writers to the same scope are strictly serialized and neither can clobber the
 * other's write (the lost-update bug). The mutator returns the new array plus a
 * result value; when it returns the SAME array reference (a no-op) no disk
 * write happens. Different scopes use different chain keys and stay parallel.
 */
async function mutateIndex<T>(
  scope: KvScopeId,
  mutator: (entries: KvEntry[]) => { next: KvEntry[]; result: T }
): Promise<T> {
  return runInWriteChain(chainKey(scope), async () => {
    const entries = await loadIndex(scope);
    const { next, result } = mutator(entries);
    if (next !== entries) {
      indexCache.set(scope, next);
      await fs.mkdir(scopeDir(scope), { recursive: true });
      await writeFileAtomic(indexPath(scope), JSON.stringify(next, null, 2));
    }
    return result;
  });
}

/** An entry is live when it has no TTL or the TTL is still in the future. */
function isLive(entry: KvEntry, now: number): boolean {
  return typeof entry.expiresAt !== 'number' || entry.expiresAt > now;
}

// --- Store API ---------------------------------------------------------------

export type KvSetResult =
  | KvEntry
  | { skipped: 'disabled' | 'size-cap' | 'scope-cap' | 'keys-cap' };

/**
 * Set (create or overwrite) a key on a board. Last-write-wins, mirroring
 * captureVariable/captureResource. Returns a `{ skipped }` marker (never throws)
 * when the master switch or a cap refuses the write.
 */
export async function kvSet(
  scope: KvScopeId,
  name: string,
  value: string,
  options?: { expiresAt?: number }
): Promise<KvSetResult> {
  assertSafeScope(scope);
  assertSafeName(name);
  const settings = await getKvStoreSettings();
  if (!settings.enabled) return { skipped: 'disabled' };

  const str = typeof value === 'string' ? value : String(value ?? '');
  const size = Buffer.byteLength(str, 'utf8');
  if (size > settings.maxValueBytes) {
    log.warn(`kv write skipped (size ${size} > cap ${settings.maxValueBytes})`, { scope, name });
    return { skipped: 'size-cap' };
  }

  // The read (loadIndex), the cap checks that depend on the current index, and
  // the compute of `next` all run INSIDE one per-scope critical section, so a
  // concurrent writer to the same scope can never clobber this write.
  return mutateIndex<KvSetResult>(scope, (entries) => {
    const existing = entries.find(e => e.name === name);

    if (!existing && entries.length >= settings.maxKeysPerScope) {
      log.warn(`kv write skipped (keys ${entries.length} >= cap ${settings.maxKeysPerScope})`, { scope, name });
      return { next: entries, result: { skipped: 'keys-cap' } };
    }

    const usedBytes = entries.reduce((sum, e) => sum + (e === existing ? 0 : e.size), 0);
    if (usedBytes + size > settings.maxScopeBytes) {
      log.warn(`kv write skipped (scope budget ${usedBytes}+${size} > ${settings.maxScopeBytes})`, { scope, name });
      return { next: entries, result: { skipped: 'scope-cap' } };
    }

    const now = Date.now();
    const entry: KvEntry = {
      scope,
      name,
      value: str,
      size,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      expiresAt: options?.expiresAt,
    };

    const next = existing ? entries.map(e => (e === existing ? entry : e)) : [...entries, entry];
    log.debug(`Set kv ${scope}/${name}`, { size });
    return { next, result: entry };
  });
}

/** Read a key's value, or undefined when absent/expired. */
export async function kvGet(scope: KvScopeId, name: string): Promise<string | undefined> {
  assertSafeScope(scope);
  assertSafeName(name);
  const entries = await loadIndex(scope);
  const entry = entries.find(e => e.name === name);
  if (!entry) return undefined;
  // Lazy expiry-on-read (TTL is reserved for a later version, but honour it if
  // an entry somehow carries one).
  if (!isLive(entry, Date.now())) return undefined;
  return entry.value;
}

/** Delete a key. No-op when absent. */
export async function kvDelete(scope: KvScopeId, name: string): Promise<void> {
  assertSafeScope(scope);
  assertSafeName(name);
  await mutateIndex<void>(scope, (entries) => {
    // Same array reference on a no-op → mutateIndex writes nothing.
    if (!entries.some(e => e.name === name)) return { next: entries, result: undefined };
    return { next: entries.filter(e => e.name !== name), result: undefined };
  });
}

/** All live entries on a board. */
export async function listKv(scope: KvScopeId): Promise<KvEntry[]> {
  assertSafeScope(scope);
  const now = Date.now();
  return (await loadIndex(scope)).filter(e => isLive(e, now));
}

/**
 * A `{ name: value }` snapshot of a board for the pure resolver. Reads disk on
 * cold start (the global cache is empty after a fresh process).
 */
export async function loadKvSnapshot(scope: KvScopeId): Promise<Record<string, string>> {
  assertSafeScope(scope);
  const now = Date.now();
  const map: Record<string, string> = {};
  for (const e of await loadIndex(scope)) {
    if (isLive(e, now)) map[e.name] = e.value;
  }
  return map;
}

/** All board ids that exist on disk (for UI/inspection). */
export async function listKvScopes(): Promise<string[]> {
  try {
    const dirents = await fs.readdir(kvStoreDir, { withFileTypes: true });
    return dirents.filter(d => d.isDirectory() && SAFE_ID.test(d.name)).map(d => d.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Every live entry across every board (newest-updated first). For inspection. */
export async function listAllKv(): Promise<KvEntry[]> {
  const scopes = await listKvScopes();
  const now = Date.now();
  const all: KvEntry[] = [];
  for (const scope of scopes) {
    all.push(...(await loadIndex(scope)).filter(e => isLive(e, now)));
  }
  all.sort((a, b) => b.updatedAt - a.updatedAt);
  return all;
}

/** Test seam: point the store at a temp directory. Returns the previous dir. */
export function _setKvStoreDirForTests(dir: string): string {
  const previous = kvStoreDir;
  kvStoreDir = dir;
  indexCache.clear();
  return previous;
}
