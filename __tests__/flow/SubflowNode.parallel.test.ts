/**
 * Tests for parallel (fan-out/join) SubflowNode execution (issue #102).
 *
 * runFlow and the flow service are mocked so no real flow engine runs. What's
 * pinned here is the node's fan-out contract: bounded concurrency, deterministic
 * child-order join, both error strategies, same-depth siblings (concurrency does
 * not deepen the call tree), lane-separable folded events with no raw run:done
 * leaking onto the parent channel, and byte-for-byte-unchanged single-child
 * behavior.
 */

const runFlowMock = jest.fn();
jest.mock('@/backend/execution/flow/runFlow', () => ({
  runFlow: (...a: unknown[]) => runFlowMock(...a),
}));

jest.mock('@/backend/services/flow/index', () => ({
  flowService: { getFlow: jest.fn(async (id: string) => ({ id, name: `flow-${id}` })) },
}));

import { SubflowNode } from '@/backend/execution/flow/nodes/SubflowNode';
import { ERROR_ACTION } from '@/backend/execution/flow/types';
import type { SharedState, SubflowNodeParams } from '@/backend/execution/flow/types';

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

function makeShared(overrides: Record<string, unknown> = {}): SharedState {
  return {
    conversationId: 'conv-1',
    runDepth: 0,
    messages: [],
    trackingInfo: { nodeExecutionTracker: [] },
    ...overrides,
  } as unknown as SharedState;
}

function makeParams(properties: Record<string, unknown>): SubflowNodeParams {
  return {
    id: 'sub-1',
    type: 'subflow',
    // promptTemplate (no inputMode) => 'isolated', so the fan-out input is a
    // single deterministic prompt fed to every lane.
    properties: { promptTemplate: 'GO', ...properties },
  } as unknown as SubflowNodeParams;
}

/** A node wired with one successor so post() has somewhere to hand off. */
function makeNode(): SubflowNode {
  const node = new SubflowNode();
  (node as unknown as { successors: Record<string, unknown> }).successors = { NEXT: {} };
  return node;
}

beforeEach(() => {
  runFlowMock.mockReset();
});

describe('SubflowNode fan-out (issue #102)', () => {
  it('runs lanes through a bounded worker pool (concurrencyLimit)', async () => {
    let active = 0;
    let maxActive = 0;
    runFlowMock.mockImplementation(async ({ flowId }: { flowId: string }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(25);
      active -= 1;
      return { status: 'completed', outputText: `out-${flowId}` };
    });

    const node = makeNode();
    const params = makeParams({ parallelSubflowIds: ['f0', 'f1', 'f2', 'f3', 'f4'], concurrencyLimit: 2 });
    const prep = await node.prep(makeShared(), params);
    const exec = await node.execCore(prep);

    expect(runFlowMock).toHaveBeenCalledTimes(5);
    expect(maxActive).toBeLessThanOrEqual(2); // bounded
    expect(maxActive).toBeGreaterThan(1); // genuinely concurrent
    expect(exec.success).toBe(true);
    expect(exec.lanes).toHaveLength(5);
  });

  it('joins lane outputs in child order regardless of completion order', async () => {
    runFlowMock.mockImplementation(async ({ flowId }: { flowId: string }) => {
      const d = flowId === 'a' ? 40 : flowId === 'b' ? 5 : 20; // 'b' finishes first
      await delay(d);
      return { status: 'completed', outputText: `OUT_${flowId}` };
    });

    const node = makeNode();
    const prep = await node.prep(
      makeShared(),
      makeParams({ parallelSubflowIds: ['a', 'b', 'c'], joinSeparator: '|', concurrencyLimit: 3 }),
    );
    const exec = await node.execCore(prep);

    expect(exec.outputText).toBe('OUT_a|OUT_b|OUT_c'); // child order, not completion order
    expect(exec.partial).toBe(false);
  });

  it('collect-all: folds successes plus a failure summary and still succeeds (partial)', async () => {
    runFlowMock.mockImplementation(async ({ flowId }: { flowId: string }) => {
      if (flowId === 'b') {
        return { status: 'error', outputText: '', error: { message: 'boom-b', statusCode: 500 } };
      }
      return { status: 'completed', outputText: `OUT_${flowId}` };
    });

    const node = makeNode();
    const params = makeParams({
      parallelSubflowIds: ['a', 'b', 'c'],
      joinSeparator: '\n',
      errorStrategy: 'collect-all',
      concurrencyLimit: 3,
    });
    const prep = await node.prep(makeShared(), params);
    const exec = await node.execCore(prep);

    expect(exec.success).toBe(true);
    expect(exec.partial).toBe(true);
    expect(exec.outputText).toContain('OUT_a');
    expect(exec.outputText).toContain('OUT_c');
    expect(exec.outputText).not.toContain('OUT_b');
    expect(exec.outputText).toContain('boom-b'); // failure summary

    const shared = makeShared();
    const action = await node.post(prep, exec, shared, params);
    expect(action).toBe('NEXT'); // still hands off on partial success
    expect(shared.lastResponse).toBe(exec.outputText);
  });

  it('fail-fast: the first lane error fails the whole node (ERROR_ACTION), stopping further lanes', async () => {
    runFlowMock.mockImplementation(async ({ flowId }: { flowId: string }) => {
      if (flowId === 'a') {
        return { status: 'error', outputText: '', error: { message: 'boom-a', statusCode: 500 } };
      }
      await delay(20);
      return { status: 'completed', outputText: `OUT_${flowId}` };
    });

    const node = makeNode();
    const params = makeParams({
      parallelSubflowIds: ['a', 'b', 'c'],
      errorStrategy: 'fail-fast',
      concurrencyLimit: 1, // sequential so 'a' fails before b/c start
    });
    const prep = await node.prep(makeShared(), params);
    const exec = await node.execCore(prep);

    expect(exec.success).toBe(false);
    expect(exec.error).toContain('boom-a');
    expect(runFlowMock).toHaveBeenCalledTimes(1); // b and c never started

    const shared = makeShared();
    const action = await node.post(prep, exec, shared, params);
    expect(action).toBe(ERROR_ACTION);
  });

  it('fails when every lane fails', async () => {
    runFlowMock.mockResolvedValue({ status: 'error', outputText: '', error: { message: 'nope', statusCode: 500 } });
    const node = makeNode();
    const params = makeParams({ parallelSubflowIds: ['a', 'b'], errorStrategy: 'collect-all', concurrencyLimit: 2 });
    const prep = await node.prep(makeShared(), params);
    const exec = await node.execCore(prep);
    expect(exec.success).toBe(false);
    expect(exec.error).toContain('All parallel subflows failed');
  });

  it('runs every lane at the same depth (concurrency does not deepen the call tree)', async () => {
    runFlowMock.mockResolvedValue({ status: 'completed', outputText: 'x' });
    const node = makeNode();
    const prep = await node.prep(makeShared({ runDepth: 2 }), makeParams({ parallelSubflowIds: ['a', 'b'] }));
    await node.execCore(prep);

    const depths = runFlowMock.mock.calls.map((c) => (c[0] as { depth: number }).depth);
    expect(depths).toEqual([3, 3]); // parent runDepth 2 -> +1; siblings not nested
  });

  it('stamps distinct laneIndex/laneCount on folded events and never leaks a raw run:done', async () => {
    runFlowMock.mockImplementation(
      async ({ flowId, emit }: { flowId: string; emit?: (e: Record<string, unknown>) => void }) => {
        emit?.({ type: 'run:start', flowId });
        emit?.({ type: 'message', message: { role: 'assistant', content: `m-${flowId}`, id: 'x', timestamp: 1 } });
        emit?.({ type: 'run:done', status: 'completed' });
        return { status: 'completed', outputText: `OUT_${flowId}` };
      },
    );

    const events: Array<Record<string, unknown>> = [];
    const node = makeNode();
    const shared = makeShared({ emit: (e: Record<string, unknown>) => events.push(e) });
    const prep = await node.prep(shared, makeParams({ parallelSubflowIds: ['a', 'b'], concurrencyLimit: 2 }));
    await node.execCore(prep);

    // Raw run boundaries are translated per lane; a raw run:done on the parent
    // channel would kill the parent SSE stream.
    expect(events.some((e) => e.type === 'run:done')).toBe(false);
    expect(events.some((e) => e.type === 'run:start')).toBe(false);

    const starts = events.filter((e) => e.type === 'subflow:start');
    expect(starts.map((e) => e.laneIndex).sort()).toEqual([0, 1]);
    expect(starts.every((e) => e.laneCount === 2)).toBe(true);

    const msgs = events.filter((e) => e.type === 'message');
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.every((e) => typeof e.laneIndex === 'number')).toBe(true);
  });
});

describe('SubflowNode single-child path (regression, unchanged)', () => {
  it('runs one child, folds output, hands off; folded events carry no lane fields', async () => {
    runFlowMock.mockImplementation(
      async ({ emit }: { emit?: (e: Record<string, unknown>) => void }) => {
        emit?.({ type: 'run:start', flowId: 'solo' });
        emit?.({ type: 'run:done', status: 'completed' });
        return { status: 'completed', outputText: 'SOLO_OUT' };
      },
    );

    const events: Array<Record<string, unknown>> = [];
    const node = makeNode();
    const shared = makeShared({ emit: (e: Record<string, unknown>) => events.push(e) });
    const params = makeParams({ subflowId: 'solo' });
    const prep = await node.prep(shared, params);
    const exec = await node.execCore(prep);

    expect(runFlowMock).toHaveBeenCalledTimes(1);
    expect(exec.success).toBe(true);
    expect(exec.outputText).toBe('SOLO_OUT');
    expect(exec.lanes).toBeUndefined();

    const action = await node.post(prep, exec, shared, params);
    expect(action).toBe('NEXT');
    expect(shared.lastResponse).toBe('SOLO_OUT');

    // Single-lane events must be byte-for-byte as before: no laneIndex/laneCount.
    expect(events.every((e) => e.laneIndex === undefined && e.laneCount === undefined)).toBe(true);
    expect(events.some((e) => e.type === 'subflow:start')).toBe(true);
    expect(events.some((e) => e.type === 'run:done')).toBe(false);
  });

  it('single-child failure -> ERROR_ACTION', async () => {
    runFlowMock.mockResolvedValue({ status: 'error', outputText: '', error: { message: 'solo-fail', statusCode: 500 } });
    const node = makeNode();
    const shared = makeShared();
    const params = makeParams({ subflowId: 'solo' });
    const prep = await node.prep(shared, params);
    const exec = await node.execCore(prep);
    expect(exec.success).toBe(false);
    const action = await node.post(prep, exec, shared, params);
    expect(action).toBe(ERROR_ACTION);
  });
});
