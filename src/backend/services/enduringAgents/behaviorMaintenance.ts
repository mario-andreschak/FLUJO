import { createHash } from 'crypto';

import { FEATURES } from '@/config/features';
import {
  BEHAVIOR_MAINTENANCE_RUN_SCHEMA_VERSION,
  BehaviorMaintenanceRunSchema,
  type BehaviorMaintenanceAction,
  type BehaviorMaintenanceRun,
  type BehaviorOutcomeMetric,
  type PersonaActivity,
} from '@/shared/types/enduringAgent';
import { createLogger } from '@/utils/logger';
import { getCurrentWorkspace } from '@/utils/workspace';

import { suggestBehaviorInstructionImprovement } from './behaviorLearning';
import { canonicalJson } from './behaviorRevisions';
import { randomEnduringAgentId, stableEnduringAgentId } from './ids';
import { withPersonaRuntimeLock } from './runtimeLock';
import {
  getBehaviorMaintenanceRun,
  getBehaviorRevision,
  getPersona,
  getPersonaActivity,
  listBehaviorMaintenanceRuns,
  listBehaviorOutcomeMetrics,
  listPersonaActivities,
  saveBehaviorMaintenanceRun,
} from './store';

const log = createLogger('backend/services/enduringAgents/behaviorMaintenance');

export const BEHAVIOR_MAINTENANCE_DETECTOR_VERSION = 'activity-outcome-v2';
export const BEHAVIOR_MAINTENANCE_POLICY_VERSION = 'shadow-manual-v2';
export const BEHAVIOR_MAINTENANCE_EVALUATION_SUITE_VERSION = 'instruction-only-v1';
export const BEHAVIOR_MAINTENANCE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const BEHAVIOR_MAINTENANCE_DIAGNOSIS_LEASE_MS = 60 * 1_000;
export const BEHAVIOR_MAINTENANCE_DETAILED_RUN_LIMIT = 100;
const ELIGIBLE_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_SOURCE_ACTIVITIES = 20;
export const DEFAULT_BEHAVIOR_AUTO_ROLLBACK_COOLDOWN_MS = 60 * 60 * 1_000;

type SuppressedCandidate =
  NonNullable<BehaviorMaintenanceRun['suppressedCandidates']>[number];

interface ActiveAutoRollbackCooldown {
  activatedRevisionId: string;
  proposalId: string;
  metricId: string;
  autoRollbackAt: number;
  cooldownUntil: number;
}

const ACTIVE_EXECUTION_STATES = new Set<BehaviorMaintenanceRun['state']>([
  'queued',
  'collecting',
  'diagnosing',
  'drafting',
  'evaluating',
]);

const COMPACTION_ELIGIBLE_STATES = new Set<BehaviorMaintenanceRun['state']>([
  'completed',
  'failed',
  'cancelled',
  'awaiting_review',
]);

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function getBehaviorAutoRollbackCooldownMs(
  raw = process.env.FLUJO_BEHAVIOR_AUTO_ROLLBACK_COOLDOWN_MS,
): number {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_BEHAVIOR_AUTO_ROLLBACK_COOLDOWN_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed)
    && Number.isInteger(parsed)
    && parsed >= DEFAULT_BEHAVIOR_AUTO_ROLLBACK_COOLDOWN_MS
    ? parsed
    : DEFAULT_BEHAVIOR_AUTO_ROLLBACK_COOLDOWN_MS;
}

export function activeAutoRollbackCooldownsByRevision(
  metrics: BehaviorOutcomeMetric[],
  personaId: string,
  now: number,
  cooldownMs: number,
): Map<string, ActiveAutoRollbackCooldown> {
  const active = new Map<string, ActiveAutoRollbackCooldown>();
  for (const metric of metrics) {
    if (
      metric.personaId !== personaId
      || metric.verdict !== 'rolled_back'
      || metric.autoRollbackAt === undefined
    ) continue;

    const cooldownUntil = metric.autoRollbackAt + cooldownMs;
    if (now >= cooldownUntil) continue;

    const candidate: ActiveAutoRollbackCooldown = {
      activatedRevisionId: metric.activatedRevisionId,
      proposalId: metric.proposalId,
      metricId: metric.id,
      autoRollbackAt: metric.autoRollbackAt,
      cooldownUntil,
    };
    const existing = active.get(metric.activatedRevisionId);
    if (
      !existing
      || candidate.cooldownUntil > existing.cooldownUntil
      || (
        candidate.cooldownUntil === existing.cooldownUntil
        && candidate.metricId.localeCompare(existing.metricId) > 0
      )
    ) {
      active.set(metric.activatedRevisionId, candidate);
    }
  }
  return active;
}

export function isEligibleBehaviorMaintenanceActivity(
  activity: PersonaActivity,
  now: number,
): boolean {
  return activity.kind !== 'maintenance'
    && activity.completedAt !== undefined
    && activity.completedAt >= now - ELIGIBLE_WINDOW_MS
    && (activity.status === 'completed' || activity.status === 'error');
}

/**
 * Collect only bounded, already-sanitized outcome metadata. Raw prompts,
 * transcripts, tool payloads, credentials, and errors never enter this seam.
 */
export async function collectBehaviorMaintenanceEvidenceWindow(
  personaId: string,
  now = Date.now(),
): Promise<{
  activities: PersonaActivity[];
  sourceWindowDigest: string;
  evidenceTrust: BehaviorMaintenanceRun['evidenceTrust'];
  suppressedCandidates: SuppressedCandidate[];
}> {
  const candidates = (await listPersonaActivities(personaId))
    .filter((activity) => isEligibleBehaviorMaintenanceActivity(activity, now));
  let eligibleCandidates = candidates;
  let suppressedCandidates: SuppressedCandidate[] = [];

  if (FEATURES.ENABLE_PERSONA_BEHAVIOR_OUTCOME_AUTO_ROLLBACK) {
    const cooldowns = activeAutoRollbackCooldownsByRevision(
      await listBehaviorOutcomeMetrics(personaId),
      personaId,
      now,
      getBehaviorAutoRollbackCooldownMs(),
    );
    const suppressedActivityIds = new Set<string>();
    suppressedCandidates = candidates
      .map((activity): (SuppressedCandidate & { completedAt: number }) | null => {
        if (!activity.behaviorRevisionId) return null;
        const cooldown = cooldowns.get(activity.behaviorRevisionId);
        if (!cooldown) return null;
        suppressedActivityIds.add(activity.id);
        return {
          activityId: activity.id,
          activatedRevisionId: cooldown.activatedRevisionId,
          proposalId: cooldown.proposalId,
          metricId: cooldown.metricId,
          reasonCode: 'auto_rollback_cooldown',
          autoRollbackAt: cooldown.autoRollbackAt,
          cooldownUntil: cooldown.cooldownUntil,
          completedAt: activity.completedAt ?? 0,
        };
      })
      .filter((candidate): candidate is SuppressedCandidate & { completedAt: number } => (
        candidate !== null
      ))
      .sort((left, right) => (
        right.completedAt - left.completedAt
        || right.activityId.localeCompare(left.activityId)
      ))
      .slice(0, MAX_SOURCE_ACTIVITIES)
      .map(({ completedAt: _completedAt, ...candidate }) => candidate);
    eligibleCandidates = candidates.filter((activity) => !suppressedActivityIds.has(activity.id));
  }

  const activities = eligibleCandidates
    .sort((left, right) => (
      (right.completedAt ?? 0) - (left.completedAt ?? 0)
      || right.id.localeCompare(left.id)
    ))
    .slice(0, MAX_SOURCE_ACTIVITIES);

  const externallyTainted = activities.some((activity) => (
    activity.outcome?.evidenceRefs.some((ref) => ref.producer === 'external_untrusted') === true
  ));
  const missingCount = activities.filter((activity) => !activity.outcome).length;
  const untrustedCount = activities.filter((activity) => (
    activity.outcome?.decisionSource === 'persona_claim'
  )).length;
  const trustedCount = Math.max(0, activities.length - missingCount - untrustedCount);

  return {
    activities,
    sourceWindowDigest: digest(activities.map((activity) => ({
      id: activity.id,
      behaviorRevisionId: activity.behaviorRevisionId,
      completedAt: activity.completedAt,
      outcome: activity.outcome
        ? {
            schemaVersion: activity.outcome.schemaVersion,
            resolution: activity.outcome.resolution,
            blockerKind: activity.outcome.blockerKind,
            decisionSource: activity.outcome.decisionSource,
            evidenceRefs: activity.outcome.evidenceRefs.map((ref) => ({
              kind: ref.kind,
              id: ref.id,
              producer: ref.producer,
              contentDigest: ref.contentDigest,
            })),
          }
        : null,
    }))),
    evidenceTrust: {
      trustedCount,
      untrustedCount,
      missingCount,
      externallyTainted,
    },
    suppressedCandidates,
  };
}

async function completeLegacyShadowAdmissionRuns(
  runs: BehaviorMaintenanceRun[],
  now: number,
  diagnosisEnabled: boolean,
): Promise<BehaviorMaintenanceRun[]> {
  if (diagnosisEnabled) return runs;

  const normalized: BehaviorMaintenanceRun[] = [];
  for (const run of runs) {
    if (run.state !== 'queued' || run.reasonCode !== 'shadow_admission_only') {
      normalized.push(run);
      continue;
    }

    const completedAt = Math.max(now, run.updatedAt);
    normalized.push(await saveBehaviorMaintenanceRun(BehaviorMaintenanceRunSchema.parse({
      ...run,
      state: 'completed',
      action: 'no_change',
      updatedAt: completedAt,
      completedAt,
    }) as BehaviorMaintenanceRun));
  }
  return normalized;
}

/**
 * Admission is serialized by the same cross-process Persona lock used by the
 * Activity runtime. This makes the active-run check and deterministic save one
 * atomic decision across concurrent requests and restart reconciliation.
 */
export async function admitBehaviorMaintenanceRun(
  sourceActivity: PersonaActivity,
  now = Date.now(),
): Promise<BehaviorMaintenanceRun | null> {
  if (!FEATURES.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_ADMISSION) return null;
  if (!isEligibleBehaviorMaintenanceActivity(sourceActivity, now)) return null;

  return withPersonaRuntimeLock(sourceActivity.personaId, async (lock) => {
    await lock.assertOwned();
    const persona = await getPersona(sourceActivity.personaId);
    if (!persona || persona.autonomyLevel === 'locked') return null;

    const diagnosisEnabled = FEATURES.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_DIAGNOSIS;
    const maintenanceRuns = await completeLegacyShadowAdmissionRuns(
      await listBehaviorMaintenanceRuns(sourceActivity.personaId),
      now,
      diagnosisEnabled,
    );
    const existingActive = maintenanceRuns
      .filter((run) => ACTIVE_EXECUTION_STATES.has(run.state))
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (existingActive) return existingActive;

    const revisionId = sourceActivity.behaviorRevisionId;
    if (!revisionId) return null;
    const revision = await getBehaviorRevision(revisionId);
    if (!revision || revision.personaId !== sourceActivity.personaId) return null;

    const window = await collectBehaviorMaintenanceEvidenceWindow(sourceActivity.personaId, now);
    if (window.suppressedCandidates.length > 0) {
      log.info('Behavior maintenance candidates suppressed by automatic rollback cooldown.', {
        personaId: sourceActivity.personaId,
        suppressedCandidates: window.suppressedCandidates,
      });
    }
    if (window.activities.length === 0) return null;
    const workspaceId = getCurrentWorkspace();
    const id = stableEnduringAgentId('maint', {
      workspaceId,
      personaId: sourceActivity.personaId,
      sourceWindowDigest: window.sourceWindowDigest,
      detectorVersion: BEHAVIOR_MAINTENANCE_DETECTOR_VERSION,
    });
    const existing = await getBehaviorMaintenanceRun(id);
    if (existing) return existing;

    return saveBehaviorMaintenanceRun(BehaviorMaintenanceRunSchema.parse({
      schemaVersion: BEHAVIOR_MAINTENANCE_RUN_SCHEMA_VERSION,
      id,
      workspaceId,
      personaId: sourceActivity.personaId,
      sourceActivityIds: window.activities.map((activity) => activity.id),
      sourceWindowDigest: window.sourceWindowDigest,
      ...(window.suppressedCandidates.length > 0
        ? { suppressedCandidates: window.suppressedCandidates }
        : {}),
      behaviorSlotKey: revision.slotKey,
      baseRevisionId: revision.id,
      baseContentHash: revision.contentHash,
      detectorVersion: BEHAVIOR_MAINTENANCE_DETECTOR_VERSION,
      policyVersion: BEHAVIOR_MAINTENANCE_POLICY_VERSION,
      evaluationSuiteVersion: BEHAVIOR_MAINTENANCE_EVALUATION_SUITE_VERSION,
      state: diagnosisEnabled ? 'queued' : 'completed',
      reasonCode: diagnosisEnabled ? 'diagnosis_pending' : 'shadow_admission_only',
      evidenceTrust: window.evidenceTrust,
      relatedProposalIds: [],
      attempts: 0,
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
      createdAt: now,
      updatedAt: now,
      ...(diagnosisEnabled ? {} : { action: 'no_change', completedAt: now }),
    }) as BehaviorMaintenanceRun);
  });
}

export interface BehaviorMaintenanceDiagnosis {
  action: BehaviorMaintenanceAction;
  reasonCode: string;
  instruction?: string;
}

function reusableInstruction(activities: PersonaActivity[]): string | undefined {
  const counts = new Map<string, { value: string; count: number }>();
  for (const activity of activities) {
    if (activity.outcome?.resolution === 'succeeded') continue;
    const value = activity.outcome?.nextAction?.trim();
    if (!value) continue;
    const key = value.toLocaleLowerCase();
    const current = counts.get(key);
    counts.set(key, { value: value.slice(0, 2_000), count: (current?.count ?? 0) + 1 });
  }
  return [...counts.values()]
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
    .find((candidate) => candidate.count >= 2)?.value;
}

/**
 * Closed, deterministic router over sanitized semantic outcomes. Untrusted,
 * missing, or ambiguous evidence always fails closed to human diagnosis.
 */
export async function diagnoseBehaviorMaintenanceRun(
  run: BehaviorMaintenanceRun,
): Promise<BehaviorMaintenanceDiagnosis> {
  const activities = (await Promise.all(
    run.sourceActivityIds.map((id) => getPersonaActivity(run.personaId, id)),
  )).filter((activity): activity is PersonaActivity => activity !== null);

  if (activities.length !== run.sourceActivityIds.length || activities.some((item) => !item.outcome)) {
    return { action: 'needs_human_diagnosis', reasonCode: 'missing_or_corrupt_evidence' };
  }
  if (run.evidenceTrust.externallyTainted) {
    return { action: 'needs_human_diagnosis', reasonCode: 'external_untrusted_evidence' };
  }

  const outcomes = activities.map((activity) => activity.outcome!);
  if (outcomes.every((outcome) => outcome.resolution === 'succeeded')) {
    return { action: 'no_change', reasonCode: 'goal_achieved_no_reusable_lesson' };
  }

  const setupBlockers = new Set(['approval', 'permission', 'capability', 'policy']);
  if (outcomes.some((outcome) => outcome.blockerKind && setupBlockers.has(outcome.blockerKind))) {
    return { action: 'setup_recommendation', reasonCode: 'setup_or_authority_gap' };
  }

  const instruction = reusableInstruction(activities);
  if (instruction) {
    return {
      action: 'instruction_behavior_candidate',
      reasonCode: 'repeated_reusable_instruction_lesson',
      instruction,
    };
  }

  return { action: 'needs_human_diagnosis', reasonCode: 'ambiguous_or_single_observation' };
}

async function claimBehaviorMaintenanceRun(
  runId: string,
  now: number,
): Promise<BehaviorMaintenanceRun | null> {
  const inspected = await getBehaviorMaintenanceRun(runId);
  if (!inspected) return null;
  return withPersonaRuntimeLock(inspected.personaId, async (lock) => {
    await lock.assertOwned();
    const run = await getBehaviorMaintenanceRun(runId);
    if (!run || !ACTIVE_EXECUTION_STATES.has(run.state)) return null;
    if (
      run.state === 'diagnosing'
      && run.diagnosisLeaseExpiresAt !== undefined
      && run.diagnosisLeaseExpiresAt > now
    ) return null;

    const claimedAt = Math.max(now, run.updatedAt);
    return saveBehaviorMaintenanceRun(BehaviorMaintenanceRunSchema.parse({
      ...run,
      state: 'diagnosing',
      diagnosisLeaseId: randomEnduringAgentId('maintlease'),
      diagnosisLeaseExpiresAt: claimedAt + BEHAVIOR_MAINTENANCE_DIAGNOSIS_LEASE_MS,
      reasonCode: run.state === 'diagnosing'
        ? 'diagnosis_lease_recovered'
        : 'diagnosis_in_progress',
      attempts: run.attempts + 1,
      updatedAt: claimedAt,
      completedAt: undefined,
    }) as BehaviorMaintenanceRun);
  });
}

/**
 * Persist a closed diagnosis discriminator. The optional lease fence prevents a
 * recovered stale worker from overwriting the result of its successor.
 */
export async function recordBehaviorMaintenanceDiagnosis(input: {
  runId: string;
  action: BehaviorMaintenanceAction;
  reasonCode: string;
  relatedProposalIds?: string[];
  diagnosisLeaseId?: string;
  attempts?: number;
  modelCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  now?: number;
}): Promise<BehaviorMaintenanceRun> {
  if (!FEATURES.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_DIAGNOSIS) {
    throw new Error('Persona Behavior maintenance diagnosis is disabled.');
  }
  const inspected = await getBehaviorMaintenanceRun(input.runId);
  if (!inspected) {
    throw new Error(`BehaviorMaintenanceRun ${JSON.stringify(input.runId)} was not found.`);
  }

  return withPersonaRuntimeLock(inspected.personaId, async (lock) => {
    await lock.assertOwned();
    const run = await getBehaviorMaintenanceRun(input.runId);
    if (!run) {
      throw new Error(`BehaviorMaintenanceRun ${JSON.stringify(input.runId)} was not found.`);
    }
    if (!ACTIVE_EXECUTION_STATES.has(run.state)) return run;
    if (
      run.diagnosisLeaseId !== undefined
      && run.diagnosisLeaseId !== input.diagnosisLeaseId
    ) {
      throw new Error('Behavior maintenance diagnosis lease was lost.');
    }
    const now = Math.max(input.now ?? Date.now(), run.updatedAt);
    const awaitingReview = input.action === 'instruction_behavior_candidate';
    return saveBehaviorMaintenanceRun(BehaviorMaintenanceRunSchema.parse({
      ...run,
      state: awaitingReview ? 'awaiting_review' : 'completed',
      diagnosisLeaseId: undefined,
      diagnosisLeaseExpiresAt: undefined,
      action: input.action,
      reasonCode: input.reasonCode,
      relatedProposalIds: input.relatedProposalIds ?? run.relatedProposalIds,
      attempts: input.attempts ?? run.attempts,
      modelCalls: input.modelCalls ?? run.modelCalls,
      inputTokens: input.inputTokens ?? run.inputTokens,
      outputTokens: input.outputTokens ?? run.outputTokens,
      durationMs: input.durationMs ?? run.durationMs,
      updatedAt: now,
      completedAt: awaitingReview ? undefined : now,
    }) as BehaviorMaintenanceRun);
  });
}

async function failBehaviorMaintenanceRun(
  claimed: BehaviorMaintenanceRun,
  now: number,
): Promise<BehaviorMaintenanceRun> {
  return withPersonaRuntimeLock(claimed.personaId, async (lock) => {
    await lock.assertOwned();
    const current = await getBehaviorMaintenanceRun(claimed.id);
    if (!current) throw new Error('Behavior maintenance run disappeared during diagnosis.');
    if (
      current.state !== 'diagnosing'
      || current.diagnosisLeaseId !== claimed.diagnosisLeaseId
    ) return current;
    const completedAt = Math.max(now, current.updatedAt);
    return saveBehaviorMaintenanceRun(BehaviorMaintenanceRunSchema.parse({
      ...current,
      state: 'failed',
      diagnosisLeaseId: undefined,
      diagnosisLeaseExpiresAt: undefined,
      reasonCode: 'diagnosis_execution_failed',
      updatedAt: completedAt,
      completedAt,
    }) as BehaviorMaintenanceRun);
  });
}

export async function executeBehaviorMaintenanceRun(
  runId: string,
  options: {
    now?: number;
    diagnose?: (run: BehaviorMaintenanceRun) => Promise<BehaviorMaintenanceDiagnosis>;
  } = {},
): Promise<BehaviorMaintenanceRun | null> {
  if (!FEATURES.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_DIAGNOSIS) return null;
  const startedAt = options.now ?? Date.now();
  const claimed = await claimBehaviorMaintenanceRun(runId, startedAt);
  if (!claimed) return getBehaviorMaintenanceRun(runId);

  try {
    let diagnosis = await (options.diagnose ?? diagnoseBehaviorMaintenanceRun)(claimed);
    const relatedProposalIds = [...claimed.relatedProposalIds];

    if (diagnosis.action === 'instruction_behavior_candidate') {
      if (!diagnosis.instruction) {
        diagnosis = {
          action: 'needs_human_diagnosis',
          reasonCode: 'instruction_candidate_missing_instruction',
        };
      } else {
        try {
          const proposal = await suggestBehaviorInstructionImprovement({
            personaId: claimed.personaId,
            slotKey: claimed.behaviorSlotKey,
            rationale: 'Repeated semantic outcomes indicate a reusable instruction-only lesson.',
            instruction: diagnosis.instruction,
            evidenceRefs: claimed.sourceActivityIds.map((id) => ({ kind: 'activity', id })),
          });
          relatedProposalIds.push(proposal.id);
        } catch {
          diagnosis = {
            action: 'needs_human_diagnosis',
            reasonCode: 'instruction_candidate_draft_failed',
          };
        }
      }
    }

    const finishedAt = Math.max(options.now ?? Date.now(), claimed.updatedAt);
    const durationMs = Math.max(claimed.durationMs, finishedAt - startedAt);
    const completed = await recordBehaviorMaintenanceDiagnosis({
      runId: claimed.id,
      diagnosisLeaseId: claimed.diagnosisLeaseId,
      action: diagnosis.action,
      reasonCode: diagnosis.reasonCode,
      relatedProposalIds,
      durationMs,
      now: finishedAt,
    });
    await compactBehaviorMaintenanceRuns(claimed.personaId, finishedAt);
    return completed;
  } catch {
    return failBehaviorMaintenanceRun(claimed, options.now ?? Date.now());
  }
}

async function completeShadowOnlyRun(run: BehaviorMaintenanceRun, now: number): Promise<void> {
  await withPersonaRuntimeLock(run.personaId, async (lock) => {
    await lock.assertOwned();
    const current = await getBehaviorMaintenanceRun(run.id);
    if (!current || !ACTIVE_EXECUTION_STATES.has(current.state)) return;
    const completedAt = Math.max(now, current.updatedAt);
    await saveBehaviorMaintenanceRun(BehaviorMaintenanceRunSchema.parse({
      ...current,
      state: 'completed',
      diagnosisLeaseId: undefined,
      diagnosisLeaseExpiresAt: undefined,
      reasonCode: 'shadow_admission_only',
      updatedAt: completedAt,
      completedAt,
    }) as BehaviorMaintenanceRun);
  });
}

function compactionTimestamp(run: BehaviorMaintenanceRun): number {
  return run.completedAt ?? run.updatedAt;
}

/**
 * Compact private evidence pointers after 30 days and enforce a bounded number
 * of detailed compactable runs. Audit identity, hashes, decisions, proposals,
 * and counters remain durable.
 */
export async function compactBehaviorMaintenanceRuns(
  personaId: string,
  now = Date.now(),
): Promise<number> {
  return withPersonaRuntimeLock(personaId, async (lock) => {
    await lock.assertOwned();
    const compactable = (await listBehaviorMaintenanceRuns(personaId))
      .filter((run) => COMPACTION_ELIGIBLE_STATES.has(run.state))
      .sort((left, right) => (
        compactionTimestamp(right) - compactionTimestamp(left)
        || right.id.localeCompare(left.id)
      ));
    const detailed = compactable.filter((run) => run.compactedAt === undefined);
    const cutoff = now - BEHAVIOR_MAINTENANCE_RETENTION_MS;
    let compacted = 0;

    for (const [rank, run] of detailed.entries()) {
      const expired = compactionTimestamp(run) < cutoff;
      if (!expired && rank < BEHAVIOR_MAINTENANCE_DETAILED_RUN_LIMIT) continue;
      const compactedAt = Math.max(now, run.updatedAt);
      await saveBehaviorMaintenanceRun(BehaviorMaintenanceRunSchema.parse({
        ...run,
        sourceActivityIds: [],
        compactedAt,
        updatedAt: compactedAt,
      }) as BehaviorMaintenanceRun);
      compacted += 1;
    }
    return compacted;
  });
}

/**
 * Restart-safe worker entrypoint. Queued and expired diagnosing runs converge on
 * one fenced attempt; shadow-only records are terminalized and never block
 * future evidence windows.
 */
export async function reconcileBehaviorMaintenanceRuns(
  personaId?: string,
  now = Date.now(),
): Promise<void> {
  const runs = await listBehaviorMaintenanceRuns(personaId);
  const personas = new Set(runs.map((run) => run.personaId));

  for (const run of runs) {
    if (!ACTIVE_EXECUTION_STATES.has(run.state)) continue;
    if (!FEATURES.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_DIAGNOSIS) {
      await completeShadowOnlyRun(run, now);
      continue;
    }
    await executeBehaviorMaintenanceRun(run.id, { now });
  }

  for (const id of personas) {
    await compactBehaviorMaintenanceRuns(id, now);
  }
}
