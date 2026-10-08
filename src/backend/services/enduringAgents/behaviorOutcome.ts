import { FEATURES } from '@/config/features';
import {
  BEHAVIOR_OUTCOME_MAX_COUNTED_ACTIVITY_IDS,
  BEHAVIOR_OUTCOME_METRIC_SCHEMA_VERSION,
  BehaviorOutcomeMetricSchema,
  type BehaviorOutcomeMetric,
  type BehaviorOutcomeVerdict,
  type BehaviorOutcomeWindow,
  type BehaviorProposal,
  type PersonaActivity,
} from '@/shared/types/enduringAgent';
import { createLogger } from '@/utils/logger';

import {
  BEHAVIOR_OUTCOME_DETECTOR_ACTOR,
  BEHAVIOR_OUTCOME_DETECTOR_VERSION,
  BEHAVIOR_OUTCOME_POLICY,
} from './behaviorOutcomePolicy';
import { stableEnduringAgentId } from './ids';
import { withPersonaRuntimeLock } from './runtimeLock';
import {
  BehaviorBindingActivationConflictError,
  getBehaviorOutcomeMetric,
  getBehaviorRevision,
  getPersona,
  listBehaviorOutcomeMetrics,
  listPersonaActivities,
  mutateBehaviorOutcomeMetric,
  saveBehaviorOutcomeMetric,
} from './store';

const log = createLogger('backend/services/enduringAgents/behaviorOutcome');

/** Autonomy levels that may be reverted without a human in the loop. */
const AUTO_ROLLBACK_AUTONOMY_LEVELS = ['propose_overrides', 'auto_apply_validated'];

export function behaviorOutcomeMetricId(proposalId: string): string {
  return stableEnduringAgentId('outcome', {
    purpose: 'behavior-outcome-metric-v1',
    proposalId,
  });
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percent(rate: number): string {
  return `${round(rate * 100, 1).toFixed(1)}%`;
}

export function isTerminalOutcomeActivity(activity: PersonaActivity): boolean {
  return activity.status === 'completed'
    || activity.status === 'cancelled'
    || activity.status === 'error';
}

function emptyWindow(at: number): BehaviorOutcomeWindow {
  return {
    samples: 0,
    succeeded: 0,
    partial: 0,
    blocked: 0,
    failed: 0,
    unknown: 0,
    errored: 0,
    cancelled: 0,
    successRate: 0,
    windowStartedAt: at,
    windowEndedAt: at,
  };
}

function activityTimestamp(activity: PersonaActivity): number {
  return activity.completedAt ?? activity.updatedAt;
}

/**
 * Fold one terminal Activity into a window. A `completed` Activity without a
 * semantic outcome is deliberately counted as `unknown`, never as a success:
 * the detector must not be able to talk itself into a good verdict from
 * missing data.
 */
function addSample(
  window: BehaviorOutcomeWindow,
  activity: PersonaActivity,
): BehaviorOutcomeWindow {
  const at = activityTimestamp(activity);
  const next: BehaviorOutcomeWindow = {
    ...window,
    samples: window.samples + 1,
    windowStartedAt: window.samples === 0 ? at : Math.min(window.windowStartedAt, at),
    windowEndedAt: window.samples === 0 ? at : Math.max(window.windowEndedAt, at),
  };
  if (activity.status === 'error') next.errored += 1;
  if (activity.status === 'cancelled') next.cancelled += 1;
  switch (activity.outcome?.resolution) {
    case 'succeeded': next.succeeded += 1; break;
    case 'partial': next.partial += 1; break;
    case 'blocked': next.blocked += 1; break;
    case 'failed': next.failed += 1; break;
    default: next.unknown += 1; break;
  }
  next.successRate = next.samples === 0 ? 0 : round(next.succeeded / next.samples);
  return next;
}

function foldWindow(
  activities: PersonaActivity[],
  fallbackAt: number,
): BehaviorOutcomeWindow {
  return activities.reduce(addSample, emptyWindow(fallbackAt));
}

/**
 * Freeze the pre-change baseline for an activated proposal.
 *
 * Idempotent by construction: the metric id is derived from the proposal id, so
 * an activation retry returns the existing record untouched. Callers treat a
 * failure here as "no metric", which simply means the detector never fires.
 */
export async function snapshotBehaviorOutcomeBaseline(
  proposal: BehaviorProposal,
  now = Date.now(),
): Promise<BehaviorOutcomeMetric | null> {
  if (!FEATURES.ENABLE_PERSONA_BEHAVIOR_OUTCOME_METRICS) return null;
  if (proposal.status !== 'activated' || !proposal.activatedRevisionId) return null;
  if (proposal.activatedRevisionId === proposal.baseBehaviorRevisionId) return null;

  const id = behaviorOutcomeMetricId(proposal.id);
  const existing = await getBehaviorOutcomeMetric(id);
  if (existing) return existing;

  const [baseRevision, activatedRevision] = await Promise.all([
    getBehaviorRevision(proposal.baseBehaviorRevisionId),
    getBehaviorRevision(proposal.activatedRevisionId),
  ]);
  if (!baseRevision || !activatedRevision) return null;

  const activities = await listPersonaActivities(proposal.personaId);
  const lookbackStart = now - BEHAVIOR_OUTCOME_POLICY.baselineLookbackMs;
  const baselineActivities = activities.filter((activity) => (
    isTerminalOutcomeActivity(activity)
    && activity.behaviorRevisionId === proposal.baseBehaviorRevisionId
    && activityTimestamp(activity) >= lookbackStart
  ));

  const metric = BehaviorOutcomeMetricSchema.parse({
    schemaVersion: BEHAVIOR_OUTCOME_METRIC_SCHEMA_VERSION,
    id,
    personaId: proposal.personaId,
    behaviorId: proposal.behaviorId,
    slotKey: proposal.slotKey,
    proposalId: proposal.id,
    baseBehaviorRevisionId: proposal.baseBehaviorRevisionId,
    baseContentHash: baseRevision.contentHash,
    activatedRevisionId: proposal.activatedRevisionId,
    activatedContentHash: activatedRevision.contentHash,
    detectorVersion: BEHAVIOR_OUTCOME_DETECTOR_VERSION,
    policy: { ...BEHAVIOR_OUTCOME_POLICY },
    baseline: foldWindow(baselineActivities, now),
    observed: emptyWindow(now),
    verdict: 'pending',
    countedActivityIds: [],
    activatedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return saveBehaviorOutcomeMetric(metric);
}

function classify(metric: BehaviorOutcomeMetric): {
  verdict: BehaviorOutcomeVerdict;
  reason: string;
} {
  const { baseline, observed, policy } = metric;
  if (observed.samples < policy.minSamples) {
    return {
      verdict: 'insufficient_samples',
      reason: `Observed ${observed.samples} of the ${policy.minSamples} completed runs `
        + 'required before this change can be judged.',
    };
  }
  if (baseline.samples < policy.minSamples) {
    return {
      verdict: 'insufficient_samples',
      reason: `The earlier Behavior only has ${baseline.samples} of the ${policy.minSamples} `
        + 'completed runs required for a fair comparison.',
    };
  }
  const delta = round(observed.successRate - baseline.successRate);
  const summary = `Success rate moved from ${percent(baseline.successRate)} `
    + `(n=${baseline.samples}) to ${percent(observed.successRate)} (n=${observed.samples}).`;
  if (delta <= -policy.regressionDelta) {
    return {
      verdict: 'regressed',
      reason: `${summary} That is a drop of ${percent(Math.abs(delta))}, at or beyond the `
        + `${percent(policy.regressionDelta)} regression threshold `
        + `(detector ${metric.detectorVersion}).`,
    };
  }
  if (delta >= policy.improvementDelta) {
    return {
      verdict: 'improved',
      reason: `${summary} That is a gain of ${percent(delta)}, at or beyond the `
        + `${percent(policy.improvementDelta)} improvement threshold `
        + `(detector ${metric.detectorVersion}).`,
    };
  }
  return {
    verdict: 'stable',
    reason: `${summary} That is within the neutral band `
      + `(detector ${metric.detectorVersion}).`,
  };
}

async function persistVerdict(
  metric: BehaviorOutcomeMetric,
  verdict: BehaviorOutcomeVerdict,
  reason: string,
  extra: { autoRollbackAt?: number } = {},
): Promise<BehaviorOutcomeMetric> {
  const updated = await mutateBehaviorOutcomeMetric(metric.id, (current) => {
    if (
      current.verdict === verdict
      && current.verdictReason === reason
      && current.autoRollbackAt === extra.autoRollbackAt
    ) return null;
    return {
      ...current,
      verdict,
      verdictReason: reason,
      ...(extra.autoRollbackAt !== undefined
        ? { autoRollbackAt: extra.autoRollbackAt }
        : {}),
      updatedAt: Math.max(Date.now(), current.updatedAt),
    };
  });
  return updated ?? metric;
}

/**
 * Automatic revert. Deliberately reuses the unmodified
 * `rollbackBehaviorProposal` compare-and-swap: a second rollback path would
 * double the safety surface. On any conflict this records what happened and
 * stops — it never retries and never forces a binding.
 */
async function maybeAutoRollback(
  metric: BehaviorOutcomeMetric,
  reason: string,
): Promise<BehaviorOutcomeMetric> {
  if (!FEATURES.ENABLE_PERSONA_BEHAVIOR_OUTCOME_AUTO_ROLLBACK) return metric;

  const persona = await getPersona(metric.personaId);
  if (!persona || !AUTO_ROLLBACK_AUTONOMY_LEVELS.includes(persona.autonomyLevel)) {
    return persistVerdict(
      metric,
      'regressed',
      `${reason} FLUJO did not undo it automatically because this Persona's review `
      + 'setting requires a person to decide.',
    );
  }

  const { getBehaviorProposal, rollbackBehaviorProposal } = await import('./behaviorLearning');
  return withPersonaRuntimeLock(metric.personaId, async (lock) => {
    await lock.assertOwned();
    const proposal = await getBehaviorProposal(metric.proposalId);
    if (!proposal || proposal.status !== 'activated') {
      return persistVerdict(
        metric,
        'regressed',
        `${reason} The improvement was no longer in use, so nothing was undone.`,
      );
    }

    try {
      await rollbackBehaviorProposal(
        metric.proposalId,
        { actor: BEHAVIOR_OUTCOME_DETECTOR_ACTOR, reason },
        { auditAction: 'auto_rolled_back' },
      );
    } catch (error) {
      if (error instanceof BehaviorBindingActivationConflictError) {
        return persistVerdict(
          metric,
          'regressed',
          `${reason} FLUJO stopped without undoing it because the Behavior changed while the `
          + 'result was being checked.',
        );
      }
      throw error;
    }

    const at = Date.now();
    return persistVerdict(metric, 'rolled_back', reason, { autoRollbackAt: at });
  });
}

/**
 * Evaluate the regression detector for one metric and, when everything permits
 * it, revert the change. Below the minimum sample size on either side the
 * detector records `insufficient_samples` and takes no action at all.
 */
export async function evaluateBehaviorOutcomeRegression(
  metric: BehaviorOutcomeMetric,
): Promise<BehaviorOutcomeMetric> {
  if (metric.verdict === 'rolled_back') return metric;
  const { verdict, reason } = classify(metric);
  if (verdict !== 'regressed') return persistVerdict(metric, verdict, reason);
  // Record the regression first: shadow mode must be observable even when the
  // automatic revert is not permitted.
  const recorded = await persistVerdict(metric, 'regressed', reason);
  return maybeAutoRollback(recorded, reason);
}

/**
 * Count one terminal Activity against the metric of the revision it ran on.
 * Best-effort and idempotent; the dispatcher's terminal projection may retry.
 */
export async function recordBehaviorOutcomeSample(
  activity: PersonaActivity,
): Promise<BehaviorOutcomeMetric | null> {
  if (!FEATURES.ENABLE_PERSONA_BEHAVIOR_OUTCOME_METRICS) return null;
  if (!isTerminalOutcomeActivity(activity)) return null;
  if (!activity.personaId || !activity.behaviorRevisionId) return null;

  const metrics = await listBehaviorOutcomeMetrics(activity.personaId);
  const metric = metrics.find((candidate) => (
    candidate.activatedRevisionId === activity.behaviorRevisionId
    && candidate.verdict !== 'rolled_back'
  ));
  if (!metric) return null;

  const at = activityTimestamp(activity);
  if (at > metric.activatedAt + metric.policy.observationWindowMs) return metric;

  const updated = await mutateBehaviorOutcomeMetric(metric.id, (current) => {
    if (current.verdict === 'rolled_back') return null;
    if (current.countedActivityIds.includes(activity.id)) return null;
    const countedActivityIds = [...current.countedActivityIds, activity.id]
      .slice(-BEHAVIOR_OUTCOME_MAX_COUNTED_ACTIVITY_IDS);
    return {
      ...current,
      observed: addSample(current.observed, activity),
      countedActivityIds,
      updatedAt: Math.max(Date.now(), current.updatedAt),
    };
  });
  if (!updated) return null;
  return evaluateBehaviorOutcomeRegression(updated);
}

/** Best-effort wrapper for call sites that must never fail because of a metric. */
export async function recordBehaviorOutcomeSampleSafely(
  activity: PersonaActivity,
): Promise<void> {
  try {
    await recordBehaviorOutcomeSample(activity);
  } catch (error) {
    log.warn(`Deferred Behavior outcome metric for Activity ${activity.id}:`, error);
  }
}
