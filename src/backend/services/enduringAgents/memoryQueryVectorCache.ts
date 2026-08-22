/**
 * Bounded process-local cache for semantic-recall query vectors.
 *
 * Keys contain only non-secret identities and normalized query text. Callers
 * must supply a workspace-scoped identity so equal Persona IDs in separate
 * workspaces cannot share vectors.
 */

export interface MemoryQueryVectorCacheKey {
  readonly workspaceId: string;
  readonly provider: string;
  readonly modelId: string;
  readonly dimensions?: number;
  readonly query: string;
}

export interface MemoryQueryVectorCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly coalesced: number;
  readonly evictions: number;
  readonly size: number;
  readonly inFlight: number;
}

export interface MemoryQueryVectorCacheOptions {
  readonly maxEntries?: number;
  readonly ttlMilliseconds?: number;
  readonly now?: () => number;
}

interface CacheEntry {
  readonly vector: readonly number[];
  readonly expiresAt: number;
}

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_TTL_MILLISECONDS = 5 * 60 * 1_000;

export function normalizeMemoryQueryForCache(query: string): string {
  return query.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

export class MemoryQueryVectorCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<readonly number[]>>();
  private readonly maxEntries: number;
  private readonly ttlMilliseconds: number;
  private readonly now: () => number;
  private generation = 0;
  private hits = 0;
  private misses = 0;
  private coalesced = 0;
  private evictions = 0;

  constructor(options: MemoryQueryVectorCacheOptions = {}) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
    this.ttlMilliseconds = Math.max(1, Math.floor(
      options.ttlMilliseconds ?? DEFAULT_TTL_MILLISECONDS,
    ));
    this.now = options.now ?? Date.now;
  }

  private cacheKey(key: MemoryQueryVectorCacheKey): string {
    return JSON.stringify([
      key.workspaceId,
      key.provider,
      key.modelId,
      key.dimensions ?? null,
      normalizeMemoryQueryForCache(key.query),
    ]);
  }

  get(key: MemoryQueryVectorCacheKey): readonly number[] | undefined {
    const cacheKey = this.cacheKey(key);
    const entry = this.entries.get(cacheKey);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(cacheKey);
      return undefined;
    }

    // Map insertion order is the LRU order.
    this.entries.delete(cacheKey);
    this.entries.set(cacheKey, entry);
    return entry.vector;
  }

  set(key: MemoryQueryVectorCacheKey, vector: readonly number[]): void {
    const cacheKey = this.cacheKey(key);
    this.entries.delete(cacheKey);
    this.entries.set(cacheKey, {
      vector: [...vector],
      expiresAt: this.now() + this.ttlMilliseconds,
    });

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
      this.evictions += 1;
    }
  }

  async getOrCreate(
    key: MemoryQueryVectorCacheKey,
    create: () => Promise<readonly number[]>,
  ): Promise<readonly number[]> {
    const cached = this.get(key);
    if (cached) {
      this.hits += 1;
      return cached;
    }

    const cacheKey = this.cacheKey(key);
    const pending = this.inFlight.get(cacheKey);
    if (pending) {
      this.coalesced += 1;
      return pending;
    }

    this.misses += 1;
    const generation = this.generation;
    let created: Promise<readonly number[]>;
    created = create()
      .then((vector) => {
        if (generation === this.generation) this.set(key, vector);
        return vector;
      })
      .finally(() => {
        if (this.inFlight.get(cacheKey) === created) {
          this.inFlight.delete(cacheKey);
        }
      });
    this.inFlight.set(cacheKey, created);
    return created;
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
    this.generation += 1;
    this.resetStats();
  }

  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.coalesced = 0;
    this.evictions = 0;
  }

  stats(): MemoryQueryVectorCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      coalesced: this.coalesced,
      evictions: this.evictions,
      size: this.entries.size,
      inFlight: this.inFlight.size,
    };
  }
}

const memoryQueryVectorCache = new MemoryQueryVectorCache();

export function getMemoryQueryVectorCache(): MemoryQueryVectorCache {
  return memoryQueryVectorCache;
}

export function resetMemoryQueryVectorCache(): void {
  memoryQueryVectorCache.clear();
}
