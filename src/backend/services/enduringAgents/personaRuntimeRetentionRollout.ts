import { randomUUID } from 'crypto';

import {
  FEATURES,
  PERSONA_RUNTIME_RETENTION_DEFAULT_CONFIG,
  readPersonaRuntimeRetentionConfig,
  validatePersonaRuntimeRetentionConfig,
  type PersonaRuntimeRetentionConfig,
  type PersonaRuntimeRetentionMode,
} from '@/config/features';
import { createLogger } from '@/utils/logger';
import { getCurrentWorkspace } from '@/utils/workspace';

import {
  getActivityRetentionPolicy,
  getFlowDispatchRetentionPolicy,
  getMailboxItemRetentionPolicy,
} from './compactRuntime';
import {
  getPersonaRetentionEligibility,
  type PersonaRetentionEligibilityReason,
} from './personaRuntimeRetentionCohort';
import { listPersonaFlowDispatchRecordsForRetention } from './personaFlowDispatchRetention';
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

export type PersonaRuntimeRetentionCollection =
  | 'mailboxItems'
  | 'activities'
  | 'flowDispatches';

export interface PersonaRuntimeRetentionCollectionObservation
  extends RetentionExecutionResult {
  collection: PersonaRuntimeRetentionCollection;
  scanned: number;
  candidateCount: number;
  actualBytesBefore: number;
  actualBytesAfter: number;
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
  collections: PersonaRuntimeRetentionCollectionObservation[];
}

export interface PersonaRuntimeRetentionSweepOptions {
  now?: number;
  config?: PersonaRuntimeRetentionConfig;
  maxPersonaConcurrency?: number;
}

export interface PersonaRuntimeRetentionSweepResult {
  sweepId: string;
  mode: PersonaRuntimeRetentionMode;
  cohortVersion: string;
  rolloutBasisPoints: number;
  personasExamined: number;
  personasSelected: number;
  personasSkipped: number;
  personasFailed: number;
  collections: Record<PersonaRuntimeRetentionCollection, RetentionExecutionResult>;
  observations: PersonaRuntimeRetentionObservation[];
  durationMs: number;
  overlappingSweepSkipped: boolean;
}

const inFlightByWorkspace = new Map<
  string,
  Promise<PersonaRuntimeRetentionSweepResult>
>();

function emptyExecutionResult(): RetentionExecutionResult {
  return {
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
  config: PersonaRuntimeRetentionConfig,
  overlappingSweepSkipped = false,
): PersonaRuntimeRetentionSweepResult {
  return {
    sweepId: randomUUID(),
    mode: config.mode,
    cohortVersion: config.cohortVersion,
    rolloutBasisPoints: config.rolloutBasisPoints,
    personasExamined: 0,
    personasSelected: 0,
    personasSkipped: 0,
    personasFailed: 0,
    collections: {
      mailboxItems: emptyExecutionResult(),
      activities: emptyExecutionResult(),
      flowDispatches: emptyExecutionResult(),
    },
    observations: [],
    durationMs: 0,
    overlappingSweepSkipped,
  };
}

function resolveConfig(
  options: PersonaRuntimeRetentionSweepOptions,
): PersonaRuntimeRetentionConfig {
  if (!options.config) return readPersonaRuntimeRetentionConfig();
  return validatePersonaRuntimeRetentionConfig(options.config)
    ?? { ...PERSONA_RUNTIME_RETENTION_DEFAULT_CONFIG };
}

function mergeExecutionResult(
  target: RetentionExecutionResult,
  source: RetentionExecutionResult,
): void {
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
  mode: PersonaRuntimeRetentionMode;
  actualBytesBefore: number;
  authorizeWrite: () => Promise<boolean>;
}): Promise<PersonaRuntimeRetentionCollectionObservation> {
  const plan = planRetention(input.records, input.policy, input.now);
  const execution = await executeRetentionPlan(plan, input.policy, {
    shadow: input.mode === 'shadow',
    authorizeWrite: async () => input.authorizeWrite(),
    continueOnFailure: true,
    onWriteFailure: () => {
      log.warn('Persona runtime retention write failed closed for one record.');
    },
  });
  return {
    collection: input.collection,
    scanned: plan.scanned,
    candidateCount: plan.candidateCount,
    actualBytesBefore: input.actualBytesBefore,
    actualBytesAfter: input.actualBytesBefore,
    ...execution,
  };
}

function isSweepEnabled(config: PersonaRuntimeRetentionConfig): boolean {
  return FEATURES.ENABLE_PERSONA_RUNTIME_RETENTION
    && config.mode !== 'disabled'
    && config.rolloutBasisPoints > 0;
}

async function runSweep(
  workspaceId: string,
  options: PersonaRuntimeRetentionSweepOptions,
  initialConfig: PersonaRuntimeRetentionConfig,
): Promise<PersonaRuntimeRetentionSweepResult> {
  const startedAt = Date.now();
  const now = options.now ?? startedAt;
  const result = emptySweepResult(initialConfig);
  const personas = await listPersonas();
  result.personasExamined = personas.length;

  const selected = personas.flatMap((persona) => {
    const eligibility = getPersonaRetentionEligibility({
      workspaceId,
      personaId: persona.id,
      cohortVersion: initialConfig.cohortVersion,
      rolloutBasisPoints: initialConfig.rolloutBasisPoints,
      criticalPersonaIds: initialConfig.criticalPersonaIds,
    });
    if (!eligibility.eligible) return [];
    return [{ persona, eligibility }];
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
        const personaStartedAt = Date.now();
        try {
          const observation = await withPersonaRuntimeLock(
            current.persona.id,
            async (lock) => {
              const lockedConfig = resolveConfig(options);
              if (!isSweepEnabled(lockedConfig)) return null;
              const lockedEligibility = getPersonaRetentionEligibility({
                workspaceId,
                personaId: current.persona.id,
                cohortVersion: lockedConfig.cohortVersion,
                rolloutBasisPoints: lockedConfig.rolloutBasisPoints,
                criticalPersonaIds: lockedConfig.criticalPersonaIds,
              });
              if (!lockedEligibility.eligible) return null;
              await lock.assertOwned();

              const [mailboxItems, activities, flowDispatches, before] =
                await Promise.all([
                  listPersonaMailboxItems(current.persona.id),
                  listPersonaActivities(current.persona.id),
                  listPersonaFlowDispatchRecordsForRetention(current.persona.id),
                  getPersonaStorageStats(current.persona.id),
                ]);

              const authorizeWrite = async (): Promise<boolean> => {
                await lock.assertOwned();
                const liveConfig = resolveConfig(options);
                if (
                  !FEATURES.ENABLE_PERSONA_RUNTIME_RETENTION
                  || liveConfig.mode !== 'active'
                  || liveConfig.cohortVersion !== initialConfig.cohortVersion
                ) {
                  return false;
                }
                return getPersonaRetentionEligibility({
                  workspaceId,
                  personaId: current.persona.id,
                  cohortVersion: liveConfig.cohortVersion,
                  rolloutBasisPoints: liveConfig.rolloutBasisPoints,
                  criticalPersonaIds: liveConfig.criticalPersonaIds,
                }).eligible;
              };

              const collections = [
                await processCollection({
                  collection: 'mailboxItems',
                  records: mailboxItems,
                  policy: getMailboxItemRetentionPolicy(),
                  now,
                  mode: initialConfig.mode,
                  actualBytesBefore: storageBytes(before, 'mailboxItems'),
                  authorizeWrite,
                }),
                await processCollection({
                  collection: 'activities',
                  records: activities,
                  policy: getActivityRetentionPolicy(),
                  now,
                  mode: initialConfig.mode,
                  actualBytesBefore: storageBytes(before, 'activities'),
                  authorizeWrite,
                }),
                await processCollection({
                  collection: 'flowDispatches',
                  records: flowDispatches,
                  policy: getFlowDispatchRetentionPolicy(),
                  now,
                  mode: initialConfig.mode,
                  actualBytesBefore: storageBytes(before, 'flowDispatches'),
                  authorizeWrite,
                }),
              ];

              if (initialConfig.mode === 'active') {
                const after = await getPersonaStorageStats(current.persona.id);
                for (const collection of collections) {
                  collection.actualBytesAfter = storageBytes(after, collection.collection);
                }
              }

              return {
                sweepId: result.sweepId,
                personaId: current.persona.id,
                mode: initialConfig.mode,
                cohortVersion: current.eligibility.cohort.version,
                cohortBucket: current.eligibility.cohort.bucket,
                rolloutBasisPoints: initialConfig.rolloutBasisPoints,
                eligibilityReason: current.eligibility.reason,
                durationMs: Date.now() - personaStartedAt,
                collections,
              } satisfies PersonaRuntimeRetentionObservation;
            },
          );

          if (!observation) {
            result.personasSkipped += 1;
            result.personasSelected -= 1;
            continue;
          }
          result.observations.push(observation);
          for (const collection of observation.collections) {
            mergeExecutionResult(
              result.collections[collection.collection],
              collection,
            );
          }
        } catch {
          result.personasFailed += 1;
          log.warn('Persona runtime retention failed closed for one Persona.');
        }
      }
    },
  );
  await Promise.all(workers);
  result.durationMs = Date.now() - startedAt;

  if (
    result.personasFailed > 0
    || Object.values(result.collections).some((collection) =>
      collection.compacted > 0 || collection.failed > 0
    )
  ) {
    log.info(`Persona runtime retention summary: ${JSON.stringify({
      sweepId: result.sweepId,
      mode: result.mode,
      rolloutBasisPoints: result.rolloutBasisPoints,
      personasExamined: result.personasExamined,
      personasSelected: result.personasSelected,
      personasFailed: result.personasFailed,
      durationMs: result.durationMs,
      collections: result.collections,
    })}`);
  }
  return result;
}

/**
 * Run one non-overlapping, bounded-concurrency retention sweep for the current
 * workspace. Disabled configuration returns before any Persona/storage read.
 */
export function runPersonaRuntimeRetentionSweep(
  options: PersonaRuntimeRetentionSweepOptions = {},
): Promise<PersonaRuntimeRetentionSweepResult> {
  const config = resolveConfig(options);
  if (!isSweepEnabled(config)) {
    return Promise.resolve(emptySweepResult(config));
  }

  const workspaceId = getCurrentWorkspace();
  if (inFlightByWorkspace.has(workspaceId)) {
    return Promise.resolve(emptySweepResult(config, true));
  }

  const sweep = runSweep(workspaceId, options, config).finally(() => {
    if (inFlightByWorkspace.get(workspaceId) === sweep) {
      inFlightByWorkspace.delete(workspaceId);
    }
  });
  inFlightByWorkspace.set(workspaceId, sweep);
  return sweep;
}
