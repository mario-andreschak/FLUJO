/**
 * Shared planning and execution primitives for Persona runtime retention.
 *
 * Planning is pure so measuring (`shadow`) and cleanup (`active`) see the exact
 * same deterministic candidate set. Writing is a separate step that needs a
 * grant from the rollout control and re-checks it before every record.
 */

import {
  assertPersonaRuntimeRetentionWriteGrant,
  type PersonaRuntimeRetentionWriteGrant,
} from './personaRuntimeRetentionControl';

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
  /** True when the compacted form is schema-valid and kept the record's identity. */
  isValidCompaction: (record: T, compacted: T) => boolean;
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

export interface RetentionPlanOptions<T> {
  /** Records unfinished work still points at. They are never rewritten. */
  isInUse?: (record: T) => boolean;
}

export interface RetentionPlan<T> {
  recordKind: string;
  scanned: number;
  eligible: number;
  /** Records cleanup would rewrite, before the per-sweep write cap. */
  candidateCount: number;
  /** The capped write set, newest first. */
  candidates: RetentionCandidate<T>[];
  /** Old enough to clean up, but still in use by unfinished work. */
  inUse: number;
  /** Old enough, but the cleaned-up form would not be valid. */
  invalid: number;
  /** Old enough, but cleaning up would not make the record smaller. */
  notSmaller: number;
  alreadyCompacted: number;
  /** Candidates left for a later sweep by the write cap. */
  overCap: number;
  remaining: number;
  bytesBefore: number;
  projectedBytesAfter: number;
}

export interface RetentionExecutionResult {
  selected: number;
  compacted: number;
  failed: number;
  /** Planned writes not made because the grant was withdrawn or a write failed. */
  stopped: number;
  remaining: number;
}

export interface RetentionExecutionOptions<T> {
  /** Null measures only: nothing is written. */
  grant: PersonaRuntimeRetentionWriteGrant | null;
  onWriteFailure?: (record: T, error: unknown) => void;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * Build the deterministic age/rank plan without performing persistence.
 * A record is rewritten only when nothing still uses it, its cleaned-up form
 * is valid, and it gets smaller.
 */
export function planRetention<T extends { id: string }>(
  records: readonly T[],
  policy: RetentionPolicy<T>,
  now: number,
  options: RetentionPlanOptions<T> = {},
): RetentionPlan<T> {
  const alreadyCompacted = records.filter((record) => policy.isCompacted(record)).length;
  const eligible = records.filter((record) => policy.isEligible(record));
  const sorted = [...eligible].sort((left, right) => {
    const timestampDifference = policy.timestampOf(right) - policy.timestampOf(left);
    return timestampDifference || right.id.localeCompare(left.id);
  });
  const uncompacted = sorted.filter((record) => !policy.isCompacted(record));
  const cutoff = now - policy.retentionMs;
  const writeSet: RetentionCandidate<T>[] = [];
  let inUse = 0;
  let invalid = 0;
  let notSmaller = 0;

  for (const [rank, record] of uncompacted.entries()) {
    const expired = policy.timestampOf(record) < cutoff;
    const beyondDetailedLimit = rank >= policy.detailedLimit;
    if (!expired && !beyondDetailedLimit) continue;
    if (options.isInUse?.(record)) {
      inUse += 1;
      continue;
    }
    const projected = policy.compact(record, Math.max(now, policy.timestampOf(record)));
    if (!policy.isValidCompaction(record, projected)) {
      invalid += 1;
      continue;
    }
    const bytesBefore = serializedBytes(record);
    const bytesAfter = serializedBytes(projected);
    if (bytesAfter >= bytesBefore) {
      notSmaller += 1;
      continue;
    }
    writeSet.push({
      record,
      projected,
      rank,
      reason: expired && beyondDetailedLimit ? 'age-and-rank' : expired ? 'age' : 'rank',
      bytesBefore,
      bytesAfter,
    });
  }

  const candidates = writeSet.slice(0, policy.maxWritesPerSweep ?? Number.POSITIVE_INFINITY);
  const bytesBefore = records.reduce((total, record) => total + serializedBytes(record), 0);
  const projectedReduction = candidates.reduce(
    (total, candidate) => total + candidate.bytesBefore - candidate.bytesAfter,
    0,
  );

  return {
    recordKind: policy.recordKind,
    scanned: records.length,
    eligible: eligible.length,
    candidateCount: writeSet.length,
    candidates,
    inUse,
    invalid,
    notSmaller,
    alreadyCompacted,
    overCap: writeSet.length - candidates.length,
    remaining: uncompacted.length,
    bytesBefore,
    projectedBytesAfter: bytesBefore - projectedReduction,
  };
}

/**
 * Execute a plan. Without a grant nothing is written. With one, the grant is
 * re-checked before every write, and the first failed write stops the rest.
 */
export async function executeRetentionPlan<T extends { id: string }>(
  plan: RetentionPlan<T>,
  policy: RetentionPolicy<T>,
  options: RetentionExecutionOptions<T>,
): Promise<RetentionExecutionResult> {
  const result: RetentionExecutionResult = {
    selected: plan.candidates.length,
    compacted: 0,
    failed: 0,
    stopped: 0,
    remaining: plan.remaining,
  };
  const { grant } = options;
  if (!grant) return result;
  assertPersonaRuntimeRetentionWriteGrant(grant);

  for (const [index, candidate] of plan.candidates.entries()) {
    if (!await grant.authorize()) {
      result.stopped = plan.candidates.length - index;
      break;
    }
    try {
      await policy.save(candidate.projected);
      result.compacted += 1;
      result.remaining -= 1;
    } catch (error) {
      result.failed += 1;
      result.stopped = plan.candidates.length - index - 1;
      options.onWriteFailure?.(candidate.record, error);
      break;
    }
  }
  return result;
}
