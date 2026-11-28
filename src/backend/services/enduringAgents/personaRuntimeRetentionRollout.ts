/**
 * The hourly Persona history cleanup sweep (#453, #481), the only path that
 * writes cleaned-up records. Each workspace measures first; the rollout control
 * switches cleanup on once enough clean runs passed, and back to measuring on
 * any anomaly this sweep finds.
 */

import { createLogger } from '@/utils/logger';
import { getCurrentWorkspace } from '@/utils/workspace';

import { listBehaviorCallPins } from './behaviorCallPins';
import {
  getActivityRetentionPolicy,
  getBehaviorCallPinRetentionPolicy,
  getFlowDispatchRetentionPolicy,
  getMailboxItemRetentionPolicy,
} from './compactRuntime';
import { listPersonaFlowDispatchRecordsForRetention } from './personaFlowDispatchRetention';
import {
  acquirePersonaRuntimeRetentionWriteGrant,
  personaRuntimeRetentionVolumeBudget,
  readPersonaRuntimeRetentionState,
  recordPersonaRuntimeRetentionAnomaly,
  recordPersonaRuntimeRetentionSweep,
  type PersonaRuntimeRetentionAnomaly,
  type PersonaRuntimeRetentionMode,
  type PersonaRuntimeRetentionWriteGrant,
} from './personaRuntimeRetentionControl';
import { findPersonaRuntimeRecordsInUse } from './personaRuntimeRetentionReferences';
import {
  executeRetentionPlan,
  planRetention,
  type RetentionExecutionResult,
  type RetentionPlan,
  type RetentionPolicy,
} from './retention';
import { withPersonaRuntimeLock } from './runtimeLock';
import {
  listBehaviorMaintenanceRuns,
  listPersonaActivities,
  listPersonaMailboxItems,
  listPersonas,
} from './store';

const log = createLogger('enduringAgents/personaRuntimeRetentionRollout');
const MAX_PERSONA_CONCURRENCY = 2;
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

export interface PersonaRuntimeRetentionCollectionTotals {
  scanned: number;
  /** Records cleanup would rewrite, before the per-sweep write cap. */
  candidates: number;
  inUse: number;
  invalid: number;
  notSmaller: number;
  alreadyCompacted: number;
  overCap: number;
  selected: number;
  compacted: number;
  failed: number;
  stopped: number;
  bytesBefore: number;
  projectedBytesAfter: number;
}

export interface PersonaRuntimeRetentionSweepOptions {
  now?: number;
}

export interface PersonaRuntimeRetentionSweepResult {
  /** What the sweep did: `active` only when it started with cleanup on. */
  mode: PersonaRuntimeRetentionMode;
  /** The stored mode after this sweep. */
  modeAfter: PersonaRuntimeRetentionMode;
  startedAt: number;
  durationMs: number;
  personasExamined: number;
  personasFailed: number;
  anomalies: PersonaRuntimeRetentionAnomaly[];
  maxLockWaitMs: number;
  maxLockHeldMs: number;
  collections: Record<PersonaRuntimeRetentionCollection, PersonaRuntimeRetentionCollectionTotals>;
  /** True when the sweep did not run because another one is still running. */
  overlappingSweepSkipped: boolean;
  /** True when the stored state could not be read; nothing was written or recorded. */
  stateUnreadable: boolean;
}

const inFlightByWorkspace = new Map<string, {
  sweep: Promise<PersonaRuntimeRetentionSweepResult>;
  startedAt: number;
}>();

function emptyTotals(): PersonaRuntimeRetentionCollectionTotals {
  return {
    scanned: 0,
    candidates: 0,
    inUse: 0,
    invalid: 0,
    notSmaller: 0,
    alreadyCompacted: 0,
    overCap: 0,
    selected: 0,
    compacted: 0,
    failed: 0,
    stopped: 0,
    bytesBefore: 0,
    projectedBytesAfter: 0,
  };
}

function emptyResult(mode: PersonaRuntimeRetentionMode, startedAt: number): PersonaRuntimeRetentionSweepResult {
  return {
    mode,
    modeAfter: mode,
    startedAt,
    durationMs: 0,
    personasExamined: 0,
    personasFailed: 0,
    anomalies: [],
    maxLockWaitMs: 0,
    maxLockHeldMs: 0,
    collections: {
      mailboxItems: emptyTotals(),
      activities: emptyTotals(),
      flowDispatches: emptyTotals(),
      behaviorCallPins: emptyTotals(),
    },
    overlappingSweepSkipped: false,
    stateUnreadable: false,
  };
}

interface PlannedCollection {
  collection: PersonaRuntimeRetentionCollection;
  plan: RetentionPlan<{ id: string }>;
  execute: (grant: PersonaRuntimeRetentionWriteGrant | null) => Promise<RetentionExecutionResult>;
}

function planned<T extends { id: string }>(
  collection: PersonaRuntimeRetentionCollection,
  records: readonly T[],
  policy: RetentionPolicy<T>,
  now: number,
  inUse: ReadonlySet<string>,
): PlannedCollection {
  const plan = planRetention(records, policy, now, { isInUse: (record) => inUse.has(record.id) });
  return { collection, plan, execute: (grant) => executeRetentionPlan(plan, policy, { grant }) };
}

class Sweep {
  readonly result: PersonaRuntimeRetentionSweepResult;
  private readonly recorded = new Set<PersonaRuntimeRetentionAnomaly>();
  private candidatesSoFar = 0;

  constructor(
    mode: PersonaRuntimeRetentionMode,
    private readonly now: number,
    private readonly volumeBudget: number | null,
  ) {
    this.result = emptyResult(mode, now);
  }

  /**
   * Stored at once, so every later write in any sweep sees measuring only.
   * This sweep writes nothing more even when storing the anomaly fails.
   */
  async anomaly(kind: PersonaRuntimeRetentionAnomaly): Promise<void> {
    if (this.recorded.has(kind)) return;
    this.recorded.add(kind);
    this.result.anomalies.push(kind);
    try {
      await recordPersonaRuntimeRetentionAnomaly(kind, this.now);
    } catch (error) {
      log.warn('Persona history cleanup could not store an anomaly; this sweep stops writing.', error);
    }
  }

  async persona(personaId: string): Promise<void> {
    const waitStartedAt = Date.now();
    await withPersonaRuntimeLock(personaId, async (lock) => {
      const lockedAt = Date.now();
      const grant = this.result.mode === 'active'
        ? await acquirePersonaRuntimeRetentionWriteGrant(personaId, lock)
        : null;
      const [mailboxItems, activities, flowDispatches, behaviorCallPins, maintenanceRuns] =
        await Promise.all([
          listPersonaMailboxItems(personaId),
          listPersonaActivities(personaId),
          listPersonaFlowDispatchRecordsForRetention(personaId),
          listBehaviorCallPins(personaId),
          listBehaviorMaintenanceRuns(personaId),
        ]);
      const inUse = findPersonaRuntimeRecordsInUse({
        mailboxItems, activities, flowDispatches, behaviorCallPins, maintenanceRuns,
      });
      const collections = [
        planned('mailboxItems', mailboxItems, getMailboxItemRetentionPolicy(), this.now, inUse.mailboxItems),
        planned('activities', activities, getActivityRetentionPolicy(), this.now, inUse.activities),
        planned(
          'flowDispatches', flowDispatches, getFlowDispatchRetentionPolicy(), this.now, inUse.flowDispatches,
        ),
        planned(
          'behaviorCallPins',
          behaviorCallPins,
          getBehaviorCallPinRetentionPolicy(activities, lock),
          this.now,
          inUse.behaviorCallPins,
        ),
      ];

      const found: PersonaRuntimeRetentionAnomaly[] = [];
      if (collections.some(({ plan }) => plan.inUse > 0)) found.push('referenced');
      if (collections.some(({ plan }) => plan.invalid > 0)) found.push('invalid');
      this.candidatesSoFar += collections.reduce((total, { plan }) => total + plan.candidateCount, 0);
      if (this.volumeBudget !== null && this.candidatesSoFar > this.volumeBudget) found.push('volume');
      for (const kind of found) await this.anomaly(kind);

      const writeGrant = this.recorded.size === 0 ? grant : null;
      for (const entry of collections) await this.execute(entry, writeGrant);

      const heldMs = Date.now() - lockedAt;
      this.result.maxLockWaitMs = Math.max(this.result.maxLockWaitMs, lockedAt - waitStartedAt);
      this.result.maxLockHeldMs = Math.max(this.result.maxLockHeldMs, heldMs);
    });
  }

  private async execute(
    { collection, plan, execute }: PlannedCollection,
    grant: PersonaRuntimeRetentionWriteGrant | null,
  ): Promise<void> {
    const execution = await execute(grant);
    const totals = this.result.collections[collection];
    totals.scanned += plan.scanned;
    totals.candidates += plan.candidateCount;
    totals.inUse += plan.inUse;
    totals.invalid += plan.invalid;
    totals.notSmaller += plan.notSmaller;
    totals.alreadyCompacted += plan.alreadyCompacted;
    totals.overCap += plan.overCap;
    totals.selected += execution.selected;
    totals.compacted += execution.compacted;
    totals.failed += execution.failed;
    totals.stopped += execution.stopped;
    totals.bytesBefore += plan.bytesBefore;
    totals.projectedBytesAfter += plan.projectedBytesAfter;
    if (execution.failed > 0) {
      log.warn(`Persona history cleanup could not rewrite one ${collection} record.`);
      await this.anomaly('error');
    }
  }
}

async function runSweep(
  options: PersonaRuntimeRetentionSweepOptions,
): Promise<PersonaRuntimeRetentionSweepResult> {
  const now = options.now ?? Date.now();
  const startedAt = Date.now();
  const stored = await readPersonaRuntimeRetentionState();
  if (!stored.readable) {
    return { ...emptyResult('shadow', now), stateUnreadable: true };
  }
  const sweep = new Sweep(stored.state.mode, now, personaRuntimeRetentionVolumeBudget(stored.state));
  const { result } = sweep;

  try {
    const personas = await listPersonas();
    result.personasExamined = personas.length;
    let next = 0;
    await Promise.all(Array.from(
      { length: Math.min(MAX_PERSONA_CONCURRENCY, personas.length) },
      async () => {
        while (next < personas.length) {
          const persona = personas[next++];
          try {
            await sweep.persona(persona.id);
          } catch (error) {
            result.personasFailed += 1;
            log.warn(`Persona history cleanup could not check one Persona: ${
              error instanceof Error ? error.name : 'unknown error'
            }.`);
            await sweep.anomaly('error');
          }
        }
      },
    ));
  } catch (error) {
    log.warn('Persona history cleanup could not list the Personas.', error);
    await sweep.anomaly('error');
  }

  result.durationMs = Date.now() - startedAt;
  const totals = Object.values(result.collections);
  try {
    const after = await recordPersonaRuntimeRetentionSweep({
      at: now,
      mode: result.mode,
      personas: result.personasExamined,
      candidates: totals.reduce((total, collection) => total + collection.candidates, 0),
      compacted: totals.reduce((total, collection) => total + collection.compacted, 0),
      anomalies: result.anomalies,
    });
    result.modeAfter = after?.mode ?? 'shadow';
  } catch (error) {
    result.modeAfter = 'shadow';
    log.warn('Persona history cleanup could not store this sweep; it will count the next one.', error);
  }
  log.info(`Persona history cleanup sweep: ${JSON.stringify({
    mode: result.mode,
    modeAfter: result.modeAfter,
    personas: result.personasExamined,
    anomalies: result.anomalies,
    durationMs: result.durationMs,
    maxLockHeldMs: result.maxLockHeldMs,
  })}`);
  return result;
}

/**
 * Run one non-overlapping sweep for the current workspace, at most two
 * Personas at a time, each under its own runtime lock.
 */
export async function runPersonaRuntimeRetentionSweep(
  options: PersonaRuntimeRetentionSweepOptions = {},
): Promise<PersonaRuntimeRetentionSweepResult> {
  const workspaceId = getCurrentWorkspace();
  const running = inFlightByWorkspace.get(workspaceId);
  if (running) {
    if (Date.now() - running.startedAt < PERSONA_RUNTIME_RETENTION_STUCK_SWEEP_MS) {
      return { ...emptyResult('shadow', options.now ?? Date.now()), overlappingSweepSkipped: true };
    }
    log.warn('A Persona history cleanup sweep looks stuck; starting a fresh one.');
  }

  const startedAt = Date.now();
  const sweep = runSweep(options).finally(() => {
    if (inFlightByWorkspace.get(workspaceId)?.sweep === sweep) {
      inFlightByWorkspace.delete(workspaceId);
    }
  });
  inFlightByWorkspace.set(workspaceId, { sweep, startedAt });
  return sweep;
}
