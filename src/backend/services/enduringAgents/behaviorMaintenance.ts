import { createHash } from 'crypto';

import { FEATURES } from '@/config/features';
import {
  BEHAVIOR_MAINTENANCE_RUN_SCHEMA_VERSION,
  BehaviorMaintenanceRunSchema,
  type BehaviorMaintenanceAction,
  type BehaviorMaintenanceRun,
  type PersonaActivity,
} from '@/shared/types/enduringAgent';
import { getCurrentWorkspace } from '@/utils/workspace';

import { canonicalJson } from './behaviorRevisions';
import { stableEnduringAgentId } from './ids';
import {
  getBehaviorMaintenanceRun,
  getBehaviorRevision,
  getPersona,
  listBehaviorMaintenanceRuns,
  listPersonaActivities,
  saveBehaviorMaintenanceRun,
} from './store';

export const BEHAVIOR_MAINTENANCE_DETECTOR_VERSION = 'activity-outcome-v1';
export const BEHAVIOR_MAINTENANCE_POLICY_VERSION = 'shadow-manual-v1';
export const BEHAVIOR_MAINTENANCE_EVALUATION_SUITE_VERSION = 'instruction-only-v1';
const ELIGIBLE_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_SOURCE_ACTIVITIES = 20;

const ACTIVE_STATES = new Set<BehaviorMaintenanceRun['state']>([
  'queued',
  'collecting',
  'diagnosing',
  'drafting',
  'evaluating',
  'awaiting_review',
]);

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function isEligibleTerminalActivity(activity: PersonaActivity, now: number): boolean {
  return activity.kind !== 'maintenance'
    && activity.completedAt !== undefined
    && activity.completedAt >= now - ELIGIBLE_WINDOW_MS
    && (
      activity.status === 'completed'
      || activity.status === 'cancelled'
      || activity.status === 'error'
    );
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
}> {
  const activities = (await listPersonaActivities(personaId))
    .filter((activity) => isEligibleTerminalActivity(activity, now))
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
  };
}

/**
 * Admit at most one active, low-priority logical assessment per Persona.
 * Default-off rollout flags make disabled mode a true no-write path.
 */
export async function admitBehaviorMaintenanceRun(
  sourceActivity: PersonaActivity,
  now = Date.now(),
): Promise<BehaviorMaintenanceRun | null> {
  if (!FEATURES.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_ADMISSION) return null;
  if (!isEligibleTerminalActivity(sourceActivity, now)) return null;

  const persona = await getPersona(sourceActivity.personaId);
  if (!persona || persona.autonomyLevel === 'locked') return null;

  const existingActive = (await listBehaviorMaintenanceRuns(sourceActivity.personaId))
    .filter((run) => ACTIVE_STATES.has(run.state))
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
  if (existingActive) return existingActive;

  const revisionId = sourceActivity.behaviorRevisionId;
  if (!revisionId) return null;
  const revision = await getBehaviorRevision(revisionId);
  if (!revision || revision.personaId !== sourceActivity.personaId) return null;

  const window = await collectBehaviorMaintenanceEvidenceWindow(sourceActivity.personaId, now);
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
    behaviorSlotKey: revision.slotKey,
    baseRevisionId: revision.id,
    baseContentHash: revision.contentHash,
    detectorVersion: BEHAVIOR_MAINTENANCE_DETECTOR_VERSION,
    policyVersion: BEHAVIOR_MAINTENANCE_POLICY_VERSION,
    evaluationSuiteVersion: BEHAVIOR_MAINTENANCE_EVALUATION_SUITE_VERSION,
    state: 'queued',
    reasonCode: FEATURES.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_DIAGNOSIS
      ? 'diagnosis_pending'
      : 'shadow_admission_only',
    evidenceTrust: window.evidenceTrust,
    relatedProposalIds: [],
    attempts: 0,
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    createdAt: now,
    updatedAt: now,
  }) as BehaviorMaintenanceRun);
}

/**
 * Persist a closed diagnosis discriminator. This function deliberately cannot
 * activate Behavior or change the source Activity/WorkItem.
 */
export async function recordBehaviorMaintenanceDiagnosis(input: {
  runId: string;
  action: BehaviorMaintenanceAction;
  reasonCode: string;
  relatedProposalIds?: string[];
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
  const run = await getBehaviorMaintenanceRun(input.runId);
  if (!run) throw new Error(`BehaviorMaintenanceRun ${JSON.stringify(input.runId)} was not found.`);
  if (!ACTIVE_STATES.has(run.state)) return run;
  const now = Math.max(input.now ?? Date.now(), run.updatedAt);
  return saveBehaviorMaintenanceRun(BehaviorMaintenanceRunSchema.parse({
    ...run,
    state: input.action === 'instruction_behavior_candidate'
      ? 'awaiting_review'
      : 'completed',
    action: input.action,
    reasonCode: input.reasonCode,
    relatedProposalIds: input.relatedProposalIds ?? run.relatedProposalIds,
    attempts: input.attempts ?? run.attempts,
    modelCalls: input.modelCalls ?? run.modelCalls,
    inputTokens: input.inputTokens ?? run.inputTokens,
    outputTokens: input.outputTokens ?? run.outputTokens,
    durationMs: input.durationMs ?? run.durationMs,
    updatedAt: now,
    ...(input.action === 'instruction_behavior_candidate' ? {} : { completedAt: now }),
  }) as BehaviorMaintenanceRun);
}
