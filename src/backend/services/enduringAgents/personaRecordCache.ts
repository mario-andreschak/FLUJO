import { workspaceCacheKey } from '@/utils/workspace';

export const PERSONA_RECORD_CACHE_MAX_PERSONAS = 100;
export const PERSONA_RECORD_CACHE_MAX_RECORDS_PER_PERSONA = 10_000;

export interface CachedIndexEntry {
  id: string;
  updatedAt: number;
}

type CachedRecord<T> = { updatedAt: number; record: T | null };
type CacheBucket = {
  revision: number;
  records: Map<string, CachedRecord<unknown>>;
  touchedAt: number;
};

declare global {
  var __flujo_persona_record_cache: Map<string, CacheBucket> | undefined;
}

function cache(): Map<string, CacheBucket> {
  global.__flujo_persona_record_cache ??= new Map();
  return global.__flujo_persona_record_cache;
}

function key(collection: string, personaId: string): string {
  return workspaceCacheKey('persona-record-cache', collection, personaId);
}

function enforceBounds(target: Map<string, CacheBucket>): void {
  while (target.size > PERSONA_RECORD_CACHE_MAX_PERSONAS) {
    let oldestKey: string | undefined;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [candidateKey, bucket] of target) {
      if (bucket.touchedAt < oldest) {
        oldest = bucket.touchedAt;
        oldestKey = candidateKey;
      }
    }
    if (!oldestKey) break;
    target.delete(oldestKey);
  }
}

/**
 * Revision-fenced parse cache. The caller must read the sidecar on every call
 * and pass its current revision; this cache is never the storage authority.
 */
export async function loadPersonaRecords<T>(options: {
  collection: string;
  personaId: string;
  revision: number;
  entries: CachedIndexEntry[];
  load: (id: string) => Promise<T | null>;
}): Promise<Array<T | null>> {
  const target = cache();
  const cacheKey = key(options.collection, options.personaId);
  let bucket = target.get(cacheKey);
  if (!bucket) {
    bucket = { revision: -1, records: new Map(), touchedAt: Date.now() };
    target.set(cacheKey, bucket);
  }

  const selected = options.entries.slice(0, PERSONA_RECORD_CACHE_MAX_RECORDS_PER_PERSONA);
  if (bucket.revision !== options.revision) {
    // Entries outside the current page may also have changed. Clearing avoids
    // serving one of those stale records when a later call selects that page.
    bucket.records.clear();
    bucket.revision = options.revision;
  }
  await Promise.all(selected.map(async (entry) => {
    const cached = bucket!.records.get(entry.id);
    if (!cached || cached.updatedAt !== entry.updatedAt) {
      bucket!.records.set(entry.id, {
        updatedAt: entry.updatedAt,
        record: await options.load(entry.id),
      });
    }
  }));
  bucket.touchedAt = Date.now();
  enforceBounds(target);
  return selected.map((entry) => (bucket!.records.get(entry.id)?.record ?? null) as T | null);
}

export function invalidatePersonaRecordCache(collection: string, personaId: string): void {
  cache().delete(key(collection, personaId));
}

export function _clearPersonaRecordCache(): void {
  cache().clear();
}
