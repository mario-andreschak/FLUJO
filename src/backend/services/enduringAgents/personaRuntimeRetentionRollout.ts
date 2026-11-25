import { randomUUID } from 'crypto';

import type { PersonaRuntimeRetentionMode } from '@/config/features';
import { createLogger } from '@/utils/logger';
import { getCurrentWorkspace } from '@/utils/workspace';

import {
  getActivityRetentionPolicy,
  getBehaviorCallPinRetentionPolicy,
  getFlowDispatchRetentionPolicy,
  getMailboxItemRetentionPolicy,
} from './compactRuntime';
import { listBehaviorCallPins } from './behaviorCallPins';
import type { PersonaRetentionEligibilityReason } from './personaRuntimeRetentionCohort';
import {
  acquirePersonaRuntimeRetentionWriteGrant,
  decidePersonaRuntimeRetention,
  getPersonaRuntimeRetentionControl,
  getPersonaRuntimeRetentionDecision,
  type PersonaRuntimeRetentionControl,
  type PersonaRuntimeRetentionControlOptions,
  type PersonaRuntimeRetentionModeSource,
} from './personaRuntimeRetentionControl';
import { listPersonaFlowDispatchRecordsForRetention } from './personaFlowDispatchRetention';
import { recordPersonaRuntimeRetentionSweep } from './personaRuntimeRetentionReports';
import {
  executeRetentionPlan,
  planRetention,
  type RetentionExecutionResult,
  type RetentionPolicy,
} from './retention';
import { withPersonaRuntimeLock } from './runtimeLock';
import { getPersonaStorageStats, type PersonaStorageStats } from './runtimeStorageStats';
import {
  listPersonaActivities,
  listPersonaMailboxItems,
  listPersonas,
} from './store';

const log = createLogger('enduringAgents/personaRuntimeRetentionRollout');
const DEFAULT_MAX_PERSONA_CONCURRENCY = 2;
const MAX_PERSONA_CONCURRENCY = 8;
/**
 * A sweep still running after two hourly intervals is treated as stuck: the
 * next trigger starts a fresh one. Writes stay serialized by the Persona lock.
 */
export const PERSONA_RUNTIME_RETENTION_STUCK_SWEEP_MS = 2 * 60 * 60 * 1_000;

export type PersonaRuntimeRetentionCollection =
  | 'mailboxItems'
  | 'activities'
  | 'flowDispatches'
  | 'behaviorCallPins';

export interface PersonaRuntimeRetentionCollectionTotals extends RetentionExecutionResult {
  scanned: number;
  candidateCount: number;
}

export interface PersonaRuntimeRetentionCollectionObservation
  extends PersonaRuntimeRetentionCollectionTotals {
  collection: PersonaRuntimeRetentionCollection;
  /** Measured persisted size. Only active mode measures it, because only it can change. */
  actualBytesBefore?: number;
  actualBytesAfter?: number;
}

export interface PersonaRuntimeRetentionObservation {
  sweepId: string;
  personaId: string;
  mode: PersonaRuntimeRetentionMode;
  cohortVersion: string;
  cohortBucket: number;
  rolloutBasisPoints: number;
  eligibilityReason: PersonaRetentionEligibilityReason;
  durationMs: number;
  /** Time spent waiting for this Persona's runtime lock. */
  lockWaitMs: number;
  /** Time this sweep held this Persona's runtime lock. */
  lockHeldMs: number;
  collections: PersonaRuntimeRetentionCollectionObservation[];
}

export interface PersonaRuntimeRetentionSweepOptions extends PersonaRuntimeRetentionControlOptions {
  now?: number;
  maxPersonaConcurrency?: number;
}

export interface PersonaRuntimeRetentionSweepResult {
  sweepId: string;
  mode: PersonaRuntimeRetentionMode;
  modeSource: PersonaRuntimeRetentionModeSource;
  cohortVersion: string;
  rolloutBasisPoints: number;
  startedAt: number;
  personasExamined: number;
  personasSelected: number;
  personasSkipped: number;
  personasFailed: number;
  maxLockWaitMs: number;
  maxLockHeldMs: number;
  collections: Record<PersonaRuntimeRetentionCollection, PersonaRuntimeRetentionCollectionTotals>;
  observations: PersonaRuntimeRetentionObservation[];
  durationMs: number;
  overlappingSweepSkipped: boolean;
}

const inFlightByWorkspace = new Map<string, {
  sweep: Promise<PersonaRuntimeRetentionSweepResult>;
  startedAt: number;
}>();

const MODE_RANK: Record<PersonaRuntimeRetentionMode, number> = {
  disabled: 0,
  shadow: 1,
  active: 2,
};

function emptyCollectionTotals(): PersonaRuntimeRetentionCollectionTotals {
  return {
    scanned: 0,
    candidateCount: 0,
    selected: 0,
    compacted: 0,
    alreadyCompacted: 0,
    skipped: 0,
    failed: 0,
    unauthorized: 0,
    remaining: 0,
    bytesBefore: 0,
    projectedBytesAfter: 0,
  };
}

function emptySweepResult(
  control: PersonaRuntimeRetentionControl,
  overlappingSweepSkipped = false,
): PersonaRuntimeRetentionSweepResult {
  return {
    sweepId: randomUUID(),
    mode: control.config.mode,
    modeSource: control.source,
    cohortVersion: control.config.cohortVersion,
    rolloutBasisPoints: control.config.rolloutBasisPoints,
    startedAt: Date.now(),
    personasExamined: 0,
    personasSelected: 0,
    personasSkipped: 0,
    personasFailed: 0,
    maxLockWaitMs: 0,
    maxLockHeldMs: 0,
    collections: {
      mailboxItems: emptyCollectionTotals(),
      activities: emptyCollectionTotals(),
      flowDispatches: emptyCollectionTotals(),
      behaviorCallPins: emptyCollectionTotals(),
    },
    observations: [],
    durationMs: 0,
    overlappingSweepSkipped,
  };
}

function mergeCollectionTotals(
  target: PersonaRuntimeRetentionCollectionTotals,
  source: PersonaRuntimeRetentionCollectionTotals,
): void {
  target.scanned += source.scanned;
  target.candidateCount += source.candidateCount;
  target.selected += source.selected;
  target.compacted += source.compacted;
  target.alreadyCompacted += source.alreadyCompacted;
  target.skipped += source.skipped;
  target.failed += source.failed;
  target.unauthorized += source.unauthorized;
  target.remaining += source.remaining;
  target.bytesBefore += source.bytesBefore;
  target.projectedBytesAfter += source.projectedBytesAfter;
}

function storageBytes(
  stats: PersonaStorageStats,
  collection: PersonaRuntimeRetentionCollection,
): number {
  return stats.kinds[collection].approxBytes;
}

async function processCollection<T extends { id: string }>(input: {
  collection: PersonaRuntimeRetentionCollection;
  records: readonly T[];
  policy: RetentionPolicy<T>;
  now: number;
  authorizeWrite: (() => Promise<boolean>) | null;
  actualBytesBefore?: number;
}): Promise<PersonaRuntimeRetentionCollectionObservation> {
  const plan = planRetention(input.records, input.policy, input.now);
  const authorizeWrite = input.authorizeWrite;
  const execution = await executeRetentionPlan(plan, input.policy, {
    shadow: authorizeWrite === null,
    ...(authorizeWrite ? { authorizeWrite: () => authorizeWrite() } : {}),
    continueOnFailure: true,
    onWriteFailure: () => {
      log.warn(`Persona runtime retention could not compact one ${input.collection} record.`);
    },
  });
  return {
    collection: input.collection,
    scanned: plan.scanned,
    candidateCount: plan.candidateCount,
    ...(input.actualBytesBefore === undefined
      ? {}
      : { actualBytesBefore: input.actualBytesBefore, actualBytesAfter: input.actualBytesBefore }),
    ...execution,
  };
}

function isSweepEnabled(control: PersonaRuntimeRetentionControl): boolean {
  return control.config.mode !== 'disabled' && control.config.rolloutBasisPoints > 0;
}

function summary(result: PersonaRuntimeRetentionSweepResult): string {
  const totals = Object.values(result.collections).reduce((sum, collection) => ({
    candidates: sum.candidates + collection.candidateCount,
    compacted: sum.compacted + collection.compacted,
    failed: sum.failed + collection.failed,
    bytesBefore: sum.bytesBefore + collection.bytesBefore,
    projectedBytesAfter: sum.projectedBytesAfter + collection.projectedBytesAfter,
  }), { candidates: 0, compacted: 0, failed: 0, bytesBefore: 0, projectedBytesAfter: 0 });
  return JSON.stringify({
    sweepId: result.sweepId,
    mode: result.mode,
    modeSource: result.modeSource,
    personasExamined: result.personasExamined,
    personasSelected: result.personasSelected,
    personasFailed: result.personasFailed,
    durationMs: result.durationMs,
    maxLockHeldMs: result.maxLockHeldMs,
    ...totals,
  });
}

async function runSweep(
  workspaceId: string,
  options: PersonaRuntimeRetentionSweepOptions,
  initial: PersonaRuntimeRetentionControl,
): Promise<PersonaRuntimeRetentionSweepResult> {
  const result = emptySweepResult(initial);
  const startedAt = result.startedAt;
  const now = options.now ?? startedAt;
  const personas = await listPersonas();
  result.personasExamined = personas.length;

  const selected = personas.flatMap((persona) => {
    const decision = decidePersonaRuntimeRetention(initial, workspaceId, persona.id);
    if (decision.mode === 'disabled' || !decision.eligibility) return [];
    return [{ persona, eligibility: decision.eligibility }];
  });
  result.personasSelected = selected.length;
  result.personasSkipped = personas.length - selected.length;

  const requestedConcurrency = options.maxPersonaConcurrency
    ?? DEFAULT_MAX_PERSONA_CONCURRENCY;
  if (
    !Number.isSafeInteger(requestedConcurrency)
    || requestedConcurrency < 1
    || requestedConcurrency > MAX_PERSONA_CONCURRENCY
  ) {
    throw new Error(
      `maxPersonaConcurrency must be an integer from 1 through ${MAX_PERSONA_CONCURRENCY}.`,
    );
  }

  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(requestedConcurrency, selected.length) },
    async () => {
      while (nextIndex < selected.length) {
        const current = selected[nextIndex++];
        const personaId = current.persona.id;
        const personaStartedAt = Date.now();
        try {
          const observation = await withPersonaRuntimeLock(personaId, async (lock) => {
            const lockAcquiredAt = Date.now();
            const live = await getPersonaRuntimeRetentionDecision(personaId, options);
            const mode = MODE_RANK[live.mode] < MODE_RANK[initial.config.mode]
              ? live.mode
              : initial.config.mode;
            if (
              mode === 'disabled'
              || live.control.config.cohortVersion !== initial.config.cohortVersion
            ) {
              return null;
            }
            const grant = mode === 'active'
              ? await acquirePersonaRuntimeRetentionWriteGrant(personaId, lock, {
                ...options,
                cohortVersion: initial.config.cohortVersion,
              })
              : null;
            if (mode === 'active' && !grant) return null;
            const authorizeWrite = grant ? () => grant.authorize() : null;

            const [mailboxItems, activities, flowDispatches, behaviorCallPins, before] =
              await Promise.all([
                listPersonaMailboxItems(personaId),
                listPersonaActivities(personaId),
                listPersonaFlowDispatchRecordsForRetention(personaId),
                listBehaviorCallPins(personaId),
                grant ? getPersonaStorageStats(personaId) : Promise.resolve(null),
              ]);
            const measured = (collection: PersonaRuntimeRetentionCollection) => (
              before ? storageBytes(before, collection) : undefined
            );

            const collections = [
              await processCollection({
                collection: 'mailboxItems',
                records: mailboxItems,
                policy: getMailboxItemRetentionPolicy(),
                now,
                authorizeWrite,
                actualBytesBefore: measured('mailboxItems'),
              }),
              await processCollection({
                collection: 'activities',
                records: activities,
                policy: getActivityRetentionPolicy(),
                now,
                authorizeWrite,
                actualBytesBefore: measured('activities'),
              }),
              await processCollection({
                collection: 'flowDispatches',
                records: flowDispatches,
                policy: getFlowDispatchRetentionPolicy(),
                now,
                authorizeWrite,
                actualBytesBefore: measured('flowDispatches'),
              }),
              await processCollection({
                collection: 'behaviorCallPins',
                records: behaviorCallPins,
                policy: getBehaviorCallPinRetentionPolicy(activities, lock),
                now,
                authorizeWrite,
                actualBytesBefore: measured('behaviorCallPins'),
              }),
            ];

            if (grant) {
              const after = await getPersonaStorageStats(personaId);
              for (const collection of collections) {
                collection.actualBytesAfter = storageBytes(after, collection.collection);
              }
            }

            const finishedAt = Date.now();
            return {
              sweepId: result.sweepId,
              personaId,
              mode,
              cohortVersion: current.eligibility.cohort.version,
              cohortBucket: current.eligibility.cohort.bucket,
              rolloutBasisPoints: initial.config.rolloutBasisPoints,
              eligibilityReason: current.eligibility.reason,
              durationMs: finishedAt - personaStartedAt,
              lockWaitMs: lockAcquiredAt - personaStartedAt,
              lockHeldMs: finishedAt - lockAcquiredAt,
              collections,
            } satisfies PersonaRuntimeRetentionObservation;
          });

          if (!observation) {
            result.personasSkipped += 1;
            result.personasSelected -= 1;
            continue;
          }
          result.observations.push(observation);
          result.maxLockWaitMs = Math.max(result.maxLockWaitMs, observation.lockWaitMs);
          result.maxLockHeldMs = Math.max(result.maxLockHeldMs, observation.lockHeldMs);
          for (const collection of observation.collections) {
            mergeCollectionTotals(result.collections[collection.collection], collection);
          }
        } catch (error) {
          result.personasFailed += 1;
          log.warn(
            `Persona runtime retention failed closed for one Persona: ${
              error instanceof Error ? error.name : 'unknown error'
            }.`,
          );
        }
      }
    },
  );
  await Promise.all(workers);
  result.durationMs = Date.now() - startedAt;

  const failed = result.personasFailed > 0
    || Object.values(result.collections).some((collection) => collection.failed > 0);
  const line = `Persona runtime retention sweep: ${summary(result)}`;
  if (failed) log.warn(line);
  else log.info(line);
  try {
    await recordPersonaRuntimeRetentionSweep(result);
  } catch (error) {
    log.warn('Could not store the Persona runtime retention sweep report.', error);
  }
  return result;
}

/**
 * Run one non-overlapping, bounded-concurrency retention sweep for the current
 * workspace. Disabled configuration returns before any Persona/storage read.
 */
export async function runPersonaRuntimeRetentionSweep(
  options: PersonaRuntimeRetentionSweepOptions = {},
): Promise<PersonaRuntimeRetentionSweepResult> {
  const control = await getPersonaRuntimeRetentionControl(options);
  if (!isSweepEnabled(control)) return emptySweepResult(control);

  const workspaceId = getCurrentWorkspace();
  const running = inFlightByWorkspace.get(workspaceId);
  if (running) {
    if (Date.now() - running.startedAt < PERSONA_RUNTIME_RETENTION_STUCK_SWEEP_MS) {
      return emptySweepResult(control, true);
    }
    log.warn('A Persona runtime retention sweep looks stuck; starting a fresh one.');
  }

  const startedAt = Date.now();
  const sweep = runSweep(workspaceId, options, control).finally(() => {
    if (inFlightByWorkspace.get(workspaceId)?.sweep === sweep) {
      inFlightByWorkspace.delete(workspaceId);
    }
  });
  inFlightByWorkspace.set(workspaceId, { sweep, startedAt });
  return sweep;
}
