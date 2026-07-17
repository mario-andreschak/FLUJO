/**
 * Tests for the configurable trigger overlap behavior (issue #121).
 *
 * When a trigger fires while a previous run for the SAME execution is still in
 * flight, `overlapStrategy` decides what happens:
 *   - 'skip'     (default, historical) — record a `skipped` run, don't run.
 *   - 'error'    — record an `error` run, don't run.
 *   - 'parallel' — run concurrently; overlapping runs are allowed.
 *   - 'queue'    — defer the fire (FIFO) and run it once the current one ends,
 *                  bounded by a queue-depth cap.
 * A manual `runNow` always bypasses the policy. The encryption-locked guard
 * still takes precedence over every strategy.
 *
 * Storage is mocked in-memory (below the service, so envelope/ring-buffer/state
 * logic runs through real code); runFlow is mocked at the boundary the service
 * lazy-imports; and the encryption lock helper is mocked so we can flip it.
 */
import { SchedulerService } from '@/backend/services/scheduler';
import type { RunRecord } from '@/shared/types/plannedExecution';

// --- in-memory storage ----------------------------------------------------

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

// --- runFlow mock (blockable) ---------------------------------------------

/** Resolvers for each in-flight runFlow call, so a test can control timing. */
let pendingRuns: Array<(result: unknown) => void> = [];
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
  usage: undefined,
  messages: [],
  conversationId: 'x',
  sharedState: {},
};

const input = (overrides: Record<string, unknown> = {}) => ({
  name: 'Overlap test',
  enabled: true,
  flowId: 'flow-1',
  prompt: 'do the thing',
  trigger: { type: 'schedule' as const, cron: '0 9 * * *' },
  ...overrides,
});

const readRuns = (id: string) => (store.get(`planned-execution-runs/${id}`) as RunRecord[]) ?? [];

/** Let queued microtasks + the service's short async hops settle. */
const flush = () => new Promise(resolve => setTimeout(resolve, 20));

/** Make runFlow hang until the test releases the Nth call via pendingRuns[n]. */
const blockRunFlow = () =>
  runFlowMock.mockImplementation(
    () => new Promise(resolve => pendingRuns.push(resolve as (r: unknown) => void))
  );

describe('SchedulerService overlap strategy (#121)', () => {
  let scheduler: SchedulerService;

  beforeEach(() => {
    store.clear();
    runFlowMock.mockReset();
    pendingRuns = [];
    locked = false;
    scheduler = new SchedulerService();
  });

  it('defaults to skip (no overlapStrategy set) — records "Previous run still in progress"', async () => {
    blockRunFlow();
    const { execution } = await scheduler.create(input());

    const p1 = scheduler.fire(execution!, { kind: 'schedule', summary: 'first' });
    await flush();
    expect(scheduler.isRunning(execution!.id)).toBe(true);
    expect(runFlowMock).toHaveBeenCalledTimes(1);

    const second = await scheduler.fire(execution!, { kind: 'schedule', summary: 'second' });
    expect(second.status).toBe('skipped');
    expect(second.error).toBe('Previous run still in progress');
    // Still only one actual run.
    expect(runFlowMock).toHaveBeenCalledTimes(1);

    pendingRuns[0](completedResult);
    const first = await p1;
    expect(first.status).toBe('completed');
    expect(scheduler.isRunning(execution!.id)).toBe(false);
  });

  it("'error' records an error run for the overlapping fire and does not run it", async () => {
    blockRunFlow();
    const { execution } = await scheduler.create(input({ overlapStrategy: 'error' }));

    const p1 = scheduler.fire(execution!, { kind: 'schedule', summary: 'first' });
    await flush();

    const second = await scheduler.fire(execution!, { kind: 'schedule', summary: 'second' });
    expect(second.status).toBe('error');
    expect(second.error).toBe('Overlapping run rejected (overlapStrategy=error)');
    expect(runFlowMock).toHaveBeenCalledTimes(1);

    pendingRuns[0](completedResult);
    await p1;

    const statuses = readRuns(execution!.id).map(r => r.status).sort();
    expect(statuses).toEqual(['completed', 'error']);
  });

  it("'parallel' runs concurrent fires and tracks them all (earliest runningSince)", async () => {
    blockRunFlow();
    const { execution } = await scheduler.create(input({ overlapStrategy: 'parallel' }));

    const p1 = scheduler.fire(execution!, { kind: 'schedule', summary: 'first' });
    await flush();
    const p2 = scheduler.fire(execution!, { kind: 'schedule', summary: 'second' });
    await flush();

    // Both runs are actually in flight.
    expect(runFlowMock).toHaveBeenCalledTimes(2);
    const status = scheduler.getStatus(execution!);
    expect(status.running).toBe(true);
    expect(status.runningSince).toBeTruthy();

    pendingRuns[0](completedResult);
    pendingRuns[1](completedResult);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe('completed');
    expect(r2.status).toBe('completed');
    // Both cleaned up.
    expect(scheduler.isRunning(execution!.id)).toBe(false);
    expect(readRuns(execution!.id)).toHaveLength(2);
  });

  it("'queue' defers overlapping fires and runs them FIFO after the current one", async () => {
    blockRunFlow();
    const { execution } = await scheduler.create(input({ overlapStrategy: 'queue' }));

    const p1 = scheduler.fire(execution!, { kind: 'schedule', summary: 'first' });
    await flush();
    const p2 = scheduler.fire(execution!, { kind: 'schedule', summary: 'second' });
    const p3 = scheduler.fire(execution!, { kind: 'schedule', summary: 'third' });
    await flush();

    // Only the first is running; the other two are queued.
    expect(runFlowMock).toHaveBeenCalledTimes(1);

    pendingRuns[0](completedResult);
    const r1 = await p1;
    await flush();
    // Second dequeued and now running.
    expect(runFlowMock).toHaveBeenCalledTimes(2);

    pendingRuns[1](completedResult);
    const r2 = await p2;
    await flush();
    // Third dequeued and now running.
    expect(runFlowMock).toHaveBeenCalledTimes(3);

    pendingRuns[2](completedResult);
    const r3 = await p3;

    expect(r1.triggerSummary).toBe('first');
    expect(r2.triggerSummary).toBe('second');
    expect(r3.triggerSummary).toBe('third');
    [r1, r2, r3].forEach(r => expect(r.status).toBe('completed'));
    expect(scheduler.isRunning(execution!.id)).toBe(false);
  });

  it("'queue' honors the queue-depth cap and drops fires beyond it", async () => {
    blockRunFlow();
    const { execution } = await scheduler.create(input({ overlapStrategy: 'queue' }));

    // First fire starts running; then fill the queue to its cap (50).
    void scheduler.fire(execution!, { kind: 'schedule', summary: 'running' });
    await flush();
    for (let i = 0; i < 50; i++) {
      void scheduler.fire(execution!, { kind: 'schedule', summary: `q${i}` });
    }
    // The 51st queued fire exceeds the cap and is dropped (recorded skipped).
    const overflow = await scheduler.fire(execution!, { kind: 'schedule', summary: 'overflow' });
    expect(overflow.status).toBe('skipped');
    expect(overflow.error).toContain('Overlap queue full');
    // Only the one genuinely running fire has invoked runFlow.
    expect(runFlowMock).toHaveBeenCalledTimes(1);
  });

  it('a manual runNow bypasses the overlap policy (runs even with strategy "skip")', async () => {
    blockRunFlow();
    const { execution } = await scheduler.create(input({ overlapStrategy: 'skip' }));

    const p1 = scheduler.fire(execution!, { kind: 'schedule', summary: 'scheduled' });
    await flush();
    expect(scheduler.isRunning(execution!.id)).toBe(true);

    const manual = scheduler.runNow(execution!.id);
    await flush();
    // The manual run started concurrently despite the 'skip' policy.
    expect(runFlowMock).toHaveBeenCalledTimes(2);

    pendingRuns[0](completedResult);
    pendingRuns[1](completedResult);
    await p1;
    const { record } = await manual;
    expect(record?.status).toBe('completed');
  });

  it('the encryption-locked guard takes precedence over the overlap strategy', async () => {
    const { execution } = await scheduler.create(input({ overlapStrategy: 'error' }));
    locked = true;

    const record = await scheduler.fire(execution!, { kind: 'schedule', summary: 'S' });

    // Not an overlap 'error' — the encryption guard wins and skips.
    expect(record.status).toBe('skipped');
    expect(record.error).toBe('encryption locked');
    expect(runFlowMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid overlapStrategy at create time', async () => {
    const result = await scheduler.create(
      input({ overlapStrategy: 'sometimes' as unknown as 'skip' })
    );
    expect(result.execution).toBeUndefined();
    expect(result.error).toMatch(/Overlap strategy/);
  });
});
