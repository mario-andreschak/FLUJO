/**
 * Tests for the MCP polling trigger: the pure evaluators (on-change hashing,
 * new-items dedup with priming/caps/restart-persistence) and the polling loop
 * itself (prime-without-fire, fire-on-change, error backoff, dispose) via
 * injected dependencies — no MCP layer involved.
 */
import {
  stableStringify,
  hashResult,
  getPath,
  evaluateOnChange,
  evaluateNewItems,
} from '@/backend/services/scheduler/triggers/pollEvaluators';
import { armMcpPoll, McpPollDeps } from '@/backend/services/scheduler/triggers/mcpPoll';
import type { PlannedExecutionState } from '@/shared/types/plannedExecution';

describe('stableStringify / hashResult', () => {
  it('is independent of object key order (nested)', () => {
    const a = { x: 1, nested: { b: 2, a: [{ z: 1, y: 2 }] } };
    const b = { nested: { a: [{ y: 2, z: 1 }], b: 2 }, x: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(hashResult(a)).toBe(hashResult(b));
  });

  it('distinguishes genuinely different values', () => {
    expect(hashResult({ a: 1 })).not.toBe(hashResult({ a: 2 }));
  });
});

describe('getPath', () => {
  const value = { content: [{ items: [{ id: 7 }] }] };
  it.each([
    ['', value],
    ['content.0.items', [{ id: 7 }]],
    ['content.0.items.0.id', 7],
    ['content.9.items', undefined],
    ['nope.deeper', undefined],
  ])('%s', (dotPath, expected) => {
    expect(getPath(value, dotPath as string)).toEqual(expected);
  });
});

describe('evaluateOnChange', () => {
  it('primes on first poll, stays quiet on same result, fires on change', () => {
    const primed = evaluateOnChange({ v: 1 }, {});
    expect(primed.fire).toBe(false);
    expect(primed.newState.lastHash).toBeTruthy();

    const state: PlannedExecutionState = { lastHash: primed.newState.lastHash };
    expect(evaluateOnChange({ v: 1 }, state).fire).toBe(false);

    const changed = evaluateOnChange({ v: 2 }, state);
    expect(changed.fire).toBe(true);
    // The new hash is held PENDING (committed only after a successful run, #75),
    // not advanced immediately.
    expect(changed.newState.lastHash).toBeUndefined();
    expect(changed.pendingState?.lastHash).toBeTruthy();
    expect(changed.pendingState?.lastHash).not.toBe(state.lastHash);
    expect(changed.summary).toBe('Tool result changed');
  });
});

describe('evaluateNewItems', () => {
  const feed = (ids: number[]) => ({ items: ids.map(id => ({ id, title: `t${id}` })) });

  it('primes without firing, then fires only for unseen ids', () => {
    const primed = evaluateNewItems(feed([1, 2]), 'items', 'id', {});
    expect(primed.fire).toBe(false);
    expect(primed.newState.seenIds).toEqual(['1', '2']);

    const state: PlannedExecutionState = { seenIds: primed.newState.seenIds };
    expect(evaluateNewItems(feed([1, 2]), 'items', 'id', state).fire).toBe(false);

    const withNew = evaluateNewItems(feed([2, 3, 4]), 'items', 'id', state);
    expect(withNew.fire).toBe(true);
    expect(withNew.summary).toBe('2 new items');
    expect((withNew.context as { newItems: Array<{ id: number }> }).newItems.map(i => i.id)).toEqual([3, 4]);
    // The merged ids are held PENDING (committed only after a successful run,
    // #75); old ids stay remembered so a rotating feed can't re-trigger item 1.
    expect(withNew.newState.seenIds).toBeUndefined();
    expect(withNew.pendingState?.seenIds).toEqual(['1', '2', '3', '4']);
  });

  it('dedups across restarts via the persisted seen-set', () => {
    // Same state object as loaded from disk after a restart.
    const state: PlannedExecutionState = { seenIds: ['1', '2'] };
    expect(evaluateNewItems(feed([1, 2]), 'items', 'id', state).fire).toBe(false);
  });

  it('reports a config error when itemsPath is not a list', () => {
    const result = evaluateNewItems({ items: 'not-a-list' }, 'items', 'id', { seenIds: [] });
    expect(result.fire).toBe(false);
    expect(result.error).toMatch(/did not resolve to a list/);
  });

  it('falls back to content hashing for items without the id field', () => {
    const items = { list: [{ name: 'a' }, { name: 'b' }] };
    const primed = evaluateNewItems(items, 'list', 'id', {});
    expect(primed.newState.seenIds).toHaveLength(2);
    expect(primed.newState.seenIds![0]).toMatch(/^hash:/);

    const again = evaluateNewItems(items, 'list', 'id', { seenIds: primed.newState.seenIds });
    expect(again.fire).toBe(false);
  });

  it('caps the seen-set at 1000 ids', () => {
    const many = feed(Array.from({ length: 1200 }, (_, i) => i));
    const primed = evaluateNewItems(many, 'items', 'id', {});
    expect(primed.newState.seenIds).toHaveLength(1000);
    // The newest ids survive the cap.
    expect(primed.newState.seenIds![999]).toBe('1199');
  });

  it('delivers all fresh items and commits them all when ≤ 50 (no overflow)', () => {
    // Primed seen-set + a poll with 30 fresh items: unchanged behavior.
    const state: PlannedExecutionState = { seenIds: ['seed'] };
    const result = evaluateNewItems(feed(Array.from({ length: 30 }, (_, i) => i)), 'items', 'id', state);
    expect(result.fire).toBe(true);
    const ctx = result.context as { newItems: unknown[]; omitted?: number };
    expect(ctx.newItems).toHaveLength(30);
    expect(ctx.omitted).toBeUndefined();
    // All 30 delivered ids are committed alongside the prior seed.
    expect(result.pendingState?.seenIds).toEqual([
      'seed',
      ...Array.from({ length: 30 }, (_, i) => String(i)),
    ]);
  });

  it('caps a burst at 50 and commits ONLY the delivered ids (overflow stays unseen, #140)', () => {
    // Primed seen-set + a burst of 120 unseen items.
    const state: PlannedExecutionState = { seenIds: ['seed'] };
    const result = evaluateNewItems(feed(Array.from({ length: 120 }, (_, i) => i)), 'items', 'id', state);
    expect(result.fire).toBe(true);
    expect(result.summary).toBe('120 new items');
    const ctx = result.context as { newItems: unknown[]; omitted?: number };
    // Only 50 delivered, 70 reported as omitted (drained later, not dropped).
    expect(ctx.newItems).toHaveLength(50);
    expect(ctx.omitted).toBe(70);
    // Seen-set gains ONLY the 50 delivered ids (0..49) on top of the prior seed.
    expect(result.pendingState?.seenIds).toEqual([
      'seed',
      ...Array.from({ length: 50 }, (_, i) => String(i)),
    ]);
    // An overflow id (e.g. 80) is NOT marked seen — so it can still be delivered.
    expect(result.pendingState?.seenIds).not.toContain('80');
  });

  it('drains a >50 backlog across successive polls without skipping any item (#140)', () => {
    const bigFeed = feed(Array.from({ length: 120 }, (_, i) => i));

    // Batch 1: deliver ids 0..49, omit 70. Commit the delivered ids into state.
    const batch1 = evaluateNewItems(bigFeed, 'items', 'id', { seenIds: [] });
    expect(batch1.fire).toBe(true);
    expect((batch1.context as { newItems: Array<{ id: number }> }).newItems.map(i => i.id)).toEqual(
      Array.from({ length: 50 }, (_, i) => i)
    );
    expect((batch1.context as { omitted?: number }).omitted).toBe(70);

    // Batch 2: with batch1 committed, deliver ids 50..99, omit 20.
    const batch2 = evaluateNewItems(bigFeed, 'items', 'id', { seenIds: batch1.pendingState!.seenIds });
    expect(batch2.fire).toBe(true);
    expect((batch2.context as { newItems: Array<{ id: number }> }).newItems.map(i => i.id)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 50)
    );
    expect((batch2.context as { omitted?: number }).omitted).toBe(20);

    // Batch 3: deliver the final ids 100..119, nothing omitted.
    const batch3 = evaluateNewItems(bigFeed, 'items', 'id', { seenIds: batch2.pendingState!.seenIds });
    expect(batch3.fire).toBe(true);
    expect((batch3.context as { newItems: Array<{ id: number }> }).newItems.map(i => i.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 100)
    );
    expect((batch3.context as { omitted?: number }).omitted).toBeUndefined();

    // Batch 4: backlog fully drained — the same feed no longer fires.
    const batch4 = evaluateNewItems(bigFeed, 'items', 'id', { seenIds: batch3.pendingState!.seenIds });
    expect(batch4.fire).toBe(false);
  });
});

describe('intervalMsToCron (legacy migration)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { intervalMsToCron } = require('@/utils/shared/cron');
  it.each([
    [5_000, '*/5 * * * * *'],
    [10_000, '*/10 * * * * *'],
    [60_000, '*/1 * * * *'],
    [5 * 60_000, '*/5 * * * *'],
    [2 * 60 * 60_000, '0 */2 * * *'],
    [undefined, '*/1 * * * *'], // no legacy value → every minute
    [0, '*/5 * * * * *'], // garbage → 5s floor
  ])('%s ms → %s', (ms, expected) => {
    expect(intervalMsToCron(ms as number | undefined)).toBe(expected);
  });
});

describe('armMcpPoll', () => {
  // 6-field croner pattern: check every second (fast under fake timers).
  const config = (overrides: Record<string, unknown> = {}) => ({
    type: 'mcp-poll' as const,
    serverName: 'srv',
    toolName: 'tool',
    args: {},
    cron: '* * * * * *',
    evaluate: { mode: 'on-change' as const },
    ...overrides,
  });
  const TICK_MS = 1100;

  const makeDeps = () => {
    let state: PlannedExecutionState = {};
    const deps: McpPollDeps = {
      callTool: jest.fn(async () => ({ success: true, data: { v: 1 } })),
      loadState: jest.fn(async () => state),
      saveState: jest.fn(async patch => { state = { ...state, ...patch }; }),
      onFire: jest.fn(async () => ({ status: 'completed' as const })),
      onError: jest.fn(),
      onSuccess: jest.fn(),
    };
    return { deps, getState: () => state };
  };

  // The tick body is async; advancing fake timers only queues it. Flush by
  // letting the microtask/promise chain settle.
  const flush = async () => {
    // Generous drain: the fire path now awaits onFire → commit → saveState, a
    // deeper microtask chain than a bare poll (#75).
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
    }
  };

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('primes on the immediate first poll, fires when the result changes', async () => {
    const { deps } = makeDeps();
    const trigger = armMcpPoll(config(), deps);
    await flush();
    expect(deps.callTool).toHaveBeenCalledTimes(1);
    expect(deps.onFire).not.toHaveBeenCalled();

    // Same result: quiet.
    jest.advanceTimersByTime(TICK_MS);
    await flush();
    expect(deps.onFire).not.toHaveBeenCalled();

    // Changed result: fire with context.
    (deps.callTool as jest.Mock).mockResolvedValue({ success: true, data: { v: 2 } });
    jest.advanceTimersByTime(TICK_MS);
    await flush();
    expect(deps.onFire).toHaveBeenCalledTimes(1);
    const payload = (deps.onFire as jest.Mock).mock.calls[0][0];
    expect(payload.summary).toContain('changed');
    expect(payload.context.server).toBe('srv');

    trigger.dispose();
  });

  it('derives a cron from a legacy intervalMs config and exposes nextRun', async () => {
    // "*/10" fires at wall-clock seconds divisible by 10 — align the clock so
    // the advances below are deterministic.
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { deps } = makeDeps();
    // Pre-cron config shape: intervalMs only. 10s → "*/10 * * * * *".
    const trigger = armMcpPoll(config({ cron: undefined, intervalMs: 10_000 }), deps);
    await flush();
    expect(deps.callTool).toHaveBeenCalledTimes(1); // priming tick

    expect(trigger.nextRun && trigger.nextRun()).toBeTruthy();

    // No tick before the derived 10s cadence…
    jest.advanceTimersByTime(9_000);
    await flush();
    expect(deps.callTool).toHaveBeenCalledTimes(1);
    // …and one after it.
    jest.advanceTimersByTime(2_000);
    await flush();
    expect(deps.callTool).toHaveBeenCalledTimes(2);
    trigger.dispose();
  });

  it('backs off after failures and reports them as trigger errors, not runs', async () => {
    const { deps } = makeDeps();
    (deps.callTool as jest.Mock).mockResolvedValue({ success: false, error: 'server down' });
    const trigger = armMcpPoll(config(), deps);
    await flush();
    expect(deps.onError).toHaveBeenCalledWith('server down');

    // Failure #1 → skip 1 check: the next tick does NOT call the tool.
    jest.advanceTimersByTime(TICK_MS);
    await flush();
    expect(deps.callTool).toHaveBeenCalledTimes(1);
    // The tick after that polls again.
    jest.advanceTimersByTime(TICK_MS);
    await flush();
    expect(deps.callTool).toHaveBeenCalledTimes(2);

    expect(deps.onFire).not.toHaveBeenCalled();
    trigger.dispose();
  });

  it('surfaces the disabled-server error as a trigger error with backoff, never a run (issue #54)', async () => {
    const { deps } = makeDeps();
    // With the disabled-server gate, mcpService.callTool rejects a disabled
    // server with this precise message instead of spawning it.
    const disabledError = "Server 'srv' is disabled. Enable it on the MCP page to use it.";
    (deps.callTool as jest.Mock).mockResolvedValue({ success: false, error: disabledError });
    const trigger = armMcpPoll(config(), deps);
    await flush();
    expect(deps.onError).toHaveBeenCalledWith(disabledError);

    // Failure #1 → skip 1 check (exponential backoff), and no run record is produced.
    jest.advanceTimersByTime(TICK_MS);
    await flush();
    expect(deps.callTool).toHaveBeenCalledTimes(1);
    expect(deps.onFire).not.toHaveBeenCalled();
    trigger.dispose();
  });

  it('reports success on quiet polls, so a startup-race error self-clears', async () => {
    const { deps } = makeDeps();
    // First tick: server still connecting (the startup race) → trigger error.
    (deps.callTool as jest.Mock).mockResolvedValueOnce({ success: false, error: 'Not connected' });
    const trigger = armMcpPoll(config(), deps);
    await flush();
    expect(deps.onError).toHaveBeenCalledWith('Not connected');
    expect(deps.onSuccess).not.toHaveBeenCalled();

    // Failure #1 skips one check; the tick after that succeeds (primes)
    // and must report success so the stale error is cleared from the card.
    jest.advanceTimersByTime(TICK_MS);
    await flush();
    jest.advanceTimersByTime(TICK_MS);
    await flush();
    expect(deps.onSuccess).toHaveBeenCalled();
    expect(deps.onFire).not.toHaveBeenCalled();
    trigger.dispose();
  });

  it('re-fires a detected change until the run completes (commit-after-success, #75)', async () => {
    const { deps, getState } = makeDeps();
    (deps.onFire as jest.Mock)
      .mockResolvedValueOnce({ status: 'error' }) // run errored
      .mockResolvedValue({ status: 'completed' }); // then succeeds
    const trigger = armMcpPoll(config(), deps);
    await flush(); // prime on { v: 1 }

    // Change: fires, but the run errors → baseline NOT advanced, failure counted.
    (deps.callTool as jest.Mock).mockResolvedValue({ success: true, data: { v: 2 } });
    jest.advanceTimersByTime(TICK_MS);
    await flush();
    expect(deps.onFire).toHaveBeenCalledTimes(1);
    expect(getState().lastHash).toBe(hashResult({ v: 1 })); // still the primed baseline
    expect(getState().pendingFailures).toBe(1);

    // Same still-unprocessed change next poll → re-fires; now completes.
    jest.advanceTimersByTime(TICK_MS);
    await flush();
    expect(deps.onFire).toHaveBeenCalledTimes(2);
    expect(getState().lastHash).toBe(hashResult({ v: 2 })); // committed after success
    expect(getState().pendingFailures).toBe(0);

    // Same result now: quiet, because the baseline finally advanced.
    jest.advanceTimersByTime(TICK_MS);
    await flush();
    expect(deps.onFire).toHaveBeenCalledTimes(2);
    trigger.dispose();
  });

  it('treats an overlap skip as "not yet done": no baseline advance, no failure counted (#75)', async () => {
    const { deps, getState } = makeDeps();
    (deps.onFire as jest.Mock).mockResolvedValue({ status: 'skipped' });
    const trigger = armMcpPoll(config(), deps);
    await flush(); // prime on { v: 1 }

    (deps.callTool as jest.Mock).mockResolvedValue({ success: true, data: { v: 2 } });
    jest.advanceTimersByTime(TICK_MS);
    await flush();
    expect(deps.onFire).toHaveBeenCalledTimes(1);
    // Overlap window: nothing consumed, and it doesn't burn the retry budget.
    expect(getState().lastHash).toBe(hashResult({ v: 1 }));
    expect(getState().pendingFailures ?? 0).toBe(0);
    trigger.dispose();
  });

  it('gives up after 3 consecutive failed deliveries and drops the change (#75)', async () => {
    const { deps, getState } = makeDeps();
    (deps.onFire as jest.Mock).mockResolvedValue({ status: 'error' });
    const trigger = armMcpPoll(config(), deps);
    await flush(); // prime on { v: 1 }

    (deps.callTool as jest.Mock).mockResolvedValue({ success: true, data: { v: 2 } });
    for (let i = 0; i < 3; i++) {
      jest.advanceTimersByTime(TICK_MS);
      await flush();
    }
    expect(deps.onFire).toHaveBeenCalledTimes(3);
    // On the 3rd failure the baseline is committed anyway to stop the loop.
    expect(getState().lastHash).toBe(hashResult({ v: 2 }));
    expect(getState().pendingFailures).toBe(0);
    expect(deps.onError).toHaveBeenCalledWith(expect.stringContaining('failed to process it 3'));

    // The dropped change no longer re-fires.
    const firedSoFar = (deps.onFire as jest.Mock).mock.calls.length;
    jest.advanceTimersByTime(TICK_MS);
    await flush();
    expect(deps.onFire).toHaveBeenCalledTimes(firedSoFar);
    trigger.dispose();
  });

  it('stops polling after dispose', async () => {
    const { deps } = makeDeps();
    const trigger = armMcpPoll(config(), deps);
    await flush();
    trigger.dispose();
    jest.advanceTimersByTime(5 * TICK_MS);
    await flush();
    expect(deps.callTool).toHaveBeenCalledTimes(1);
  });
});
