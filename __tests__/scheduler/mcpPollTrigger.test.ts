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
    expect(changed.newState.lastHash).not.toBe(state.lastHash);
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
    // Old ids stay remembered — a rotating feed can't re-trigger on item 1.
    expect(withNew.newState.seenIds).toEqual(['1', '2', '3', '4']);
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
      onFire: jest.fn(),
      onError: jest.fn(),
      onSuccess: jest.fn(),
    };
    return { deps, getState: () => state };
  };

  // The tick body is async; advancing fake timers only queues it. Flush by
  // letting the microtask/promise chain settle.
  const flush = async () => {
    for (let i = 0; i < 10; i++) {
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
