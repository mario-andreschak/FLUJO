/**
 * Bounded cache for completed conversation state (issue #413).
 *
 * `FlowExecutor.conversationStates` is a process-global `Map` that only ever
 * grew: every conversation a FLUJO process ever touched stayed resident, with its
 * full message history, until restart. A long-lived instance that answers
 * thousands of chats therefore leaks the entire transcript corpus into the heap.
 *
 * This module keeps that map as the single live registry (dozens of call sites
 * read it directly, and rewriting all of them at once would be a far riskier
 * change) and adds the bookkeeping around it:
 *
 *  - A conversation is EVICTABLE only once it is terminal AND its durable
 *    snapshot has been persisted (`markTerminal`). Running, awaiting-approval,
 *    paused-debug and recovery-owned states are never candidates, so eviction can
 *    never discard live ownership or interrupt a resumable run.
 *  - Bounds are TTL, entry count and an approximate byte budget. Eviction is LRU
 *    among terminal entries only.
 *  - Eviction drops the in-memory copy ONLY. A later resume/inspect reloads from
 *    durable storage through `loadConversationState`, so eviction is invisible to
 *    callers — that is precisely why persistence must happen first.
 *  - Concurrent loads of the same conversation are coalesced, so N parallel
 *    control-route hits after an eviction perform ONE storage read + log replay
 *    instead of N racing replays that could each repair the same dangling tool
 *    call.
 */
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from './FlowExecutor';
import { SharedState } from './types';
import { DEFAULT_WORKSPACE, getCurrentWorkspace, workspaceCacheKey } from '@/utils/workspace';

const log = createLogger('backend/execution/flow/conversationStateCache');

/** Terminal entries older than this are dropped by the next sweep. */
const DEFAULT_TTL_MS = 30 * 60_000;
/** Maximum number of cached conversations (live + terminal). */
const DEFAULT_MAX_ENTRIES = 200;
/** Approximate heap budget for cached terminal transcripts. */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

function numberFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function ttlMs(): number {
  return numberFromEnv('FLUJO_CONVERSATION_CACHE_TTL_MS', DEFAULT_TTL_MS);
}

function maxEntries(): number {
  return Math.floor(numberFromEnv('FLUJO_CONVERSATION_CACHE_MAX_ENTRIES', DEFAULT_MAX_ENTRIES));
}

function maxBytes(): number {
  return numberFromEnv('FLUJO_CONVERSATION_CACHE_MAX_BYTES', DEFAULT_MAX_BYTES);
}

interface CacheEntry {
  /** Terminal + persisted: the only state in which eviction is allowed. */
  evictable: boolean;
  /** Last read/write through the cache API (LRU key). */
  lastAccessAt: number;
  /** When the entry became terminal. */
  terminalAt?: number;
  /** Approximate retained size, bytes. */
  bytes: number;
}

interface CacheCounters {
  hits: number;
  misses: number;
  evictions: number;
  reloads: number;
  coalescedLoads: number;
  persistFailures: number;
}

declare global {
  var __flujo_conversation_cache_meta: Map<string, CacheEntry> | undefined;
  var __flujo_conversation_cache_counters: CacheCounters | undefined;
  var __flujo_conversation_cache_counters_by_workspace: Map<string, CacheCounters> | undefined;
  var __flujo_conversation_cache_loads: Map<string, Promise<SharedState | undefined>> | undefined;
}

function meta(): Map<string, CacheEntry> {
  if (!global.__flujo_conversation_cache_meta) {
    global.__flujo_conversation_cache_meta = new Map<string, CacheEntry>();
  }
  return global.__flujo_conversation_cache_meta;
}

function counters(): CacheCounters {
  const create = (): CacheCounters => ({
      hits: 0,
      misses: 0,
      evictions: 0,
      reloads: 0,
      coalescedLoads: 0,
      persistFailures: 0,
    });
  const workspace = getCurrentWorkspace();
  if (workspace === DEFAULT_WORKSPACE) {
    if (!global.__flujo_conversation_cache_counters) {
      global.__flujo_conversation_cache_counters = create();
    }
    return global.__flujo_conversation_cache_counters;
  }
  const byWorkspace = global.__flujo_conversation_cache_counters_by_workspace ??
    (global.__flujo_conversation_cache_counters_by_workspace = new Map());
  let value = byWorkspace.get(workspace);
  if (!value) {
    value = create();
    byWorkspace.set(workspace, value);
  }
  return value;
}

function inFlightLoads(): Map<string, Promise<SharedState | undefined>> {
  if (!global.__flujo_conversation_cache_loads) {
    global.__flujo_conversation_cache_loads = new Map<string, Promise<SharedState | undefined>>();
  }
  return global.__flujo_conversation_cache_loads;
}

const TERMINAL_STATUSES = new Set(['completed', 'error', 'capped']);

// Keep legacy raw keys for the default workspace so HMR/test reset hooks that
// inspect these global maps continue to work. Every non-default workspace is
// namespaced with the canonical helper.
function cacheKey(conversationId: string): string {
  return getCurrentWorkspace() === DEFAULT_WORKSPACE
    ? conversationId
    : workspaceCacheKey(conversationId);
}

function entriesForCurrentWorkspace(): Array<[string, CacheEntry]> {
  const workspace = getCurrentWorkspace();
  if (workspace === DEFAULT_WORKSPACE) {
    return Array.from(meta()).filter(([key]) => !key.includes('\0'));
  }
  const prefix = `${workspace}\0`;
  return Array.from(meta()).filter(([key]) => key.startsWith(prefix));
}

function conversationIdFromKey(key: string): string {
  const separator = key.indexOf('\0');
  return separator < 0 ? key : key.slice(separator + 1);
}

/**
 * Live ownership check. A state is non-evictable while it is running/paused, or
 * while a recovery record still owns unresolved work — dropping either would lose
 * the only in-memory reference a resume path can reconcile against.
 */
function isLiveOwned(state: SharedState | undefined): boolean {
  if (!state) return false;
  if (state.status && !TERMINAL_STATUSES.has(state.status)) return true;
  if (!state.status) return true; // unknown status: treat as live, never evict
  const recovery = state.recovery as { currentCheckpoint?: unknown; owner?: unknown } | undefined;
  if (recovery && recovery.owner) return true;
  return false;
}

/**
 * Approximate retained bytes. Deliberately cheap and message-dominated: the
 * transcript is what actually grows, and an exact `JSON.stringify` of every
 * cached state on every sweep would cost more than the memory it saves.
 */
export function estimateStateBytes(state: SharedState | undefined): number {
  if (!state) return 0;
  let bytes = 1024; // fixed overhead for metadata/tracking fields
  for (const message of state.messages ?? []) {
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') bytes += content.length * 2;
    else if (content != null) bytes += 512;
    else bytes += 128;
  }
  bytes += (state.executionTrace?.length ?? 0) * 2048;
  return bytes;
}

/** Register/refresh a state in the cache without changing its evictability. */
export function noteWrite(conversationId: string, state: SharedState): void {
  const key = cacheKey(conversationId);
  const entry = meta().get(key);
  if (entry) {
    entry.lastAccessAt = Date.now();
    if (isLiveOwned(state)) {
      // A resumed conversation is live again: revoke evictability so a sweep in
      // the middle of the new run cannot drop it.
      entry.evictable = false;
      entry.terminalAt = undefined;
    }
    return;
  }
  meta().set(key, {
    evictable: false,
    lastAccessAt: Date.now(),
    bytes: estimateStateBytes(state),
  });
}

/** Record a cache read (LRU touch + hit/miss accounting). */
export function noteRead(conversationId: string, hit: boolean): void {
  if (hit) counters().hits += 1;
  else counters().misses += 1;
  const entry = meta().get(cacheKey(conversationId));
  if (entry) entry.lastAccessAt = Date.now();
}

/** Forget bookkeeping for a conversation that was removed from the live map. */
export function forget(conversationId: string): void {
  meta().delete(cacheKey(conversationId));
}

/**
 * Mark a conversation terminal: persist the durable snapshot FIRST, then allow
 * eviction and enforce the bounds.
 *
 * Persist-before-evict is the whole safety property. If persistence fails the
 * entry stays non-evictable, so a transient storage fault can never trade a
 * bounded cache for a lost transcript.
 */
export async function markTerminal(
  conversationId: string,
  state: SharedState,
  persist: () => Promise<void>,
): Promise<void> {
  if (isLiveOwned(state)) return;
  try {
    await persist();
  } catch (error) {
    counters().persistFailures += 1;
    log.warn('markTerminal: persist failed; keeping conversation non-evictable', {
      conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  meta().set(cacheKey(conversationId), {
    evictable: true,
    lastAccessAt: Date.now(),
    terminalAt: Date.now(),
    bytes: estimateStateBytes(state),
  });
  enforceBounds();
}

/**
 * Drop terminal entries that exceed the TTL, entry count or byte budget.
 *
 * Only entries explicitly marked evictable are candidates, and each is
 * re-validated against the live state before removal, so a conversation that
 * became live again between marking and sweeping is left alone.
 */
export function enforceBounds(): number {
  const map = FlowExecutor.conversationStates;
  const now = Date.now();
  const ttl = ttlMs();
  let evicted = 0;

  const evict = (conversationId: string, reason: string): void => {
    const state = map.get(conversationId);
    if (isLiveOwned(state)) {
      const entry = meta().get(cacheKey(conversationId));
      if (entry) entry.evictable = false;
      return;
    }
    map.delete(conversationId);
    meta().delete(cacheKey(conversationId));
    counters().evictions += 1;
    evicted += 1;
    log.debug(`enforceBounds: evicted ${conversationId} (${reason})`);
  };

  // 1) TTL — an entry nobody touched for the whole window is dead weight.
  for (const [key, entry] of entriesForCurrentWorkspace()) {
    if (!entry.evictable) continue;
    const since = entry.terminalAt ?? entry.lastAccessAt;
    if (now - since >= ttl) evict(conversationIdFromKey(key), 'ttl');
  }

  // Candidates for the count/byte passes, least-recently-used first.
  const candidates = (): Array<[string, CacheEntry]> =>
    entriesForCurrentWorkspace()
      .filter(([, entry]) => entry.evictable)
      .sort((a, b) => a[1].lastAccessAt - b[1].lastAccessAt);

  // 2) Entry count.
  const limit = maxEntries();
  let list = candidates();
  let index = 0;
  while (entriesForCurrentWorkspace().length > limit && index < list.length) {
    evict(conversationIdFromKey(list[index][0]), 'max-entries');
    index += 1;
  }

  // 3) Approximate byte budget.
  const budget = maxBytes();
  let total = 0;
  for (const [, entry] of entriesForCurrentWorkspace()) total += entry.bytes;
  if (total > budget) {
    list = candidates();
    for (const [key, entry] of list) {
      if (total <= budget) break;
      total -= entry.bytes;
      evict(conversationIdFromKey(key), 'max-bytes');
    }
  }

  return evicted;
}

/**
 * Coalesce concurrent durable loads for one conversation id.
 *
 * The loader performs a storage read, conversation-log replay, recovery
 * reconciliation and dangling-tool repair; running it N times in parallel would
 * duplicate every one of those writes.
 */
export function coalesceLoad(
  conversationId: string,
  loader: () => Promise<SharedState | undefined>,
): Promise<SharedState | undefined> {
  const key = cacheKey(conversationId);
  const pending = inFlightLoads().get(key);
  if (pending) {
    counters().coalescedLoads += 1;
    return pending;
  }
  counters().reloads += 1;
  const promise = loader().finally(() => {
    inFlightLoads().delete(key);
  });
  inFlightLoads().set(key, promise);
  return promise;
}

export interface ConversationCacheDiagnostics extends CacheCounters {
  entries: number;
  evictableEntries: number;
  estimatedBytes: number;
  ttlMs: number;
  maxEntries: number;
  maxBytes: number;
  inFlightLoads: number;
}

/** Bounded snapshot for the diagnostics report — counters and sizes only. */
export function getConversationCacheDiagnostics(): ConversationCacheDiagnostics {
  let estimatedBytes = 0;
  let evictableEntries = 0;
  const entries = entriesForCurrentWorkspace();
  for (const [, entry] of entries) {
    estimatedBytes += entry.bytes;
    if (entry.evictable) evictableEntries += 1;
  }
  return {
    ...counters(),
    entries: entries.length,
    evictableEntries,
    estimatedBytes,
    ttlMs: ttlMs(),
    maxEntries: maxEntries(),
    maxBytes: maxBytes(),
    inFlightLoads: Array.from(inFlightLoads().keys()).filter((key) => {
      const workspace = getCurrentWorkspace();
      return workspace === DEFAULT_WORKSPACE ? !key.includes('\0') : key.startsWith(`${workspace}\0`);
    }).length,
  };
}

/** Test-only: drop all cache bookkeeping (the live map is reset separately). */
export function _resetConversationCacheForTests(): void {
  global.__flujo_conversation_cache_meta = undefined;
  global.__flujo_conversation_cache_counters = undefined;
  global.__flujo_conversation_cache_counters_by_workspace = undefined;
  global.__flujo_conversation_cache_loads = undefined;
}
