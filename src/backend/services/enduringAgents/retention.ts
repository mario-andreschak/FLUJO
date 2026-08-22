/**
 * Shared planning and execution primitives for Persona runtime retention.
 *
 * Planning is pure so shadow and active rollout modes observe the exact same
 * deterministic candidate set. Persistence is a separate, re-authorized step.
 */

export interface RetentionPolicy<T> {
  /** Human/log label, e.g. 'PersonaMailboxItem'. */
  recordKind: string;
  /** Only these records are ever candidates for compaction. */
  isEligible: (record: T) => boolean;
  /** Age/rank ordering key. */
  timestampOf: (record: T) => number;
  /** True once the record has already been compacted. */
  isCompacted: (record: T) => boolean;
  /** Max age before a record is compacted regardless of rank. */
  retentionMs: number;
  /** Newest-N detailed records always kept in full. */
  detailedLimit: number;
  /** Produce the compacted form; MUST preserve id and audit identity. */
  compact: (record: T, compactedAt: number) => T;
  /** Persist one schema-valid compacted record. */
  save: (record: T) => Promise<unknown>;
  /** Cap writes per collection and Persona sweep. */
  maxWritesPerSweep?: number;
}

export type RetentionReason = 'age' | 'rank' | 'age-and-rank';

export interface RetentionCandidate<T> {
  record: T;
  projected: T;
  rank: number;
  reason: RetentionReason;
  bytesBefore: number;
  bytesAfter: number;
}

export interface RetentionPlan<T> {
  recordKind: string;
  scanned: number;
  eligible: number;
  candidateCount: number;
  candidates: RetentionCandidate<T>[];
  alreadyCompacted: number;
  skipped: number;
  remaining: number;
  bytesBefore: number;
  projectedBytesAfter: number;
}

export interface RetentionExecutionResult {
  selected: number;
  compacted: number;
  alreadyCompacted: number;
  skipped: number;
  failed: number;
  unauthorized: number;
  remaining: number;
  bytesBefore: number;
  projectedBytesAfter: number;
}

export interface RetentionExecutionOptions<T> {
  shadow?: boolean;
  /**
   * Called immediately before every save. Returning false stops all remaining
   * writes, which makes an in-flight rollout disable deterministic.
   */
  authorizeWrite?: (
    record: T,
    candidate: RetentionCandidate<T>,
  ) => boolean | Promise<boolean>;
  onWriteFailure?: (record: T, error: unknown) => void;
  continueOnFailure?: boolean;
}

export interface RetentionResult {
  compacted: number;
  remaining: number;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * Build the deterministic age/rank plan without performing persistence.
 */
export function planRetention<T extends { id: string }>(
  records: readonly T[],
  policy: RetentionPolicy<T>,
  now: number = Date.now(),
): RetentionPlan<T> {
  const alreadyCompacted = records.filter((record) => policy.isCompacted(record)).length;
  const eligible = records.filter((record) => policy.isEligible(record));
  const sorted = [...eligible].sort((left, right) => {
    const timestampDifference = policy.timestampOf(right) - policy.timestampOf(left);
    return timestampDifference || right.id.localeCompare(left.id);
  });
  const uncompacted = sorted.filter((record) => !policy.isCompacted(record));
  const cutoff = now - policy.retentionMs;
  const allCandidates: RetentionCandidate<T>[] = [];

  for (const [rank, record] of uncompacted.entries()) {
    const expired = policy.timestampOf(record) < cutoff;
    const beyondDetailedLimit = rank >= policy.detailedLimit;
    if (!expired && !beyondDetailedLimit) continue;

    const reason: RetentionReason = expired && beyondDetailedLimit
      ? 'age-and-rank'
      : expired
        ? 'age'
        : 'rank';
    const projected = policy.compact(
      record,
      Math.max(now, policy.timestampOf(record)),
    );
    allCandidates.push({
      record,
      projected,
      rank,
      reason,
      bytesBefore: serializedBytes(record),
      bytesAfter: serializedBytes(projected),
    });
  }

  const maxWrites = policy.maxWritesPerSweep ?? Number.POSITIVE_INFINITY;
  const candidates = allCandidates.slice(0, maxWrites);
  const skipped = allCandidates.length - candidates.length;
  const bytesBefore = records.reduce(
    (total, record) => total + serializedBytes(record),
    0,
  );
  const projectedReduction = candidates.reduce(
    (total, candidate) => total + candidate.bytesBefore - candidate.bytesAfter,
    0,
  );

  return {
    recordKind: policy.recordKind,
    scanned: records.length,
    eligible: eligible.length,
    candidateCount: allCandidates.length,
    candidates,
    alreadyCompacted,
    skipped,
    remaining: uncompacted.length,
    bytesBefore,
    projectedBytesAfter: Math.max(0, bytesBefore - projectedReduction),
  };
}

/**
 * Execute a previously created plan. Shadow execution never calls save.
 */
export async function executeRetentionPlan<T extends { id: string }>(
  plan: RetentionPlan<T>,
  policy: RetentionPolicy<T>,
  options: RetentionExecutionOptions<T> = {},
): Promise<RetentionExecutionResult> {
  const result: RetentionExecutionResult = {
    selected: plan.candidates.length,
    compacted: 0,
    alreadyCompacted: plan.alreadyCompacted,
    skipped: plan.skipped,
    failed: 0,
    unauthorized: 0,
    remaining: plan.remaining,
    bytesBefore: plan.bytesBefore,
    projectedBytesAfter: plan.projectedBytesAfter,
  };

  if (options.shadow) return result;

  for (const [index, candidate] of plan.candidates.entries()) {
    if (
      options.authorizeWrite
      && !await options.authorizeWrite(candidate.projected, candidate)
    ) {
      result.unauthorized = plan.candidates.length - index;
      break;
    }

    try {
      await policy.save(candidate.projected);
      result.compacted += 1;
      result.remaining -= 1;
    } catch (error) {
      result.failed += 1;
      options.onWriteFailure?.(candidate.record, error);
      if (!options.continueOnFailure) throw error;
    }
  }

  return result;
}

/**
 * Backward-compatible active compaction adapter used by completion hooks.
 */
export async function applyRetention<T extends { id: string }>(
  records: readonly T[],
  policy: RetentionPolicy<T>,
  now: number = Date.now(),
): Promise<RetentionResult> {
  const plan = planRetention(records, policy, now);
  const result = await executeRetentionPlan(plan, policy);
  return {
    compacted: result.compacted,
    remaining: result.remaining,
  };
}
