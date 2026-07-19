/**
 * Tests for scheduler-global "exclusive" mode (issue #171).
 *
 * An exclusive execution may only START when the scheduler is globally idle
 * (no run in flight for ANY execution). While it runs it holds a
 * scheduler-global lock: no other trigger may start a run. If an exclusive
 * fire arrives while others are running it WAITS in a global queue and acquires
 * the lock as soon as the scheduler drains to idle. `nonExclusiveBehavior`
 * (queue | skip | error, default queue) on the exclusive execution decides what
 * OTHER (non-exclusive) fires do while it holds/awaits the lock.
 *
 * Orthogonal to the per-execution `overlapStrategy` (#121): exclusivity is
 * mutual exclusion ACROSS executions; overlap is a single execution vs itself.
 * A manual runNow and flow-event (chained) fires bypass the exclusive gate.
 * The encryption-locked guard still takes precedence over everything.
 *
 * Same harness as overlapStrategy.test.ts: storage is mocked in-memory below
 * the service, runFlow is mocked (and blockable) at the lazy-import boundary,
 * and the encryption lock helper is flippable.
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
  name: 'Exclusive test',
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

describe('SchedulerService exclusive mode (#171)', () => {
  let scheduler: SchedulerService;

  beforeEach(() => {
    store.clear();
    runFlowMock.mockReset();
    pendingRuns = [];
    locked = false;
    scheduler = new SchedulerService();
  });

  it('runs an exclusive execution immediately when the scheduler is idle', async () => {
    blockRunFlow();
    const { execution: exc } = await scheduler.create(input({ name: 'exc', exclusive: true }));

    const p = scheduler.fire(exc!, { kind: 'schedule', summary: 'e1' });
    await flush();
    expect(runFlowMock).toHaveBeenCalledTimes(1);
    expect(scheduler.isRunning(exc!.id)).toBe(true);

    pendingRuns[0](completedResult);
    const r = await p;
    expect(r.status).toBe('completed');
    // The lock is released — a fresh non-exclusive execution is not blocked.
    expect(scheduler.getStatus(exc!).exclusiveHolderId).toBeUndefined();
  });

  it('queues an exclusive fire while another execution runs, then acquires at idle', async () => {
    blockRunFlow();
    const { execution: normal } = await scheduler.create(input({ name: 'normal' }));
    const { execution: exc } = await scheduler.create(input({ name: 'exc', exclusive: true }));

    const pn = scheduler.fire(normal!, { kind: 'schedule', summary: 'n1' });
    await flush();
    expect(runFlowMock).toHaveBeenCalledTimes(1);

    const pe = scheduler.fire(exc!, { kind: 'schedule', summary: 'e1' });
    await flush();
    // Exclusive can't start while the non-exclusive run is in flight.
    expect(runFlowMock).toHaveBeenCalledTimes(1);
    expect(scheduler.isRunning(exc!.id)).toBe(false);

    pendingRuns[0](completedResult);
    await pn;
    await flush();
    // Scheduler drained to idle → the exclusive acquired the lock and ran.
    expect(runFlowMock).toHaveBeenCalledTimes(2);
    expect(scheduler.getStatus(exc!).exclusiveHolderId).toBe(exc!.id);

    pendingRuns[1](completedResult);
    const re = await pe;
    expect(re.status).toBe('completed');
  });

  it("defers non-exclusive fires while an exclusive holds the lock (behavior 'queue')", async () => {
    blockRunFlow();
    const { execution: exc } = await scheduler.create(
      input({ name: 'exc', exclusive: true, nonExclusiveBehavior: 'queue' })
    );
    const { execution: normal } = await scheduler.create(input({ name: 'normal' }));

    const pe = scheduler.fire(exc!, { kind: 'schedule', summary: 'e1' });
    await flush();
    expect(runFlowMock).toHaveBeenCalledTimes(1);

    const pn = scheduler.fire(normal!, { kind: 'schedule', summary: 'n1' });
    await flush();
    // Non-exclusive is deferred, not run, while the exclusive lock is held.
    expect(runFlowMock).toHaveBeenCalledTimes(1);
    expect(scheduler.getStatus(normal!).blockedByExclusive).toBe(true);

    pendingRuns[0](completedResult);
    await pe;
    await flush();
    // Lock released → the deferred non-exclusive fire runs.
    expect(runFlowMock).toHaveBeenCalledTimes(2);

    pendingRuns[1](completedResult);
    const rn = await pn;
    expect(rn.status).toBe('completed');
  });

  it("skips non-exclusive fires while an exclusive holds the lock (behavior 'skip')", async () => {
    blockRunFlow();
    const { execution: exc } = await scheduler.create(
      input({ name: 'exc', exclusive: true, nonExclusiveBehavior: 'skip' })
    );
    const { execution: normal } = await scheduler.create(input({ name: 'normal' }));

    const pe = scheduler.fire(exc!, { kind: 'schedule', summary: 'e1' });
    await flush();

    const rn = await scheduler.fire(normal!, { kind: 'schedule', summary: 'n1' });
    expect(rn.status).toBe('skipped');
    expect(rn.error).toContain('exclusive');
    // The exclusive is the only real run.
    expect(runFlowMock).toHaveBeenCalledTimes(1);

    pendingRuns[0](completedResult);
    await pe;
    await flush();
    // The skipped fire never ran, even after release.
    expect(runFlowMock).toHaveBeenCalledTimes(1);
  });

  it("rejects non-exclusive fires while an exclusive holds the lock (behavior 'error')", async () => {
    blockRunFlow();
    const { execution: exc } = await scheduler.create(
      input({ name: 'exc', exclusive: true, nonExclusiveBehavior: 'error' })
    );
    const { execution: normal } = await scheduler.create(input({ name: 'normal' }));

    const pe = scheduler.fire(exc!, { kind: 'schedule', summary: 'e1' });
    await flush();

    const rn = await scheduler.fire(normal!, { kind: 'schedule', summary: 'n1' });
    expect(rn.status).toBe('error');
    expect(rn.error).toContain('exclusive');
    expect(runFlowMock).toHaveBeenCalledTimes(1);

    pendingRuns[0](completedResult);
    await pe;
  });

  it('serializes two exclusive executions fired together (only one holds the lock)', async () => {
    blockRunFlow();
    const { execution: e1 } = await scheduler.create(input({ name: 'e1', exclusive: true }));
    const { execution: e2 } = await scheduler.create(input({ name: 'e2', exclusive: true }));

    const p1 = scheduler.fire(e1!, { kind: 'schedule', summary: 'x1' });
    await flush();
    const p2 = scheduler.fire(e2!, { kind: 'schedule', summary: 'x2' });
    await flush();
    // e1 holds the lock; e2 waits.
    expect(runFlowMock).toHaveBeenCalledTimes(1);
    expect(scheduler.getStatus(e1!).exclusiveHolderId).toBe(e1!.id);

    pendingRuns[0](completedResult);
    await p1;
    await flush();
    // e1 released → e2 acquired.
    expect(runFlowMock).toHaveBeenCalledTimes(2);
    expect(scheduler.getStatus(e2!).exclusiveHolderId).toBe(e2!.id);

    pendingRuns[1](completedResult);
    const r2 = await p2;
    expect(r2.status).toBe('completed');
  });

  it('gives a waiting exclusive the idle window before a blocked non-exclusive backlog', async () => {
    blockRunFlow();
    const { execution: normal } = await scheduler.create(
      input({ name: 'normal', overlapStrategy: 'parallel' })
    );
    const { execution: exc } = await scheduler.create(
      input({ name: 'exc', exclusive: true, nonExclusiveBehavior: 'queue' })
    );
    const { execution: other } = await scheduler.create(input({ name: 'other' }));

    const pn = scheduler.fire(normal!, { kind: 'schedule', summary: 'n1' });
    await flush();
    expect(runFlowMock).toHaveBeenCalledTimes(1);

    // Exclusive fires while 'normal' runs → waits for idle.
    const pe = scheduler.fire(exc!, { kind: 'schedule', summary: 'e1' });
    await flush();
    // A non-exclusive fires while the exclusive is WAITING → deferred (the
    // waiting exclusive counts as "active" so the scheduler drains toward idle).
    const po = scheduler.fire(other!, { kind: 'schedule', summary: 'o1' });
    await flush();
    expect(runFlowMock).toHaveBeenCalledTimes(1);

    pendingRuns[0](completedResult);
    await pn;
    await flush();
    // Idle window went to the exclusive, NOT the blocked non-exclusive.
    expect(runFlowMock).toHaveBeenCalledTimes(2);
    expect(scheduler.getStatus(exc!).exclusiveHolderId).toBe(exc!.id);

    pendingRuns[1](completedResult);
    await pe;
    await flush();
    // Exclusive released → the blocked non-exclusive finally runs.
    expect(runFlowMock).toHaveBeenCalledTimes(3);

    pendingRuns[2](completedResult);
    const ro = await po;
    expect(ro.status).toBe('completed');
  });

  it('the encryption-locked guard takes precedence over exclusive gating', async () => {
    const { execution: exc } = await scheduler.create(input({ exclusive: true }));
    locked = true;

    const record = await scheduler.fire(exc!, { kind: 'schedule', summary: 'S' });
    expect(record.status).toBe('skipped');
    expect(record.error).toBe('encryption locked');
    expect(runFlowMock).not.toHaveBeenCalled();
  });

  it('caps the exclusive wait queue and drops fires beyond it', async () => {
    blockRunFlow();
    const { execution: normal } = await scheduler.create(
      input({ name: 'normal', overlapStrategy: 'parallel' })
    );
    const { execution: exc } = await scheduler.create(input({ name: 'exc', exclusive: true }));

    // Keep the scheduler busy so no exclusive fire can acquire the lock.
    void scheduler.fire(normal!, { kind: 'schedule', summary: 'busy' });
    await flush();
    for (let i = 0; i < 50; i++) {
      void scheduler.fire(exc!, { kind: 'schedule', summary: `e${i}` });
    }
    const overflow = await scheduler.fire(exc!, { kind: 'schedule', summary: 'overflow' });
    expect(overflow.status).toBe('skipped');
    expect(overflow.error).toContain('Exclusive wait queue full');
    // Only the one genuinely running (non-exclusive) fire invoked runFlow.
    expect(runFlowMock).toHaveBeenCalledTimes(1);
  });

  it('releases the lock when the exclusive run finishes (a later non-exclusive is not blocked)', async () => {
    blockRunFlow();
    const { execution: exc } = await scheduler.create(input({ name: 'exc', exclusive: true }));
    const { execution: normal } = await scheduler.create(input({ name: 'normal' }));

    const pe = scheduler.fire(exc!, { kind: 'schedule', summary: 'e1' });
    await flush();
    pendingRuns[0](completedResult);
    await pe;
    await flush();

    // Lock cleared → a non-exclusive fire runs straight away.
    const pn = scheduler.fire(normal!, { kind: 'schedule', summary: 'n1' });
    await flush();
    expect(runFlowMock).toHaveBeenCalledTimes(2);
    expect(scheduler.getStatus(normal!).blockedByExclusive).toBe(false);

    pendingRuns[1](completedResult);
    const rn = await pn;
    expect(rn.status).toBe('completed');
  });

  it('does NOT gate flow-event (chained) fires — they run despite the exclusive lock', async () => {
    blockRunFlow();
    const { execution: exc } = await scheduler.create(
      input({ name: 'exc', exclusive: true, nonExclusiveBehavior: 'queue' })
    );
    const { execution: chained } = await scheduler.create(input({ name: 'chained' }));

    const pe = scheduler.fire(exc!, { kind: 'schedule', summary: 'e1' });
    await flush();
    expect(runFlowMock).toHaveBeenCalledTimes(1);

    // A flow-event fire is emitted synchronously as another run finishes;
    // gating it could deadlock the chain, so it bypasses the exclusive lock.
    const pc = scheduler.fire(chained!, { kind: 'flow-event', summary: 'chain', chainDepth: 1 });
    await flush();
    expect(runFlowMock).toHaveBeenCalledTimes(2);

    pendingRuns[0](completedResult);
    pendingRuns[1](completedResult);
    const [re, rc] = await Promise.all([pe, pc]);
    expect(re.status).toBe('completed');
    expect(rc.status).toBe('completed');
  });

  it('a manual runNow bypasses the exclusive lock (hard override)', async () => {
    blockRunFlow();
    const { execution: exc } = await scheduler.create(
      input({ name: 'exc', exclusive: true, nonExclusiveBehavior: 'queue' })
    );
    const { execution: normal } = await scheduler.create(input({ name: 'normal' }));

    const pe = scheduler.fire(exc!, { kind: 'schedule', summary: 'e1' });
    await flush();
    expect(runFlowMock).toHaveBeenCalledTimes(1);

    // Explicit user action: starts immediately despite the exclusive lock.
    const manual = scheduler.runNow(normal!.id);
    await flush();
    expect(runFlowMock).toHaveBeenCalledTimes(2);

    pendingRuns[0](completedResult);
    pendingRuns[1](completedResult);
    await pe;
    const { record } = await manual;
    expect(record?.status).toBe('completed');
  });

  it('rejects an invalid exclusive / nonExclusiveBehavior at create time', async () => {
    const bad = await scheduler.create(
      input({ exclusive: 'yes' as unknown as boolean })
    );
    expect(bad.execution).toBeUndefined();
    expect(bad.error).toMatch(/Exclusive/);

    const bad2 = await scheduler.create(
      input({ exclusive: true, nonExclusiveBehavior: 'nope' as unknown as 'queue' })
    );
    expect(bad2.execution).toBeUndefined();
    expect(bad2.error).toMatch(/other triggers/);
  });

  it('cancels exclusive waiters on global pause (awaiter resolves skipped)', async () => {
    blockRunFlow();
    const { execution: normal } = await scheduler.create(input({ name: 'normal' }));
    const { execution: exc } = await scheduler.create(input({ name: 'exc', exclusive: true }));

    const pn = scheduler.fire(normal!, { kind: 'schedule', summary: 'n1' });
    await flush();
    const pe = scheduler.fire(exc!, { kind: 'schedule', summary: 'e1' });
    await flush();
    // exc is waiting for idle.
    expect(runFlowMock).toHaveBeenCalledTimes(1);

    await scheduler.setPaused(true);
    const re = await pe;
    expect(re.status).toBe('skipped');
    expect(re.error).toBe('scheduler paused');

    pendingRuns[0](completedResult);
    await pn;
    await flush();
    // The cancelled exclusive waiter never ran.
    expect(runFlowMock).toHaveBeenCalledTimes(1);
  });
});
