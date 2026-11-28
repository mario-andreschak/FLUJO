import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

import {
  PersonaMailboxConflictError,
  claimNextPersonaActivity,
  completePersonaActivity,
  enqueuePersonaMailboxItem,
} from '@/backend/services/enduringAgents/activityRuntime';
import * as compactRuntime from '@/backend/services/enduringAgents/compactRuntime';
import {
  PERSONA_RUNTIME_RETENTION_GRADUATION,
  readPersonaRuntimeRetentionState,
  recordPersonaRuntimeRetentionAnomaly,
  type PersonaRuntimeRetentionAnomaly,
} from '@/backend/services/enduringAgents/personaRuntimeRetentionControl';
import {
  PERSONA_RUNTIME_RETENTION_STUCK_SWEEP_MS,
  runPersonaRuntimeRetentionSweep,
} from '@/backend/services/enduringAgents/personaRuntimeRetentionRollout';
import { getPersonaStorageStats } from '@/backend/services/enduringAgents/runtimeStorageStats';
import * as personaStore from '@/backend/services/enduringAgents/store';
import { PERSONA_ACTIVITY_SCHEMA_VERSION } from '@/shared/types/enduringAgent';
import { StorageKey } from '@/shared/types/storage/storage';
import { loadItem } from '@/utils/storage/backend';
import { getWorkspaceDataDir, runWithWorkspace } from '@/utils/workspace';

import { createPersonaFromRole } from './fixtures/personaFactory';
import { storeRetentionState } from './fixtures/retentionState';

jest.mock('@/backend/services/enduringAgents/store', () => {
  const actual = jest.requireActual<typeof import('@/backend/services/enduringAgents/store')>(
    '@/backend/services/enduringAgents/store',
  );
  return {
    ...actual,
    listPersonas: jest.fn(actual.listPersonas),
    listPersonaActivities: jest.fn(actual.listPersonaActivities),
    savePersonaActivity: jest.fn(actual.savePersonaActivity),
    savePersonaMailboxItem: jest.fn(actual.savePersonaMailboxItem),
  };
});

jest.mock('@/utils/storage/backend', () => {
  const actual = jest.requireActual<typeof import('@/utils/storage/backend')>('@/utils/storage/backend');
  return { ...actual, loadItem: jest.fn(actual.loadItem) };
});

jest.mock('@/backend/services/enduringAgents/compactRuntime', () => {
  const actual = jest.requireActual<typeof import('@/backend/services/enduringAgents/compactRuntime')>(
    '@/backend/services/enduringAgents/compactRuntime',
  );
  return { ...actual, getActivityRetentionPolicy: jest.fn(actual.getActivityRetentionPolicy) };
});

jest.setTimeout(120_000);

const actualStore = jest.requireActual<typeof import('@/backend/services/enduringAgents/store')>(
  '@/backend/services/enduringAgents/store',
);
const actualCompactRuntime = jest.requireActual<
  typeof import('@/backend/services/enduringAgents/compactRuntime')
>('@/backend/services/enduringAgents/compactRuntime');
const actualLoadItem = jest.requireActual<typeof import('@/utils/storage/backend')>(
  '@/utils/storage/backend',
).loadItem;
const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;

let sequence = 0;
const fresh = <T>(task: () => Promise<T>) => runWithWorkspace(
  `retention-sweep-${process.pid}-${++sequence}`,
  task,
);

/** Long enough that removing it makes the stored item smaller. */
const summaryFor = (index: number) => `Private summary ${index}: ${'detail of the request '.repeat(12).trim()}`;
/** The link to a dispatch outcome that a finished Activity keeps until cleanup. */
const outcomeRefFor = (index: number) => `dispatch_outcome_${String(index).padStart(36, '0')}`;

async function finishWork(personaId: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await enqueuePersonaMailboxItem({
      personaId,
      idempotencyKey: `work-${index}`,
      kind: 'assignment',
      source: { kind: 'assignment', sourceId: `work-${index}` },
      summary: summaryFor(index),
    });
    const claim = (await claimNextPersonaActivity({ personaId, ttlMs: 120_000 }))!;
    await completePersonaActivity({
      workspaceId: claim.lease.workspaceId,
      personaId,
      activityId: claim.activity.id,
      leaseId: claim.lease.id,
      holderId: claim.lease.holderId,
      fencingToken: claim.lease.fencingToken,
      status: 'completed',
      outcomeRef: outcomeRefFor(index),
    });
  }
}

async function setup(count = 3) {
  const { persona } = await createPersonaFromRole({ name: 'Retention Persona', idempotencyKey: 'owner' });
  await finishWork(persona.id, count);
  return { persona, later: Date.now() + 31 * DAY_MS };
}

async function storedState() {
  return (await readPersonaRuntimeRetentionState()).state;
}

/** Every file under the workspace db, except lock files and the rollout state. */
async function snapshotRecordFiles(): Promise<Record<string, string>> {
  const root = path.join(getWorkspaceDataDir(), 'db');
  const skipped = new Set(['.runtime-locks', `${StorageKey.PERSONA_RUNTIME_RETENTION_STATE}.json`]);
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (skipped.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      const [stats, content] = await Promise.all([fs.stat(absolute), fs.readFile(absolute)]);
      snapshot[path.relative(root, absolute)] = `${stats.mtimeMs}:${
        createHash('sha256').update(content).digest('hex')
      }`;
    }
  };
  await visit(root);
  return snapshot;
}

/** Old errored Activities whose error text cleanup would remove. */
async function seedOldActivities(personaId: string, count: number): Promise<void> {
  const at = Date.now() - 1_000;
  for (let index = 0; index < count; index += 1) {
    await actualStore.savePersonaActivity({
      schemaVersion: PERSONA_ACTIVITY_SCHEMA_VERSION,
      id: `activity_volume_${index}`,
      personaId,
      kind: 'assignment',
      status: 'error',
      source: { kind: 'assignment', sourceId: `volume-${index}` },
      error: `Failure ${index}: ${'long private error detail '.repeat(10)}`,
      createdAt: at,
      updatedAt: at,
      completedAt: at,
    });
  }
}

/** An old, finished mailbox item that a still-running Activity points at. */
async function pointOldItemAtRunningWork(personaId: string) {
  const [oldest] = (await personaStore.listPersonaMailboxItems(personaId))
    .sort((left, right) => left.sequence - right.sequence);
  await enqueuePersonaMailboxItem({
    personaId,
    idempotencyKey: 'still-running',
    kind: 'assignment',
    source: { kind: 'assignment', sourceId: 'still-running' },
    summary: summaryFor(99),
  });
  const running = (await claimNextPersonaActivity({ personaId, ttlMs: 120_000 }))!;
  await actualStore.savePersonaMailboxItem({ ...oldest, claimedActivityId: running.activity.id });
  return {
    referencedItemId: oldest.id,
    finishRunningWork: async () => {
      await completePersonaActivity({
        workspaceId: running.lease.workspaceId,
        personaId,
        activityId: running.activity.id,
        leaseId: running.lease.id,
        holderId: running.lease.holderId,
        fencingToken: running.lease.fencingToken,
        status: 'completed',
      });
    },
  };
}

/**
 * Each anomaly, arranged on a workspace whose cleanup is on. The returned step
 * removes the cause, as later work or a fixed release would.
 */
const ANOMALIES: Array<[
  PersonaRuntimeRetentionAnomaly,
  string,
  (personaId: string) => Promise<() => Promise<void>>,
]> = [
  ['referenced', 'an old finished record still points at unfinished work', async (personaId) => (
    (await pointOldItemAtRunningWork(personaId)).finishRunningWork
  )],
  ['invalid', 'a cleaned-up Activity would change its status', async () => {
    jest.mocked(compactRuntime.getActivityRetentionPolicy).mockImplementation(() => {
      const policy = actualCompactRuntime.getActivityRetentionPolicy();
      return { ...policy, compact: (activity, at) => ({ ...policy.compact(activity, at), status: 'running' }) };
    });
    return async () => {
      jest.mocked(compactRuntime.getActivityRetentionPolicy)
        .mockImplementation(actualCompactRuntime.getActivityRetentionPolicy);
    };
  }],
  ['volume', 'a run would change far more records than any clean run before', async (personaId) => {
    await storeRetentionState({ mode: 'active', candidateBaseline: 0 });
    await seedOldActivities(personaId, 101);
    return async () => undefined;
  }],
];

describe('Persona history cleanup on real storage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.mocked(personaStore.listPersonas).mockImplementation(actualStore.listPersonas);
    jest.mocked(personaStore.listPersonaActivities).mockImplementation(actualStore.listPersonaActivities);
    jest.mocked(personaStore.savePersonaActivity).mockImplementation(actualStore.savePersonaActivity);
    jest.mocked(personaStore.savePersonaMailboxItem).mockImplementation(actualStore.savePersonaMailboxItem);
    jest.mocked(compactRuntime.getActivityRetentionPolicy)
      .mockImplementation(actualCompactRuntime.getActivityRetentionPolicy);
    jest.mocked(loadItem).mockImplementation(actualLoadItem);
  });

  it('measures first and never writes a Persona record', async () => fresh(async () => {
    const { persona, later } = await setup();
    const before = await snapshotRecordFiles();
    jest.mocked(personaStore.savePersonaMailboxItem).mockClear();
    jest.mocked(personaStore.savePersonaActivity).mockClear();

    const sweep = await runPersonaRuntimeRetentionSweep({ now: later });

    expect(sweep).toMatchObject({ mode: 'shadow', modeAfter: 'shadow', anomalies: [], personasFailed: 0 });
    expect(sweep.collections.mailboxItems).toMatchObject({ candidates: 3, selected: 3, compacted: 0, notSmaller: 0 });
    expect(sweep.collections.activities).toMatchObject({ candidates: 3, selected: 3, compacted: 0 });
    expect(sweep.collections.activities.projectedBytesAfter)
      .toBeLessThan(sweep.collections.activities.bytesBefore);
    expect(await snapshotRecordFiles()).toEqual(before);
    expect(personaStore.savePersonaMailboxItem).not.toHaveBeenCalled();
    expect(personaStore.savePersonaActivity).not.toHaveBeenCalled();

    const state = await storedState();
    expect(state).toMatchObject({ mode: 'shadow', cleanSweeps: 1, streakStartedAt: later, candidateBaseline: 6 });
    expect(state.lastSweep).toMatchObject({ at: later, mode: 'shadow', personas: 1, candidates: 6, compacted: 0 });
    expect(JSON.stringify(state)).not.toContain(persona.id);
    expect(await getPersonaStorageStats(persona.id)).toMatchObject({
      retentionEnabled: false,
      retentionMode: 'shadow',
    });
  }));

  it('switches cleanup on by itself after a clean measuring week, then cleans up', async () => fresh(async () => {
    const { persona, later } = await setup();
    const { cleanSweeps, spanMs } = PERSONA_RUNTIME_RETENTION_GRADUATION;
    const interval = Math.ceil(spanMs / (cleanSweeps - 1));

    for (let run = 1; run <= cleanSweeps; run += 1) {
      const sweep = await runPersonaRuntimeRetentionSweep({ now: later + (run - 1) * interval });
      expect(sweep).toMatchObject({ mode: 'shadow', anomalies: [] });
      expect(sweep.collections.mailboxItems.compacted + sweep.collections.activities.compacted).toBe(0);
      expect(sweep.modeAfter).toBe(run === cleanSweeps ? 'active' : 'shadow');
    }
    expect(await storedState()).toMatchObject({
      mode: 'active',
      cleanSweeps,
      graduatedAt: later + (cleanSweeps - 1) * interval,
    });

    const cleanup = await runPersonaRuntimeRetentionSweep({ now: later + spanMs + DAY_MS });
    expect(cleanup).toMatchObject({ mode: 'active', modeAfter: 'active', anomalies: [], personasFailed: 0 });
    expect(cleanup.collections.mailboxItems).toMatchObject({ compacted: 3, failed: 0 });
    expect(cleanup.collections.activities).toMatchObject({ compacted: 3, failed: 0 });
    const items = await personaStore.listPersonaMailboxItems(persona.id);
    expect(items.every((item) => item.compactedAt !== undefined && item.summary === undefined)).toBe(true);
    expect(await getPersonaStorageStats(persona.id)).toMatchObject({
      retentionEnabled: true,
      retentionMode: 'active',
    });
  }));

  it.each(ANOMALIES)(
    'goes back to measuring on a %s anomaly (%s), writes nothing, and heals without a restart',
    async (kind, _cause, arrange) => fresh(async () => {
      const { persona, later } = await setup();
      await storeRetentionState({ mode: 'active', candidateBaseline: 6 });
      const removeCause = await arrange(persona.id);
      const itemsBefore = await personaStore.listPersonaMailboxItems(persona.id);
      const before = await snapshotRecordFiles();

      const sweep = await runPersonaRuntimeRetentionSweep({ now: later });

      expect(sweep).toMatchObject({ mode: 'active', modeAfter: 'shadow', anomalies: [kind] });
      expect(await snapshotRecordFiles()).toEqual(before);
      expect(await personaStore.listPersonaMailboxItems(persona.id)).toEqual(itemsBefore);
      expect(await storedState()).toMatchObject({
        mode: 'shadow',
        cleanSweeps: 0,
        rollbacks: 1,
        lastAnomaly: { kind, at: later, mode: 'active' },
      });

      await removeCause();
      const measuredOnly = await snapshotRecordFiles();
      const healed = await runPersonaRuntimeRetentionSweep({ now: later + HOUR_MS });
      expect(healed).toMatchObject({ mode: 'shadow', modeAfter: 'shadow', anomalies: [] });
      expect(await storedState()).toMatchObject({ mode: 'shadow', cleanSweeps: 1, rollbacks: 1 });
      expect(await snapshotRecordFiles()).toEqual(measuredOnly);
    }),
  );

  it('does not count a measuring run that found an old record still in use', async () => fresh(async () => {
    const { persona, later } = await setup();
    const { referencedItemId } = await pointOldItemAtRunningWork(persona.id);

    await runPersonaRuntimeRetentionSweep({ now: later });
    await runPersonaRuntimeRetentionSweep({ now: later + HOUR_MS });

    expect(await storedState()).toMatchObject({
      mode: 'shadow',
      cleanSweeps: 0,
      rollbacks: 0,
      lastAnomaly: { kind: 'referenced', mode: 'shadow' },
    });
    const referenced = await personaStore.getPersonaMailboxItem(persona.id, referencedItemId);
    expect(referenced?.summary).toBe(summaryFor(0));
    expect(referenced?.compactedAt).toBeUndefined();
  }));

  it.each([
    ['a write fails', () => {
      jest.mocked(personaStore.savePersonaActivity).mockRejectedValueOnce(new Error('disk refused the write'));
    }],
    ['a Persona cannot be read', () => {
      jest.mocked(personaStore.listPersonaActivities).mockRejectedValueOnce(new Error('disk refused the read'));
    }],
  ])('goes back to measuring on an error when %s and stops writing at once', async (_label, arrange) => fresh(async () => {
    const { persona, later } = await setup();
    await storeRetentionState({ mode: 'active', candidateBaseline: 6 });
    arrange();

    const sweep = await runPersonaRuntimeRetentionSweep({ now: later });

    expect(sweep).toMatchObject({ mode: 'active', modeAfter: 'shadow', anomalies: ['error'] });
    expect(sweep.collections.activities.compacted).toBe(0);
    expect(await storedState()).toMatchObject({ mode: 'shadow', rollbacks: 1, lastAnomaly: { kind: 'error' } });
    const activities = await personaStore.listPersonaActivities(persona.id);
    expect(activities.every((activity) => activity.compactedAt === undefined)).toBe(true);

    const next = await runPersonaRuntimeRetentionSweep({ now: later + HOUR_MS });
    expect(next).toMatchObject({ mode: 'shadow', anomalies: [] });
    expect(next.collections.activities.compacted + next.collections.mailboxItems.compacted).toBe(0);
  }));

  it('stops a running cleanup before its next write when an anomaly is stored elsewhere', async () => fresh(async () => {
    const { persona, later } = await setup();
    await storeRetentionState({ mode: 'active', candidateBaseline: 6 });
    jest.mocked(personaStore.savePersonaMailboxItem).mockImplementation(async (value) => {
      const saved = await actualStore.savePersonaMailboxItem(value);
      if (value.compactedAt !== undefined) await recordPersonaRuntimeRetentionAnomaly('error', later);
      return saved;
    });

    const stopped = await runPersonaRuntimeRetentionSweep({ now: later });

    expect(stopped.collections.mailboxItems).toMatchObject({ selected: 3, compacted: 1, stopped: 2 });
    expect(stopped.collections.activities).toMatchObject({ selected: 3, compacted: 0, stopped: 3 });
    expect(stopped.modeAfter).toBe('shadow');
    const items = await personaStore.listPersonaMailboxItems(persona.id);
    expect(items.filter((item) => item.compactedAt !== undefined)).toHaveLength(1);
  }));

  it('starts measuring again when the stored state is damaged', async () => fresh(async () => {
    const { later } = await setup(1);
    await storeRetentionState({ mode: 'active' });
    const file = path.join(getWorkspaceDataDir(), 'db', `${StorageKey.PERSONA_RUNTIME_RETENTION_STATE}.json`);
    await fs.writeFile(file, JSON.stringify({ version: 1, mode: 'everything' }));
    const before = await snapshotRecordFiles();

    const sweep = await runPersonaRuntimeRetentionSweep({ now: later });

    expect(sweep).toMatchObject({ mode: 'shadow', modeAfter: 'shadow', anomalies: [] });
    expect(await snapshotRecordFiles()).toEqual(before);
    expect(await storedState()).toMatchObject({ mode: 'shadow', cleanSweeps: 1 });
  }));

  it('measures without recording anything while the stored state is briefly locked', async () => fresh(async () => {
    const { later } = await setup(1);
    await storeRetentionState({ mode: 'active' });
    const locked = Object.assign(new Error('resource busy'), { code: 'EBUSY' });
    jest.mocked(loadItem).mockRejectedValueOnce(locked);
    const before = await snapshotRecordFiles();

    const sweep = await runPersonaRuntimeRetentionSweep({ now: later });

    expect(sweep).toMatchObject({ stateUnreadable: true, personasExamined: 0 });
    expect(await snapshotRecordFiles()).toEqual(before);
    expect(await storedState()).toMatchObject({ mode: 'active', cleanSweeps: 0 });
  }));

  it('still coalesces a retry whose original mailbox item was cleaned up', async () => fresh(async () => {
    const { persona, later } = await setup(1);
    const [original] = await personaStore.listPersonaMailboxItems(persona.id);
    await storeRetentionState({ mode: 'active' });
    await runPersonaRuntimeRetentionSweep({ now: later });
    expect((await personaStore.listPersonaMailboxItems(persona.id))[0].compactedAt).toBeDefined();

    const retry = await enqueuePersonaMailboxItem({
      personaId: persona.id,
      idempotencyKey: 'work-0',
      kind: 'assignment',
      source: { kind: 'assignment', sourceId: 'work-0' },
      summary: summaryFor(0),
    });

    expect(retry).toMatchObject({ duplicate: true, item: { id: original.id, status: 'completed' } });
    expect(await claimNextPersonaActivity({ personaId: persona.id, ttlMs: 120_000 })).toBeNull();
    await expect(enqueuePersonaMailboxItem({
      personaId: persona.id,
      idempotencyKey: 'work-0',
      kind: 'assignment',
      source: { kind: 'assignment', sourceId: 'work-0' },
      summary: 'Different work under the same key',
    })).rejects.toBeInstanceOf(PersonaMailboxConflictError);
  }));

  it('starts a fresh sweep when a previous one is stuck instead of blocking until restart', async () => fresh(async () => {
    let release!: (value: Awaited<ReturnType<typeof actualStore.listPersonas>>) => void;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    jest.mocked(personaStore.listPersonas).mockImplementationOnce(() => {
      entered();
      return new Promise((resolve) => { release = resolve; });
    });
    const stuck = runPersonaRuntimeRetentionSweep();
    await reached;

    expect((await runPersonaRuntimeRetentionSweep()).overlappingSweepSkipped).toBe(true);

    const realNow = Date.now.bind(Date);
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + PERSONA_RUNTIME_RETENTION_STUCK_SWEEP_MS + 1);
    const replacement = await runPersonaRuntimeRetentionSweep();
    expect(replacement.overlappingSweepSkipped).toBe(false);

    release([]);
    expect((await stuck).personasExamined).toBe(0);
  }));
});
