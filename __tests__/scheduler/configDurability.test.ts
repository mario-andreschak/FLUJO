const mockStorage = new Map<string, unknown>();
const mockLockTails = new Map<string, Promise<void>>();

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async (key: string, fallback: unknown) => (
    mockStorage.has(key) ? clone(mockStorage.get(key)) : clone(fallback)
  )),
  saveItem: jest.fn(async (key: string, value: unknown) => {
    // Yield once so an un-serialized load/modify/save implementation would
    // deterministically expose its stale-snapshot overwrite.
    await Promise.resolve();
    mockStorage.set(key, clone(value));
  }),
  clearItem: jest.fn(async (key: string) => { mockStorage.delete(key); }),
}));

jest.mock('@/backend/services/enduringAgents/runtimeLock', () => ({
  withPersonaRuntimeLock: jest.fn(async (
    id: string,
    task: (lock: { assertOwned(): Promise<void> }) => Promise<unknown>,
  ) => {
    const predecessor = mockLockTails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    mockLockTails.set(id, predecessor.catch(() => undefined).then(() => current));
    await predecessor.catch(() => undefined);
    try {
      return await task({ assertOwned: async () => undefined });
    } finally {
      release();
    }
  }),
}));

import { SchedulerService } from '@/backend/services/scheduler';

function input(id: string, name: string) {
  return {
    id,
    name,
    enabled: false,
    flowId: 'flow_config_lock',
    prompt: '',
    trigger: { type: 'webhook' as const, token: `token_${id}` },
  };
}

describe('planned-execution config serialization', () => {
  beforeEach(() => {
    mockStorage.clear();
    mockLockTails.clear();
  });

  it('round-trips canonical restrictions across create, update, and reload', async () => {
    const first = new SchedulerService();
    const created = await first.create({
      ...input('execution_restrictions', 'Restrictions'),
      startRestriction: 'exclusive',
      superExclusive: true,
      emergency: true,
    });
    expect(created.execution).toMatchObject({
      startRestriction: 'exclusive',
      superExclusive: true,
      emergency: true,
    });

    const second = new SchedulerService();
    expect(await second.get('execution_restrictions')).toMatchObject({
      startRestriction: 'exclusive',
      superExclusive: true,
      emergency: true,
    });

    const updated = await second.update('execution_restrictions', {
      startRestriction: 'singleton',
      superExclusive: false,
      emergency: false,
    });
    expect(updated.execution).toMatchObject({
      startRestriction: 'singleton',
      superExclusive: false,
      emergency: false,
    });

    const third = new SchedulerService();
    expect(await third.get('execution_restrictions')).toMatchObject({
      startRestriction: 'singleton',
      superExclusive: false,
      emergency: false,
    });
  });

  it('normalizes a legacy Exclusive record without rewriting version-1 storage', async () => {
    mockStorage.set('planned_executions', {
      version: 1,
      paused: false,
      executions: [{
        ...input('legacy_restrictions', 'Legacy'),
        exclusive: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }],
    });

    const scheduler = new SchedulerService();
    expect(await scheduler.get('legacy_restrictions')).toMatchObject({
      startRestriction: 'exclusive',
      superExclusive: true,
      emergency: false,
    });
    const raw = mockStorage.get('planned_executions') as {
      version: number;
      executions: Array<Record<string, unknown>>;
    };
    expect(raw.version).toBe(1);
    expect(raw.executions[0]).not.toHaveProperty('startRestriction');
  });

  it('preserves concurrent create/update/pause mutations from separate schedulers', async () => {
    const first = new SchedulerService();
    const second = new SchedulerService();

    await Promise.all([
      first.create(input('execution_a', 'A')),
      second.create(input('execution_b', 'B')),
    ]);
    await Promise.all([
      first.update('execution_a', { name: 'A updated' }),
      second.update('execution_b', { name: 'B updated' }),
      first.setPaused(true),
    ]);

    const file = mockStorage.get('planned_executions') as {
      paused: boolean;
      executions: Array<{ id: string; name: string; generationId?: string }>;
    };
    expect(file.paused).toBe(true);
    expect(file.executions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'execution_a', name: 'A updated', generationId: expect.any(String) }),
      expect.objectContaining({ id: 'execution_b', name: 'B updated', generationId: expect.any(String) }),
    ]));
  });
});
