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
  if (!bucket || bucket.revision !== options.revision) {
    const currentRevision = bucket?.revision ?? -1;
    bucket = { revision: options.revision, records: new Map(), touchedAt: Date.now() };
    // An in-flight read of an older revision must not replace a newer cache or
    // fill its records after a mutation has committed.
    if (currentRevision <= options.revision) target.set(cacheKey, bucket);
  }

  const selected = options.entries.slice(0, PERSONA_RECORD_CACHE_MAX_RECORDS_PER_PERSONA);
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

/** Called under the index write chain after a single-record mutation commits. */
export function advancePersonaRecordCache(
  collection: string,
  personaId: string,
  changedId: string,
  previousRevision: number,
  revision: number,
): void {
  const target = cache();
  const cacheKey = key(collection, personaId);
  const bucket = target.get(cacheKey);
  if (!bucket) return;
  if (bucket.revision !== previousRevision) {
    // A revision gap may include external writes to any record, so no cached
    // record from that older generation is safe to carry forward.
    if (bucket.revision < revision) target.delete(cacheKey);
    return;
  }
  const records = new Map(bucket.records);
  // Compaction can change content without changing updatedAt.
  records.delete(changedId);
  target.set(cacheKey, { revision, records, touchedAt: Date.now() });
}

export function _clearPersonaRecordCache(): void {
  cache().clear();
}
