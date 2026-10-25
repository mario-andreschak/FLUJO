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
import { types } from 'node:util';
import { FlowExecutor } from './FlowExecutor';
import { SharedState } from './types';
import { DEFAULT_WORKSPACE, getCurrentWorkspace, workspaceCacheKey } from '@/utils/workspace';

const log = createLogger('backend/execution/flow/conversationStateCache');

/** Terminal entries older than this are dropped by the next sweep. */
const DEFAULT_TTL_MS = 30 * 60_000;
/** Maximum number of cached conversations (live + terminal). */
const DEFAULT_MAX_ENTRIES = 200;
/** Approximate retained-payload budget (protected entries also count). */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
/** Bound estimator work without serializing or copying transcript/media data. */
const MAX_ESTIMATE_VALUES = 100_000;
const SATURATED_ESTIMATE = Number.MAX_SAFE_INTEGER;
const RUNTIME_STATE_FIELDS = new Set([
  'executionAuthority', 'abortSignal', 'executionExtensionContext', 'mcpContext',
]);
const arrayBufferSize = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const sharedBufferSize = typeof SharedArrayBuffer === 'undefined' ? undefined
  : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')!.get!;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'buffer')!.get!;
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer')!.get!;

function isIntrinsicConstructorPrototype(prototype: object, intrinsic: ObjectConstructor | ArrayConstructor): boolean {
  if (types.isProxy(prototype)) return false;
  const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
  if (!constructor || !('value' in constructor) || typeof constructor.value !== 'function' || types.isProxy(constructor.value)) return false;
  return Object.getOwnPropertyDescriptor(constructor.value, 'prototype')?.value === prototype
    && Function.prototype.toString.call(constructor.value) === Function.prototype.toString.call(intrinsic);
}

function isIntrinsicObjectPrototype(prototype: object | null): boolean {
  return prototype !== null && !types.isProxy(prototype) && Object.getPrototypeOf(prototype) === null
    && isIntrinsicConstructorPrototype(prototype, Object);
}

/** Native structuredClone/VM snapshots can carry another realm's Object/Array.
 * Recognize their intrinsic ownership without reading constructor hooks; custom
 * classes and proxy prototypes remain opaque runtime graphs.
 */
function hasDataPrototype(value: object, array: boolean): boolean {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) return true;
  if (types.isProxy(prototype)) return false;
  return array
    ? Array.isArray(prototype) && isIntrinsicConstructorPrototype(prototype, Array)
      && isIntrinsicObjectPrototype(Object.getPrototypeOf(prototype))
    : isIntrinsicObjectPrototype(prototype);
}

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
  /** Every registered write invalidates a previous persistence receipt. */
  revision: number;
  /** Weak identity fence: bookkeeping must not retain a replaced transcript. */
  persistedState?: WeakRef<SharedState>;
  persistedUpdatedAt?: number;
  persistedRunId?: string;
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
  const recovery = state.recovery as (NonNullable<SharedState['recovery']> & { owner?: unknown }) | undefined;
  // ownerId/heartbeat remain on persisted terminal records. Only an unresolved
  // recovery boundary protects them; historical process identity alone must not
  // prevent completed conversations from leaving the cache.
  if (recovery?.owner || recovery?.manualActionRequired || recovery?.classification === 'interrupted') return true;
  // Owner metadata is optional in older snapshots. An unfinished classification
  // still owns recovery even when its process identity was never recorded.
  if (recovery?.classification === 'running' || recovery?.classification === 'paused') return true;
  if (recovery?.currentCheckpoint?.effectStatus === 'pending' || recovery?.currentCheckpoint?.effectStatus === 'unknown') return true;
  if (state.pendingToolCalls?.length || state.debugPendingToolCalls?.length || state.debugPendingAction) return true;
  for (const invocationId in state.subflowInvocations) {
    const invocation = state.subflowInvocations[invocationId];
    if (invocation.status !== 'folded' || (invocation.foldReceipt && !invocation.foldReceipt.continuedAt)) return true;
  }
  return false;
}

/**
 * Conservative payload estimate, not a measurement of V8 heap/RSS. Includes
 * canonical messages, media, tool arguments, debug snapshots and subflow data.
 * Walk ordinary own data properties without invoking accessors or toJSON, and
 * count shared objects/backing stores once. Runtime capabilities/clients and
 * opaque class instances are excluded; closures/SDK allocations need separate
 * process measurements. Excessive graph cardinality saturates the estimate
 * instead of making the accounting itself an unbounded allocation.
 */
export function estimateStateBytes(state: SharedState | undefined): number {
  if (!state) return 0;
  let bytes = 1024;
  let inspected = 0;
  const seen = new WeakSet<object>();
  const pending: object[] = [];
  const add = (value: unknown): boolean => {
    if (++inspected > MAX_ESTIMATE_VALUES) return false;
    if (typeof value === 'string') bytes += 24 + value.length * 2;
    else if (typeof value === 'number' || typeof value === 'bigint') bytes += 8;
    else if (typeof value === 'boolean') bytes += 4;
    else if (value && typeof value === 'object' && !seen.has(value)) {
      seen.add(value);
      pending.push(value);
    }
    return true;
  };
  add(state);
  while (pending.length) {
    const value = pending.pop()!;
    bytes += 64;
    if (types.isProxy(value)) continue;
    if (ArrayBuffer.isView(value)) {
      const backing = (types.isDataView(value) ? dataViewBuffer : typedArrayBuffer).call(value) as ArrayBufferLike;
      if (!seen.has(backing)) {
        seen.add(backing);
        bytes += (types.isSharedArrayBuffer(backing) ? sharedBufferSize! : arrayBufferSize).call(backing);
      }
      continue;
    }
    if (types.isArrayBuffer(value) || types.isSharedArrayBuffer(value)) {
      bytes += (types.isSharedArrayBuffer(value) ? sharedBufferSize! : arrayBufferSize).call(value);
      continue;
    }
    const array = Array.isArray(value);
    if (!hasDataPrototype(value, array)) continue;
    if (array) {
      if (value.length > MAX_ESTIMATE_VALUES - inspected) return SATURATED_ESTIMATE;
      bytes += value.length * 8;
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (descriptor && 'value' in descriptor && !add(descriptor.value)) return SATURATED_ESTIMATE;
      }
      continue;
    }
    for (const key in value) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || (value === state && RUNTIME_STATE_FIELDS.has(key))) continue;
      bytes += 8 + key.length * 2;
      if (!add('value' in descriptor ? descriptor.value : undefined)) return SATURATED_ESTIMATE;
    }
  }
  return Math.min(bytes, SATURATED_ESTIMATE);
}

/** Register/refresh a write; only a later successful persistence permits eviction. */
export function noteWrite(conversationId: string, state: SharedState): void {
  const key = cacheKey(conversationId);
  const entry = meta().get(key);
  if (entry) {
    entry.lastAccessAt = Date.now();
    entry.bytes = estimateStateBytes(state);
    entry.revision = (entry.revision ?? 0) + 1;
    entry.evictable = false;
    entry.terminalAt = undefined;
    entry.persistedState = undefined;
    return;
  }
  meta().set(key, {
    evictable: false,
    lastAccessAt: Date.now(),
    bytes: estimateStateBytes(state),
    revision: 1,
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
  const map = FlowExecutor.conversationStates;
  if (map.get(conversationId) !== state) return;
  const key = cacheKey(conversationId);
  if (!meta().has(key)) noteWrite(conversationId, state);
  const entry = meta().get(key)!;
  const revision = entry.revision = (entry.revision ?? 0) + 1;
  const bytes = estimateStateBytes(state);
  const updatedAt = state.updatedAt;
  const logicalRunId = state.logicalRunId;
  // A failed retry cannot leave a previous persistence receipt eligible.
  entry.evictable = false;
  entry.persistedState = undefined;
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
  if (map.get(conversationId) !== state || meta().get(key) !== entry || entry.revision !== revision ||
      isLiveOwned(state) || state.updatedAt !== updatedAt || state.logicalRunId !== logicalRunId ||
      estimateStateBytes(state) !== bytes) return;
  Object.assign(entry, {
    evictable: true,
    lastAccessAt: Date.now(),
    terminalAt: Date.now(),
    bytes,
    persistedState: new WeakRef(state),
    persistedUpdatedAt: updatedAt,
    persistedRunId: logicalRunId,
  });
  enforceBounds();
}

/** Refresh in-place payload growth and revoke stale eligibility before accounting. */
function refreshEntries(): Array<[string, CacheEntry]> {
  const map = FlowExecutor.conversationStates;
  for (const [key, entry] of entriesForCurrentWorkspace()) {
    const state = map.get(conversationIdFromKey(key));
    if (!state) {
      meta().delete(key);
      continue;
    }
    const bytes = estimateStateBytes(state);
    if (entry.evictable && (isLiveOwned(state) || entry.persistedState?.deref() !== state ||
        bytes !== entry.bytes || state.updatedAt !== entry.persistedUpdatedAt || state.logicalRunId !== entry.persistedRunId)) {
      entry.evictable = false;
      entry.terminalAt = undefined;
      entry.persistedState = undefined;
    }
    entry.bytes = bytes;
  }
  return entriesForCurrentWorkspace();
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
  refreshEntries();

  const evict = (conversationId: string, reason: string): boolean => {
    const state = map.get(conversationId);
    const entry = meta().get(cacheKey(conversationId));
    if (!entry?.evictable) return false;
    if (isLiveOwned(state) || (state && entry.persistedState?.deref() !== state)) {
      entry.evictable = false;
      return false;
    }
    map.delete(conversationId);
    meta().delete(cacheKey(conversationId));
    counters().evictions += 1;
    evicted += 1;
    log.debug(`enforceBounds: evicted ${conversationId} (${reason})`);
    return true;
  };

  // 1) TTL — persisted terminal age; reads do not extend this cutoff.
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
      if (evict(conversationIdFromKey(key), 'max-bytes')) total -= entry.bytes;
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
  protectedEntries: number;
  protectedEstimatedBytes: number;
  evictableEstimatedBytes: number;
  overBudgetBytes: number;
  overEntryLimit: number;
  saturatedEstimateEntries: number;
  ttlMs: number;
  maxEntries: number;
  maxBytes: number;
  inFlightLoads: number;
}

/** Bounded snapshot for the diagnostics report — counters and sizes only. */
export function getConversationCacheDiagnostics(): ConversationCacheDiagnostics {
  let estimatedBytes = 0;
  let evictableEntries = 0;
  let evictableEstimatedBytes = 0;
  let saturatedEstimateEntries = 0;
  const entries = refreshEntries();
  for (const [, entry] of entries) {
    estimatedBytes += entry.bytes;
    if (entry.evictable) {
      evictableEntries += 1;
      evictableEstimatedBytes += entry.bytes;
    }
    if (entry.bytes === SATURATED_ESTIMATE) saturatedEstimateEntries += 1;
  }
  return {
    ...counters(),
    entries: entries.length,
    evictableEntries,
    estimatedBytes,
    protectedEntries: entries.length - evictableEntries,
    protectedEstimatedBytes: estimatedBytes - evictableEstimatedBytes,
    evictableEstimatedBytes,
    overBudgetBytes: Math.max(0, estimatedBytes - maxBytes()),
    overEntryLimit: Math.max(0, entries.length - maxEntries()),
    saturatedEstimateEntries,
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
