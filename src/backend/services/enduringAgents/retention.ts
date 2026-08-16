/**
 * Shared retention/compaction helper for Persona runtime records.
 * Implements the rank+age selection algorithm generalized from behaviorMaintenance.ts.
 * Each collection provides a policy to define its own compaction semantics while
 * sharing the core retention logic.
 */

export interface RetentionPolicy<T> {
  /** Human/log label, e.g. 'PersonaMailboxItem'. */
  recordKind: string;
  
  /** Only these records are ever candidates for compaction. */
  isEligible: (record: T) => boolean;
  
  /** Age/rank ordering key; mirrors timestamp used for sorting. */
  timestampOf: (record: T) => number;
  
  /** True once the record has already been compacted (idempotency of the sweep). */
  isCompacted: (record: T) => boolean;
  
  /** Max age (in milliseconds) before a record is compacted regardless of rank. */
  retentionMs: number;
  
  /** Newest-N detailed (uncompacted) records always kept in full. */
  detailedLimit: number;
  
  /** Produce the compacted form; MUST preserve id and audit identity. */
  compact: (record: T, compactedAt: number) => T;
  
  /** Persist one compacted record (schema-validating save); the return value is ignored. */
  save: (record: T) => Promise<unknown>;
  
  /** Optional cap on number of writes per sweep to avoid blocking locks. */
  maxWritesPerSweep?: number;
}

export interface RetentionResult {
  /** Number of records compacted in this sweep. */
  compacted: number;
  
  /** Number of eligible records remaining uncompacted. */
  remaining: number;
}

/**
 * Apply a retention policy to a list of records. This is the core algorithm,
 * called after the caller has already acquired the necessary lock and fetched\
 * the records to compact.\n\n * Selection logic (copied from behaviorMaintenance.ts for provable equivalence):
 * 1. Filter to eligible records (isEligible).
 * 2. Sort newest-first by timestampOf, tie-broken by descending id (stable, deterministic).
 * 3. Take those where !isCompacted (uncompacted records only).
 * 4. For each at 0-based rank: compact iff timestampOf(record) < now - retentionMs OR rank >= detailedLimit.
 * 5. compactedAt = Math.max(now, timestampOf(record)) (monotonic, never regresses).
 *
 * @param records The already-fetched records (should have been listed within an active lock).
 * @param policy The retention/compaction policy for this collection kind.
 * @param now Current time in milliseconds.
 * @returns {compacted: count, remaining: count}.
 */
export async function applyRetention<T extends { id: string }>(
  records: readonly T[],
  policy: RetentionPolicy<T>,
  now: number = Date.now(),
): Promise<RetentionResult> {
  const eligible = records.filter((r) => policy.isEligible(r));
  if (eligible.length === 0) {
    return { compacted: 0, remaining: 0 };
  }

  // Sort newest-first by timestamp, then by descending id for determinism.
  const sorted = eligible.sort((left, right) => {
    const tsDiff = policy.timestampOf(right) - policy.timestampOf(left);
    if (tsDiff !== 0) return tsDiff;
    return right.id.localeCompare(left.id);
  });

  // Filter to uncompacted records only.
  const uncompacted = sorted.filter((r) => !policy.isCompacted(r));

  const cutoff = now - policy.retentionMs;
  const maxWrites = policy.maxWritesPerSweep ?? Infinity;
  let compacted = 0;

  for (const [rank, record] of uncompacted.entries()) {
    if (compacted >= maxWrites) break;

    const expired = policy.timestampOf(record) < cutoff;
    const tooOldRank = rank >= policy.detailedLimit;

    if (!expired && !tooOldRank) {
      continue;
    }

    const compactedAt = Math.max(now, policy.timestampOf(record));
    const compactedRecord = policy.compact(record, compactedAt);
    await policy.save(compactedRecord);
    compacted += 1;
  }

  return {
    compacted,
    remaining: uncompacted.length - compacted,
  };
}
