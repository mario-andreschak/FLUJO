import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

import {
  PersonaMailboxConflictError,
  claimNextPersonaActivity,
  completePersonaActivity,
  enqueuePersonaMailboxItem,
} from '@/backend/services/enduringAgents/activityRuntime';
import { ENDURING_AGENT_COLLECTIONS } from '@/backend/services/enduringAgents/collections';
import { setPersonaRuntimeRetentionSetting } from '@/backend/services/enduringAgents/personaRuntimeRetentionControl';
import { getPersonaRuntimeRetentionReports } from '@/backend/services/enduringAgents/personaRuntimeRetentionReports';
import {
  PERSONA_RUNTIME_RETENTION_STUCK_SWEEP_MS,
  runPersonaRuntimeRetentionSweep,
} from '@/backend/services/enduringAgents/personaRuntimeRetentionRollout';
import { getPersonaStorageStats } from '@/backend/services/enduringAgents/runtimeStorageStats';
import * as personaStore from '@/backend/services/enduringAgents/store';
import { FEATURES } from '@/config/features';
import { StorageKey } from '@/shared/types/storage/storage';
import { getShardedCollectionItemPath } from '@/utils/storage/backend';
import { getWorkspaceDataDir, runWithWorkspace } from '@/utils/workspace';

import { createPersonaFromRole } from './fixtures/personaFactory';

jest.mock('@/backend/services/enduringAgents/store', () => {
  const actual = jest.requireActual<typeof import('@/backend/services/enduringAgents/store')>(
    '@/backend/services/enduringAgents/store',
  );
  return {
    ...actual,
    listPersonas: jest.fn(actual.listPersonas),
    savePersonaActivity: jest.fn(actual.savePersonaActivity),
    savePersonaMailboxItem: jest.fn(actual.savePersonaMailboxItem),
  };
});

jest.setTimeout(60_000);

const actualStore = jest.requireActual<typeof import('@/backend/services/enduringAgents/store')>(
  '@/backend/services/enduringAgents/store',
);
const DAY_MS = 24 * 60 * 60 * 1_000;
const ACTIVE = {
  mode: 'active',
  rolloutBasisPoints: 10_000,
  cohortVersion: 'retention-sweep-test',
  criticalPersonaIds: [],
} as const;

let sequence = 0;
const fresh = <T>(task: () => Promise<T>) => runWithWorkspace(
  `retention-sweep-${process.pid}-${++sequence}`,
  task,
);

async function finishWork(personaId: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await enqueuePersonaMailboxItem({
      personaId,
      idempotencyKey: `work-${index}`,
      kind: 'assignment',
      source: { kind: 'assignment', sourceId: `work-${index}` },
      summary: `Private summary ${index}`,
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
    });
  }
}

async function setup(count = 3) {
  const { persona } = await createPersonaFromRole({ name: 'Retention Persona', idempotencyKey: 'owner' });
  await finishWork(persona.id, count);
  return { persona, later: Date.now() + 31 * DAY_MS };
}

/** Every file under the workspace db, except lock files and the sweep report. */
async function snapshotRecordFiles(): Promise<Record<string, string>> {
  const root = path.join(getWorkspaceDataDir(), 'db');
  const skipped = new Set(['.runtime-locks', `${StorageKey.PERSONA_RUNTIME_RETENTION_REPORTS}.json`]);
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

describe('Persona runtime retention sweep on real storage', () => {
  beforeEach(() => {
    FEATURES.ENABLE_PERSONA_RUNTIME_RETENTION = true;
    delete process.env.FLUJO_PERSONA_RUNTIME_RETENTION_MODE;
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.mocked(personaStore.listPersonas).mockImplementation(actualStore.listPersonas);
    jest.mocked(personaStore.savePersonaActivity).mockImplementation(actualStore.savePersonaActivity);
    jest.mocked(personaStore.savePersonaMailboxItem).mockImplementation(actualStore.savePersonaMailboxItem);
    delete process.env.FLUJO_PERSONA_RUNTIME_RETENTION_MODE;
  });

  it('measures by default and never writes a Persona record', async () => fresh(async () => {
    const { persona, later } = await setup();
    const before = await snapshotRecordFiles();

    const sweep = await runPersonaRuntimeRetentionSweep({ now: later });

    expect(sweep).toMatchObject({ mode: 'shadow', modeSource: 'default', personasFailed: 0 });
    expect(sweep.collections.mailboxItems).toMatchObject({ candidateCount: 3, selected: 3, compacted: 0 });
    expect(sweep.collections.activities).toMatchObject({ candidateCount: 3, selected: 3, compacted: 0 });
    expect(sweep.collections.mailboxItems.bytesBefore).toBeGreaterThan(0);
    expect(sweep.collections.activities.projectedBytesAfter).toBeGreaterThan(0);
    expect(sweep.observations[0].collections[0].actualBytesBefore).toBeUndefined();
    expect(await snapshotRecordFiles()).toEqual(before);
    expect(personaStore.savePersonaMailboxItem).not.toHaveBeenCalledWith(
      expect.objectContaining({ compactedAt: expect.any(Number) }),
    );

    const reports = await getPersonaRuntimeRetentionReports();
    expect(reports.totals).toMatchObject({ sweeps: 1, shadowSweeps: 1, activeSweeps: 0, compacted: 0 });
    expect(reports.recent[0]).toMatchObject({
      sweepId: sweep.sweepId,
      mode: 'shadow',
      modeSource: 'default',
      collections: { mailboxItems: { candidateCount: 3, compacted: 0 } },
    });
    const stored = JSON.stringify(reports);
    expect(stored).not.toContain(persona.id);
    expect(stored).not.toContain('Private summary');

    expect(await getPersonaStorageStats(persona.id)).toMatchObject({
      retentionEnabled: false,
      retentionMode: 'shadow',
    });
  }));

  it('stops an active sweep before its next write when the setting turns it off, without a restart', async () => fresh(async () => {
    const { persona, later } = await setup();
    jest.mocked(personaStore.savePersonaMailboxItem).mockImplementation(async (value) => {
      const saved = await actualStore.savePersonaMailboxItem(value);
      if (value.compactedAt !== undefined) await setPersonaRuntimeRetentionSetting('disabled');
      return saved;
    });

    const stopped = await runPersonaRuntimeRetentionSweep({ now: later, config: ACTIVE });

    expect(stopped.collections.mailboxItems).toMatchObject({ selected: 3, compacted: 1, unauthorized: 2 });
    expect(stopped.collections.activities).toMatchObject({ selected: 3, compacted: 0, unauthorized: 3 });
    const items = await personaStore.listPersonaMailboxItems(persona.id);
    expect(items.filter((item) => item.compactedAt !== undefined)).toHaveLength(1);

    const off = await runPersonaRuntimeRetentionSweep({ now: later, config: ACTIVE });
    expect(off).toMatchObject({ mode: 'disabled', modeSource: 'setting', personasExamined: 0 });

    jest.mocked(personaStore.savePersonaMailboxItem).mockImplementation(actualStore.savePersonaMailboxItem);
    await setPersonaRuntimeRetentionSetting(null);
    const resumed = await runPersonaRuntimeRetentionSweep({ now: later, config: ACTIVE });
    expect(resumed).toMatchObject({ mode: 'active', modeSource: 'environment', personasFailed: 0 });
    expect(resumed.collections.mailboxItems).toMatchObject({ compacted: 2, alreadyCompacted: 1 });
  }));

  it('lets FLUJO_PERSONA_RUNTIME_RETENTION_MODE=disabled turn retention off', async () => fresh(async () => {
    const { later } = await setup(1);
    process.env.FLUJO_PERSONA_RUNTIME_RETENTION_MODE = 'disabled';
    await setPersonaRuntimeRetentionSetting('active');

    const sweep = await runPersonaRuntimeRetentionSweep({ now: later });

    expect(sweep).toMatchObject({ mode: 'disabled', modeSource: 'environment', personasExamined: 0 });
  }));

  it('recovers from a crash in the middle of a cleanup run and finishes the job exactly once', async () => fresh(async () => {
    const { persona, later } = await setup();
    const originalItems = await personaStore.listPersonaMailboxItems(persona.id);
    const originalActivities = await personaStore.listPersonaActivities(persona.id);
    expect(originalItems.map((item) => item.status)).toEqual(['completed', 'completed', 'completed']);

    let crashed = false;
    const crash = new Error('process stopped');
    jest.mocked(personaStore.savePersonaMailboxItem).mockImplementation(async (value) => {
      if (crashed) throw crash;
      const saved = await actualStore.savePersonaMailboxItem(value);
      if (value.compactedAt !== undefined) crashed = true;
      return saved;
    });
    jest.mocked(personaStore.savePersonaActivity).mockImplementation(async (value) => {
      if (crashed) throw crash;
      return actualStore.savePersonaActivity(value);
    });

    const interrupted = await runPersonaRuntimeRetentionSweep({ now: later, config: ACTIVE });
    expect(interrupted.collections.mailboxItems).toMatchObject({ compacted: 1, failed: 2 });
    expect(interrupted.collections.activities).toMatchObject({ compacted: 0, failed: 3 });

    const firstCompacted = (await personaStore.listPersonaMailboxItems(persona.id))
      .find((item) => item.compactedAt !== undefined)!;
    const unfinished = originalItems.find((item) => item.id !== firstCompacted.id)!;
    const halfWritten = `${getShardedCollectionItemPath(
      ENDURING_AGENT_COLLECTIONS.mailboxItems,
      persona.id,
      unfinished.id,
    )}.tmp.crash`;
    await fs.writeFile(halfWritten, '{"id":');

    crashed = false;
    jest.mocked(personaStore.savePersonaMailboxItem).mockImplementation(actualStore.savePersonaMailboxItem);
    jest.mocked(personaStore.savePersonaActivity).mockImplementation(actualStore.savePersonaActivity);
    const restarted = await runPersonaRuntimeRetentionSweep({ now: later + 1_000, config: ACTIVE });
    expect(restarted.personasFailed).toBe(0);
    expect(restarted.collections.mailboxItems).toMatchObject({ compacted: 2, alreadyCompacted: 1, failed: 0 });
    expect(restarted.collections.activities).toMatchObject({ compacted: 3, failed: 0 });

    const converged = await runPersonaRuntimeRetentionSweep({ now: later + 2_000, config: ACTIVE });
    expect(converged.collections.mailboxItems).toMatchObject({ selected: 0, compacted: 0, alreadyCompacted: 3 });
    expect(converged.collections.activities).toMatchObject({ selected: 0, compacted: 0, alreadyCompacted: 3 });

    const items = await personaStore.listPersonaMailboxItems(persona.id);
    expect(items.find((item) => item.id === firstCompacted.id)?.compactedAt).toBe(firstCompacted.compactedAt);
    for (const item of items) {
      const original = originalItems.find((candidate) => candidate.id === item.id)!;
      expect(item).toMatchObject({
        id: original.id,
        personaId: original.personaId,
        status: original.status,
        idempotencyKey: original.idempotencyKey,
        createdAt: original.createdAt,
        completedAt: original.completedAt,
        admissionDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(item.summary).toBeUndefined();
    }
    const activities = await personaStore.listPersonaActivities(persona.id);
    for (const activity of activities) {
      const original = originalActivities.find((candidate) => candidate.id === activity.id)!;
      expect(activity).toMatchObject({
        id: original.id,
        status: original.status,
        behaviorRevisionId: original.behaviorRevisionId,
        createdAt: original.createdAt,
        completedAt: original.completedAt,
        compactedAt: expect.any(Number),
      });
    }
  }));

  it('still coalesces a retry whose original mailbox item was cleaned up', async () => fresh(async () => {
    const { persona, later } = await setup(1);
    const [original] = await personaStore.listPersonaMailboxItems(persona.id);
    await runPersonaRuntimeRetentionSweep({ now: later, config: ACTIVE });
    expect((await personaStore.listPersonaMailboxItems(persona.id))[0].compactedAt).toBeDefined();

    const retry = await enqueuePersonaMailboxItem({
      personaId: persona.id,
      idempotencyKey: 'work-0',
      kind: 'assignment',
      source: { kind: 'assignment', sourceId: 'work-0' },
      summary: 'Private summary 0',
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
