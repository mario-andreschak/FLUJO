import {
  createPersonaProcessEnvironment,
  killOrphanedPersonaChildren,
  removePersonaProcessEnvironment,
  startPersonaProcess,
  waitFor,
  type PersonaLeaseFence,
  type PersonaProcessClient,
  type PersonaProcessEnvironment,
} from './personaProcessBoundaryHarness';

// Three children are spawned in sequence, each with its own readiness budget.
jest.setTimeout(300_000);

const DAY_MS = 24 * 60 * 60 * 1_000;

interface CreatedPersona {
  persona: { id: string };
}

interface Claimed {
  fence: PersonaLeaseFence;
}

interface StoredRecord {
  id: string;
  personaId: string;
  status: string;
  createdAt: number;
  completedAt?: number;
  compactedAt?: number;
  summary?: string;
  idempotencyKey?: string;
  admissionDigest?: string;
  behaviorRevisionId?: string;
}

interface Records {
  mailboxItems: StoredRecord[];
  activities: StoredRecord[];
}

interface CollectionTotals {
  candidates: number;
  compacted: number;
  alreadyCompacted: number;
  failed: number;
}

interface SweepResult {
  mode: 'shadow' | 'active';
  modeAfter: 'shadow' | 'active';
  anomalies: string[];
  personasFailed: number;
  collections: Record<'mailboxItems' | 'activities', CollectionTotals>;
}

interface StateRead {
  readable: boolean;
  state: { mode: 'shadow' | 'active'; cleanSweeps: number; rollbacks: number };
}

const compacted = (records: StoredRecord[]) => records.filter((record) => record.compactedAt !== undefined);

describe('Persona history cleanup across real process crashes and restarts', () => {
  let environment: PersonaProcessEnvironment | undefined;
  const clients: PersonaProcessClient[] = [];

  async function start(): Promise<PersonaProcessClient> {
    const client = await startPersonaProcess(environment!);
    clients.push(client);
    return client;
  }

  beforeEach(async () => {
    environment = await createPersonaProcessEnvironment('retention');
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
    if (environment) await removePersonaProcessEnvironment(environment);
    environment = undefined;
  });

  afterAll(() => {
    killOrphanedPersonaChildren();
  });

  it('keeps its state across restarts and finishes a cleanup cut off by a crash exactly once', async () => {
    const first = await start();
    const { persona } = await first.request<CreatedPersona>({
      type: 'createPersona',
      name: 'Cleanup Persona',
      idempotencyKey: 'cleanup-owner',
      coreFlowRef: 'cleanup-core',
    });
    for (let index = 0; index < 3; index += 1) {
      await first.request({
        type: 'enqueue',
        input: {
          personaId: persona.id,
          idempotencyKey: `work-${index}`,
          kind: 'assignment',
          source: { kind: 'assignment', sourceId: `work-${index}` },
          summary: `Private summary ${index}: ${'detail of the request '.repeat(12)}`,
        },
      });
      const claim = await first.request<Claimed>({ type: 'claim', personaId: persona.id, ttlMs: 120_000 });
      await first.request({
        type: 'complete',
        fence: { ...claim.fence, outcomeRef: `dispatch_outcome_${String(index).padStart(36, '0')}` },
      });
    }
    const later = Date.now() + 31 * DAY_MS;

    const measured = await first.request<SweepResult>({ type: 'retentionSweep', now: later });
    expect(measured).toMatchObject({ mode: 'shadow', modeAfter: 'shadow', anomalies: [] });
    expect(measured.collections.mailboxItems).toMatchObject({ candidates: 3, compacted: 0 });
    await first.kill();

    const second = await start();
    expect(await second.request<StateRead>({ type: 'retentionState' }))
      .toMatchObject({ readable: true, state: { mode: 'shadow', cleanSweeps: 1 } });
    await second.request({ type: 'retentionCleanupOn' });
    const original = await second.request<Records>({ type: 'retentionRecords', personaId: persona.id });
    expect(compacted(original.mailboxItems)).toHaveLength(0);

    const cutOff = second.request({ type: 'retentionSweep', now: later + 1_000, holdAfterWrites: 1 }, 120_000)
      .catch(() => undefined);
    await waitFor(
      () => second.request<{ writes: number }>({ type: 'retentionCheckpoint' }),
      (checkpoint) => checkpoint.writes === 1,
      { timeoutMs: 60_000, description: 'the first cleanup write' },
    );
    const exit = await second.kill();
    expect(exit.code !== null || exit.signal !== null).toBe(true);
    await cutOff;

    const third = await start();
    expect(await third.request<StateRead>({ type: 'retentionState' }))
      .toMatchObject({ readable: true, state: { mode: 'active', rollbacks: 0 } });
    const afterCrash = await third.request<Records>({ type: 'retentionRecords', personaId: persona.id });
    const [firstCompacted] = compacted(afterCrash.mailboxItems);
    expect(compacted(afterCrash.mailboxItems)).toHaveLength(1);
    expect(compacted(afterCrash.activities)).toHaveLength(0);

    const finished = await third.request<SweepResult>({ type: 'retentionSweep', now: later + 2_000 });
    expect(finished).toMatchObject({ mode: 'active', modeAfter: 'active', anomalies: [], personasFailed: 0 });
    expect(finished.collections.mailboxItems).toMatchObject({ compacted: 2, alreadyCompacted: 1, failed: 0 });
    expect(finished.collections.activities).toMatchObject({ compacted: 3, failed: 0 });

    const converged = await third.request<SweepResult>({ type: 'retentionSweep', now: later + 3_000 });
    expect(converged.collections.mailboxItems).toMatchObject({ candidates: 0, compacted: 0, alreadyCompacted: 3 });
    expect(converged.collections.activities).toMatchObject({ candidates: 0, compacted: 0, alreadyCompacted: 3 });

    const final = await third.request<Records>({ type: 'retentionRecords', personaId: persona.id });
    expect(final.mailboxItems.find((item) => item.id === firstCompacted.id)?.compactedAt)
      .toBe(firstCompacted.compactedAt);
    for (const item of final.mailboxItems) {
      const before = original.mailboxItems.find((candidate) => candidate.id === item.id)!;
      expect(item).toMatchObject({
        id: before.id,
        personaId: before.personaId,
        status: before.status,
        idempotencyKey: before.idempotencyKey,
        createdAt: before.createdAt,
        completedAt: before.completedAt,
        admissionDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(item.summary).toBeUndefined();
    }
    for (const activity of final.activities) {
      const before = original.activities.find((candidate) => candidate.id === activity.id)!;
      expect(activity).toMatchObject({
        id: before.id,
        status: before.status,
        behaviorRevisionId: before.behaviorRevisionId,
        createdAt: before.createdAt,
        completedAt: before.completedAt,
        compactedAt: expect.any(Number),
      });
    }
  });
});
