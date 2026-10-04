import type { RunResourceEntry } from '@/shared/types/runResources';

const MAX_CACHED = 200;
const MAX_SERIALIZED_BYTES = 8 * 1024 * 1024;
const IDLE_MS = 30 * 60 * 1000;
const MAX_READS = 4;
const MAX_PENDING = 64;
interface CachedIndex { entries: RunResourceEntry[]; serializedBytes: number; touched: number }
interface PendingIndex { promise: Promise<RunResourceEntry[]>; invalidated: boolean }
interface IndexCacheState {
  cached: Map<string, CachedIndex>;
  pending: Map<string, PendingIndex>;
  serializedBytes: number;
  active: number;
  queued: Array<() => void>;
  rejected: number;
  evicted: number;
  bypassed: number;
}
declare global {
  var __flujo_run_resource_indexes: IndexCacheState | undefined;
  var __flujo_run_resources: Map<string, RunResourceEntry[]> | undefined;
}
const state: IndexCacheState = global.__flujo_run_resource_indexes ?? (() => {
  // Release the former unbounded cache on a development reload. Mixed old/new
  // route bundles require a process restart to share this version's policy.
  global.__flujo_run_resources?.clear();
  global.__flujo_run_resources = undefined;
  return global.__flujo_run_resource_indexes = {
    cached: new Map(), pending: new Map(), serializedBytes: 0, active: 0,
    queued: [], rejected: 0, evicted: 0, bypassed: 0,
  };
})();

export class RunResourceIndexPressureError extends Error {
  readonly code = 'RUN_RESOURCE_INDEX_PRESSURE';
  readonly retryable = true;
  constructor() { super('Resource index reads are busy. Retry after current reads finish.'); }
}
export function isRunResourceIndexPressureError(error: unknown): error is RunResourceIndexPressureError {
  // The same request can cross independently instantiated Next route bundles.
  return error instanceof Error && 'code' in error && error.code === 'RUN_RESOURCE_INDEX_PRESSURE';
}

function remove(key: string) {
  const entry = state.cached.get(key);
  if (entry) state.serializedBytes -= entry.serializedBytes;
  state.cached.delete(key);
}
function prune() {
  const now = Date.now();
  for (const [key, entry] of state.cached) {
    if (now - entry.touched >= IDLE_MS) { remove(key); state.evicted++; }
  }
}
function cached(key: string): RunResourceEntry[] | undefined {
  prune();
  const entry = state.cached.get(key);
  if (!entry) return;
  entry.touched = Date.now();
  state.cached.delete(key); state.cached.set(key, entry);
  return entry.entries;
}
function parseEntries(serialized: string): RunResourceEntry[] {
  const entries: unknown = serialized.trim().length ? JSON.parse(serialized) : [];
  if (!Array.isArray(entries)) throw new Error('Invalid run-resource index.');
  return entries as RunResourceEntry[];
}

function freezeEntries(entries: RunResourceEntry[]) {
  // Parsed JSON has no cycles. Iteration avoids recursion on deeply nested
  // metadata. Public store APIs copy returned metadata, so this owned snapshot
  // cannot grow through a caller reference after its byte weight was measured.
  const pending: object[] = [entries];
  while (pending.length) {
    const value = pending.pop()!;
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') pending.push(child);
    }
    Object.freeze(value);
  }
  return entries;
}

function retain(key: string, serialized: string): RunResourceEntry[] {
  const entries = parseEntries(serialized);
  const serializedBytes = Buffer.byteLength(serialized, 'utf8');
  remove(key); prune();
  // An oversized index remains fully readable/persisted, but is not retained.
  // This byte measure covers encoded metadata, not V8 object or parse overhead.
  if (serializedBytes > MAX_SERIALIZED_BYTES) { state.bypassed++; return entries; }
  while (state.cached.size >= MAX_CACHED || state.serializedBytes + serializedBytes > MAX_SERIALIZED_BYTES) {
    const oldest = state.cached.keys().next().value;
    if (oldest === undefined) break;
    remove(oldest); state.evicted++;
  }
  const snapshot = freezeEntries(entries);
  state.cached.set(key, { entries: snapshot, serializedBytes, touched: Date.now() });
  state.serializedBytes += serializedBytes;
  return snapshot;
}

/** Publish only an index whose atomic disk write has already succeeded. */
export function publishRunResourceIndex(key: string, serialized: string) {
  const pending = state.pending.get(key);
  if (pending) pending.invalidated = true;
  // Parse the exact committed bytes, not a caller-owned object that could have
  // changed while the atomic write was pending. Never retain the encoded string.
  retain(key, serialized);
}
export function invalidateRunResourceIndex(key: string) {
  remove(key);
  const pending = state.pending.get(key);
  if (pending) pending.invalidated = true;
}
export function clearRunResourceIndexCache() {
  state.cached.clear(); state.serializedBytes = 0;
  // Existing callers can finish, but detached reads cannot repopulate the cache.
  // This seam is used when tests change the store directory, not for admission.
  state.pending.clear();
}

/** Coalesce before admission; queued loaders have not opened/read their index. */
export async function loadRunResourceIndex(key: string, load: () => Promise<string>): Promise<RunResourceEntry[]> {
  const current = cached(key);
  if (current) return current;
  const existing = state.pending.get(key);
  if (existing) return existing.promise;
  if (state.active + state.queued.length >= MAX_PENDING) {
    state.rejected = Math.min(Number.MAX_SAFE_INTEGER, state.rejected + 1);
    throw new RunResourceIndexPressureError();
  }
  const pending: PendingIndex = { invalidated: false, promise: Promise.resolve([]) };
  const admitted = state.active < MAX_READS
    ? (state.active++, Promise.resolve())
    : new Promise<void>(resolve => state.queued.push(resolve));
  pending.promise = admitted.then(async () => {
    // Repeated same-index publications can invalidate a cold disk snapshot.
    // Use the committed cache when available, otherwise retry a fresh read
    // at most twice. Never feed the obsolete snapshot to a later mutator.
    for (let attempt = 0; attempt < 3; attempt++) {
      pending.invalidated = false;
      const loaded = await load();
      if (state.pending.get(key) !== pending) return parseEntries(loaded);
      if (!pending.invalidated) return retain(key, loaded);
      const committed = cached(key);
      if (committed) return committed;
    }
    state.rejected = Math.min(Number.MAX_SAFE_INTEGER, state.rejected + 1);
    throw new RunResourceIndexPressureError();
  }).finally(() => {
    if (state.pending.get(key) === pending) state.pending.delete(key);
    const next = state.queued.shift();
    if (next) next(); else state.active--;
  });
  state.pending.set(key, pending);
  return pending.promise;
}

export function getRunResourceIndexPressure() {
  prune();
  return { cached: state.cached.size, serializedBytes: state.serializedBytes, activeReads: state.active,
    queuedReads: state.queued.length, rejected: state.rejected, evicted: state.evicted, bypassed: state.bypassed,
    maxCached: MAX_CACHED, maxSerializedBytes: MAX_SERIALIZED_BYTES, idleMs: IDLE_MS,
    maxActiveReads: MAX_READS, maxQueuedReads: MAX_PENDING - MAX_READS };
}
