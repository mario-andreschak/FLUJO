import { SchedulerService } from '@/backend/services/scheduler';
import { loadItem, saveItem } from '@/utils/storage/backend';
import type { PlannedExecution, RunRecord } from '@/shared/types/plannedExecution';

const mockStore = new Map<string, unknown>();
const mockRunFlow = jest.fn();

jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async (key: string, fallback: unknown) =>
    mockStore.has(key) ? structuredClone(mockStore.get(key)) : fallback),
  saveItem: jest.fn(async (key: string, value: unknown) => {
    mockStore.set(key, structuredClone(value));
  }),
  clearItem: jest.fn(async (key: string) => { mockStore.delete(key); }),
}));
jest.mock('@/backend/services/enduringAgents/runtimeLock', () => ({
  withPersonaRuntimeLock: jest.fn(async (
    _id: string,
    task: (lock: { assertOwned(): Promise<void> }) => Promise<unknown>,
  ) => task({ assertOwned: async () => undefined })),
}));
jest.mock('@/backend/execution/flow/runFlow', () => ({
  runFlow: (...args: unknown[]) => mockRunFlow(...args),
}));
jest.mock('@/utils/encryption/secure', () => ({ isEncryptionLocked: async () => false }));
jest.mock('@/backend/services/flow', () => ({ flowService: { getFlow: async () => null } }));

const input = {
  name: 'Quarter-hour check', enabled: true, flowId: 'flow-probe', prompt: 'Check',
  trigger: { type: 'schedule' as const, cron: '*/15 * * * *', timezone: 'America/Bogota', catchUp: true },
};
const rows = (id: string) => (mockStore.get(`planned-execution-runs/${id}`) ?? []) as RunRecord[];
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

describe('cron occurrence accounting across re-enable/reconcile (#539)', () => {
  let scheduler: SchedulerService;
  let execution: PlannedExecution;

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-01T12:56:24.689Z') });
    mockStore.clear();
    jest.clearAllMocks();
    jest.mocked(loadItem).mockImplementation(async (key, fallback) =>
      (mockStore.has(key) ? structuredClone(mockStore.get(key)) : fallback) as typeof fallback);
    jest.mocked(saveItem).mockImplementation(async (key, value) => {
      mockStore.set(key, structuredClone(value));
    });
    mockRunFlow.mockResolvedValue({
      status: 'completed', outputText: 'healthy', messages: [], sharedState: {},
      conversationId: 'probe',
    });
    scheduler = new SchedulerService();
  });

  afterEach(async () => {
    await scheduler.setPaused(true);
    jest.useRealTimers();
  });

  it('retains an unchanged timer while reconcile reads storage across the due boundary', async () => {
    execution = (await scheduler.create(input)).execution!;
    const gate = deferred();
    jest.mocked(loadItem).mockImplementationOnce(async (key, fallback) => {
      await gate.promise;
      return (mockStore.get(key) ?? fallback) as typeof fallback;
    });
    const reconciling = scheduler.reconcile();
    await flush();
    await jest.advanceTimersByTimeAsync(216000);
    gate.resolve();
    await reconciling;
    await flush();
    expect(mockRunFlow).toHaveBeenCalledTimes(1);
    expect(rows(execution.id)).toHaveLength(1);
    expect(rows(execution.id)[0].status).toBe('completed');
    expect(scheduler.getStatus(execution).nextRun).toBe('2026-10-01T13:15:00.000Z');
  });

  it('accounts exactly once for the first due tick when re-enable cursor loading crosses it', async () => {
    execution = (await scheduler.create({ ...input, enabled: false })).execution!;
    mockStore.set(`planned-execution-state/${execution.id}`, {
      lastScheduledFireAt: '2026-10-01T12:45:00.003Z',
    });
    const gate = deferred();
    const normalLoad = jest.mocked(loadItem).getMockImplementation()!;
    jest.mocked(loadItem).mockImplementation(async (key, fallback) => {
      if (key === `planned-execution-state/${execution.id}`) {
        jest.mocked(loadItem).mockImplementation(normalLoad);
        await gate.promise;
      }
      return (mockStore.get(key) ?? fallback) as typeof fallback;
    });
    const enabling = scheduler.update(execution.id, { enabled: true });
    await flush();
    await jest.advanceTimersByTimeAsync(216000);
    await flush();
    expect(mockRunFlow).not.toHaveBeenCalled();
    gate.resolve();
    await enabling;
    await flush();
    expect(mockRunFlow).toHaveBeenCalledTimes(1);
    expect(rows(execution.id)[0]).toMatchObject({ status: 'completed', triggerSummary: 'Schedule' });
    expect(mockStore.get(`planned-execution-state/${execution.id}`)).toMatchObject({
      lastScheduledFireAt: '2026-10-01T13:00:00.000Z',
    });
    expect(mockRunFlow.mock.calls[0][0].prompt).toContain('2026-10-01T13:00:00.000Z');
  });

  it('still admits the first future tick after a normal disable and re-enable', async () => {
    execution = (await scheduler.create(input)).execution!;
    await scheduler.update(execution.id, { enabled: false });
    await scheduler.update(execution.id, { enabled: true });
    await jest.advanceTimersByTimeAsync(216000);
    await flush();
    expect(mockRunFlow).toHaveBeenCalledTimes(1);
    expect(rows(execution.id)[0].status).toBe('completed');
  });

  it('surfaces the exact occurrence when a cursor write fails and clears it after recovery', async () => {
    execution = (await scheduler.create(input)).execution!;
    jest.mocked(saveItem).mockRejectedValueOnce(new Error('disk unavailable'));
    await jest.advanceTimersByTimeAsync(216000);
    expect(mockRunFlow).not.toHaveBeenCalled();
    expect(scheduler.getStatus(execution).lastTriggerError)
      .toMatch(/2026-10-01T13:00:00.000Z.*disk unavailable/);
    await jest.advanceTimersByTimeAsync(15 * 60 * 1000);
    await flush();
    expect(mockRunFlow).toHaveBeenCalledTimes(1);
    expect(scheduler.getStatus(execution).lastTriggerError).toBeUndefined();
  });
});
