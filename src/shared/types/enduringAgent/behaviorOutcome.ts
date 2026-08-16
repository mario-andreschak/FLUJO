import { z } from 'zod';

import type { BehaviorProposal } from './behaviorLearning';
import {
  BehaviorSlotKeySchema,
  EnduringAgentIdSchema,
} from './schemas';

/**
 * Outcome metrics for an activated Behavior proposal (issue #455).
 *
 * One record is frozen per activated proposal. It carries the baseline window
 * measured on the *previous* immutable revision and the observed window that
 * accumulates while the *activated* revision is live, so a regression detector
 * can compare like with like and, when permitted, revert the change through the
 * existing compare-and-swap rollback primitive.
 */
export const BEHAVIOR_OUTCOME_METRIC_SCHEMA_VERSION = 1 as const;

export const BEHAVIOR_OUTCOME_VERDICTS = [
  'pending',
  'insufficient_samples',
  'improved',
  'stable',
  'regressed',
  'rolled_back',
] as const;
export type BehaviorOutcomeVerdict = (typeof BEHAVIOR_OUTCOME_VERDICTS)[number];

/**
 * Upper bound on the idempotency guard. Counters keep increasing after the cap
 * is reached; only the most recent ids are retained for duplicate suppression,
 * which keeps one record bounded without ever losing an accepted sample.
 */
export const BEHAVIOR_OUTCOME_MAX_COUNTED_ACTIVITY_IDS = 500;

export interface BehaviorOutcomeWindow {
  /** Terminal Activities counted in this window. */
  samples: number;
  succeeded: number;
  partial: number;
  blocked: number;
  failed: number;
  unknown: number;
  /** Activities whose runtime status was `error`. */
  errored: number;
  /** Activities whose runtime status was `cancelled`. */
  cancelled: number;
  /** succeeded / samples, exactly 0 when samples === 0. */
  successRate: number;
  windowStartedAt: number;
  windowEndedAt: number;
}

/** Frozen copy of the thresholds a metric was evaluated with, for reproducibility. */
export interface BehaviorOutcomePolicy {
  minSamples: number;
  regressionDelta: number;
  improvementDelta: number;
  baselineLookbackMs: number;
  observationWindowMs: number;
}

export interface BehaviorOutcomeMetric {
  schemaVersion: typeof BEHAVIOR_OUTCOME_METRIC_SCHEMA_VERSION;
  /** Stable id derived from the proposal id, so activation retries are no-ops. */
  id: string;
  personaId: string;
  behaviorId: string;
  slotKey: string;
  proposalId: string;
  baseBehaviorRevisionId: string;
  baseContentHash: string;
  activatedRevisionId: string;
  activatedContentHash: string;
  detectorVersion: string;
  policy: BehaviorOutcomePolicy;
  /** Frozen at activation from historical Activities on the base revision. */
  baseline: BehaviorOutcomeWindow;
  /** Accumulated from terminal Activities pinned to the activated revision. */
  observed: BehaviorOutcomeWindow;
  verdict: BehaviorOutcomeVerdict;
  verdictReason?: string;
  autoRollbackAt?: number;
  /** Idempotency guard, capped at BEHAVIOR_OUTCOME_MAX_COUNTED_ACTIVITY_IDS. */
  countedActivityIds: string[];
  activatedAt: number;
  createdAt: number;
  updatedAt: number;
}

/** Read-only projection returned by the Improvements API. */
export interface BehaviorProposalWithOutcome extends BehaviorProposal {
  outcome?: BehaviorOutcomeMetric;
}

const TimestampSchema = z.number().int().nonnegative();
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const CountSchema = z.number().int().nonnegative();
const RateSchema = z.number().min(0).max(1);

export const BehaviorOutcomeWindowSchema = z.object({
  samples: CountSchema,
  succeeded: CountSchema,
  partial: CountSchema,
  blocked: CountSchema,
  failed: CountSchema,
  unknown: CountSchema,
  errored: CountSchema,
  cancelled: CountSchema,
  successRate: RateSchema,
  windowStartedAt: TimestampSchema,
  windowEndedAt: TimestampSchema,
}).strict().superRefine((window, ctx) => {
  if (window.windowEndedAt < window.windowStartedAt) {
    ctx.addIssue({
      code: 'custom',
      message: 'windowEndedAt cannot precede windowStartedAt.',
      path: ['windowEndedAt'],
    });
  }
  if (window.samples === 0 && window.successRate !== 0) {
    ctx.addIssue({
      code: 'custom',
      message: 'An empty outcome window cannot report a success rate.',
      path: ['successRate'],
    });
  }
});

export const BehaviorOutcomePolicySchema = z.object({
  minSamples: z.number().int().positive(),
  regressionDelta: RateSchema,
  improvementDelta: RateSchema,
  baselineLookbackMs: z.number().int().positive(),
  observationWindowMs: z.number().int().positive(),
}).strict();

export const BehaviorOutcomeMetricSchema: z.ZodType<BehaviorOutcomeMetric> = z.object({
  schemaVersion: z.literal(BEHAVIOR_OUTCOME_METRIC_SCHEMA_VERSION),
  id: EnduringAgentIdSchema,
  personaId: EnduringAgentIdSchema,
  behaviorId: EnduringAgentIdSchema,
  slotKey: BehaviorSlotKeySchema,
  proposalId: EnduringAgentIdSchema,
  baseBehaviorRevisionId: EnduringAgentIdSchema,
  baseContentHash: Sha256Schema,
  activatedRevisionId: EnduringAgentIdSchema,
  activatedContentHash: Sha256Schema,
  detectorVersion: z.string().trim().min(1).max(128),
  policy: BehaviorOutcomePolicySchema,
  baseline: BehaviorOutcomeWindowSchema,
  observed: BehaviorOutcomeWindowSchema,
  verdict: z.enum(BEHAVIOR_OUTCOME_VERDICTS),
  verdictReason: z.string().trim().min(1).max(10_000).optional(),
  autoRollbackAt: TimestampSchema.optional(),
  countedActivityIds: z.array(EnduringAgentIdSchema)
    .max(BEHAVIOR_OUTCOME_MAX_COUNTED_ACTIVITY_IDS),
  activatedAt: TimestampSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict().superRefine((metric, ctx) => {
  if (metric.updatedAt < metric.createdAt) {
    ctx.addIssue({
      code: 'custom',
      message: 'updatedAt cannot precede createdAt.',
      path: ['updatedAt'],
    });
  }
  if (metric.autoRollbackAt !== undefined && metric.verdict !== 'rolled_back') {
    ctx.addIssue({
      code: 'custom',
      message: 'Only an automatically reverted metric may record autoRollbackAt.',
      path: ['autoRollbackAt'],
    });
  }
  if (metric.activatedRevisionId === metric.baseBehaviorRevisionId) {
    ctx.addIssue({
      code: 'custom',
      message: 'An outcome metric must compare two different immutable revisions.',
      path: ['activatedRevisionId'],
    });
  }
});
