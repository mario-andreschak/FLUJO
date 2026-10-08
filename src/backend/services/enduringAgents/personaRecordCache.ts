import { workspaceCacheKey } from '@/utils/workspace';

export const PERSONA_RECORD_CACHE_MAX_PERSONAS = 100;
// Keep a complete 50k recall working set warm, while bounding the whole process
// to fewer records than the former 100 buckets × 10k independent allowance.
export const PERSONA_RECORD_CACHE_MAX_RECORDS_PER_PERSONA = 50_000;
export const PERSONA_RECORD_CACHE_MAX_RECORDS = 100_000;
export const PERSONA_RECORD_READ_CONCURRENCY = 32;

export interface CachedIndexEntry {
  id: string;
  updatedAt: number;
}

type CachedRecord<T> = { updatedAt: number; record: T | null };
type CacheBucket = {
  revision: number;
  records: Map<string, CachedRecord<unknown>>;
  touchedAt: number;
  pendingReads: number;
};

declare global {
  var __flujo_persona_record_cache_v2: Map<string, CacheBucket> | undefined;
}

function cache(): Map<string, CacheBucket> {
  global.__flujo_persona_record_cache_v2 ??= new Map();
  return global.__flujo_persona_record_cache_v2;
}

function key(collection: string, personaId: string): string {
  return workspaceCacheKey('persona-record-cache', collection, personaId);
}

function enforceBounds(target: Map<string, CacheBucket>): void {
  let retainedRecords = [...target.values()].reduce((count, bucket) => count + bucket.records.size, 0);
  while (target.size > PERSONA_RECORD_CACHE_MAX_PERSONAS
    || retainedRecords > PERSONA_RECORD_CACHE_MAX_RECORDS) {
    let oldestKey: string | undefined;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [candidateKey, bucket] of target) {
      if (bucket.touchedAt < oldest) {
        oldest = bucket.touchedAt;
        oldestKey = candidateKey;
      }
    }
    if (!oldestKey) break;
    retainedRecords -= target.get(oldestKey)!.records.size;
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
    bucket = { revision: options.revision, records: new Map(), touchedAt: Date.now(), pendingReads: 0 };
    // An in-flight read of an older revision must not replace a newer cache or
    // fill its records after a mutation has committed.
    if (currentRevision <= options.revision) target.set(cacheKey, bucket);
  }

  const records: Array<T | null> = new Array(options.entries.length);
  const missing: number[] = [];
  for (const [index, entry] of options.entries.entries()) {
    const cached = bucket.records.get(entry.id);
    if (cached && cached.updatedAt === entry.updatedAt) {
      records[index] = cached.record as T | null;
      continue;
    }
    missing.push(index);
  }
  // Cold recall must not open tens of thousands of files/Promises at once.
  // Hits stay synchronous; workers retain the old generation until every
  // in-flight read settles, including after another worker has failed.
  let next = 0;
  let failed = false;
  const worker = async () => {
    bucket.pendingReads += 1;
    try {
      while (!failed && next < missing.length) {
        const index = missing[next++];
        const entry = options.entries[index];
        const record = await options.load(entry.id);
        records[index] = record;
        bucket.records.set(entry.id, { updatedAt: entry.updatedAt, record });
        while (bucket.records.size > PERSONA_RECORD_CACHE_MAX_RECORDS_PER_PERSONA) {
          bucket.records.delete(bucket.records.keys().next().value!);
        }
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      bucket.pendingReads -= 1;
      if (bucket.pendingReads === 0) {
        bucket.touchedAt = Date.now();
        enforceBounds(target);
      }
    }
  };
  if (missing.length > 0) {
    await Promise.all(Array.from({ length: Math.min(missing.length, PERSONA_RECORD_READ_CONCURRENCY) }, worker));
  }
  bucket.touchedAt = Date.now();
  enforceBounds(target);
  // The cache bound limits retained records, never the caller's result set.
  return records;
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
  // A pending read owns its generation until it finishes. Otherwise the map
  // can move to the new generation without copying the entire history for
  // every single-record update.
  const records = bucket.pendingReads > 0 ? new Map(bucket.records) : bucket.records;
  // Compaction can change content without changing updatedAt.
  records.delete(changedId);
  target.set(cacheKey, { revision, records, touchedAt: Date.now(), pendingReads: 0 });
}

export function _clearPersonaRecordCache(): void {
  cache().clear();
}
