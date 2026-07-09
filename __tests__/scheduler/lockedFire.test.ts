/**
 * Tests for Stage 3 (#78) of the #16 custom-encryption fix: the scheduler's
 * locked-encryption fire guard.
 *
 * While USER encryption is locked, a trigger fire must NOT run the flow (its
 * secrets — ${global:...} bindings and model API keys — are undecryptable).
 * Instead it records a `skipped` run with the "encryption locked" reason and
 * touches no trigger baseline, so pending work is naturally picked up after
 * unlock. Once unlocked, the same execution fires normally.
 *
 * Storage is mocked in-memory (below the service, so envelope/ring-buffer/state
 * logic runs through real code); runFlow is mocked at the boundary the service
 * lazy-imports; and the encryption lock helper is mocked so we can flip the
 * locked state at will.
 */
import { SchedulerService } from '@/backend/services/scheduler';
import type {
  PlannedExecutionState,
  RunRecord,
} from '@/shared/types/plannedExecution';

// --- in-memory storage --------------------------------------------------

const store = new Map<string, unknown>();

jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async (key: string, defaultValue: unknown) =>
    store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : defaultValue
  ),
  saveItem: jest.fn(async (key: string, value: unknown) => {
    store.set(key, JSON.parse(JSON.stringify(value)));
  }),
  clearItem: jest.fn(async (key: string) => {
    store.delete(key);
  }),
}));

// --- runFlow mock ---------------------------------------------------------

const runFlowMock = jest.fn();
jest.mock('@/backend/execution/flow/runFlow', () => ({
  runFlow: (...args: unknown[]) => runFlowMock(...args),
}));

// --- encryption lock state (flippable) ------------------------------------

let locked = false;
jest.mock('@/utils/encryption/secure', () => ({
  isEncryptionLocked: jest.fn(async () => locked),
}));

const completedResult = {
  status: 'completed',
  outputText: 'All done',
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0, byNode: {} },
  messages: [],
  conversationId: 'x',
  sharedState: {},
};

const scheduleInput = (overrides: Record<string, unknown> = {}) => ({
  name: 'Daily digest',
  enabled: true,
  flowId: 'flow-1',
  prompt: 'Summarize the news',
  trigger: { type: 'schedule' as const, cron: '0 9 * * *' },
  ...overrides,
});

const readRuns = (id: string) => (store.get(`planned-execution-runs/${id}`) as RunRecord[]) ?? [];
const readState = (id: string) =>
  store.get(`planned-execution-state/${id}`) as PlannedExecutionState | undefined;

describe('SchedulerService locked-encryption fire guard (#78)', () => {
  let scheduler: SchedulerService;

  beforeEach(() => {
    store.clear();
    runFlowMock.mockReset();
    runFlowMock.mockResolvedValue(completedResult);
    locked = false;
    scheduler = new SchedulerService();
  });

  it('records a skipped "encryption locked" run and never invokes the flow while locked', async () => {
    const { execution } = await scheduler.create(scheduleInput());
    locked = true;

    const record = await scheduler.fire(execution!, { kind: 'schedule', summary: 'Schedule' });

    expect(record.status).toBe('skipped');
    expect(record.error).toBe('encryption locked');
    expect(runFlowMock).not.toHaveBeenCalled();

    const runs = readRuns(execution!.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('skipped');
    expect(runs[0].error).toBe('encryption locked');
  });

  it('blocks a manual runNow while locked (same secrets)', async () => {
    const { execution } = await scheduler.create(scheduleInput());
    locked = true;

    const { record } = await scheduler.runNow(execution!.id);

    expect(record?.status).toBe('skipped');
    expect(record?.error).toBe('encryption locked');
    expect(runFlowMock).not.toHaveBeenCalled();
  });

  it('does not touch the trigger baseline (lastScheduledFireAt) on a locked skip', async () => {
    const { execution } = await scheduler.create(scheduleInput());
    // A fresh schedule primes its catch-up baseline at arm time.
    const before = readState(execution!.id)?.lastScheduledFireAt;
    expect(before).toBeTruthy();

    locked = true;
    await scheduler.fire(execution!, { kind: 'schedule', summary: 'Schedule' });

    // The skipped fire must not advance (or otherwise rewrite) the baseline,
    // so the occurrence is re-observable after unlock.
    expect(readState(execution!.id)?.lastScheduledFireAt).toBe(before);
  });

  it('fires normally once unlocked', async () => {
    const { execution } = await scheduler.create(scheduleInput());

    locked = true;
    const skipped = await scheduler.fire(execution!, { kind: 'schedule', summary: 'Schedule' });
    expect(skipped.status).toBe('skipped');
    expect(runFlowMock).not.toHaveBeenCalled();

    locked = false;
    const record = await scheduler.fire(execution!, { kind: 'schedule', summary: 'Schedule' });
    expect(record.status).toBe('completed');
    expect(runFlowMock).toHaveBeenCalledTimes(1);

    const statuses = readRuns(execution!.id).map(r => r.status).sort();
    expect(statuses).toEqual(['completed', 'skipped']);
  });
});
