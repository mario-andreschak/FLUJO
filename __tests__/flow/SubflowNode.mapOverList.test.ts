/**
 * Tests for map-over-list (for-each) SubflowNode execution (Tier 2a).
 *
 * runFlow and the flow service are mocked so no real flow engine runs. What's
 * pinned here is the map contract: the resolved input is split into items, the
 * SINGLE child flow is run once per item with that item's OWN input, and the
 * per-item outputs are joined in item order through the SAME bounded pool the
 * fan-out path (issue #102) already uses. Both error strategies, sequential
 * ordering, the same-depth guard, and the empty-list "nothing to map" result are
 * covered, plus a regression that the fan-out path still shares one input.
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

/** A map node: a single child (subflowId) + mapOverList. The promptTemplate (no
 *  inputMode => isolated) is the list that gets split into per-item inputs. */
function makeParams(properties: Record<string, unknown>): SubflowNodeParams {
  return {
    id: 'sub-1',
    type: 'subflow',
    properties: { subflowId: 'child', mapOverList: true, ...properties },
  } as unknown as SubflowNodeParams;
}

function makeNode(): SubflowNode {
  const node = new SubflowNode();
  (node as unknown as { successors: Record<string, unknown> }).successors = { NEXT: {} };
  return node;
}

/** The `prompt` passed to each runFlow call, in call order. */
function calledPrompts(): string[] {
  return runFlowMock.mock.calls.map((c) => (c[0] as { prompt?: string }).prompt ?? '');
}

beforeEach(() => {
  runFlowMock.mockReset();
});

describe('SubflowNode map-over-list (Tier 2a)', () => {
  it('json-array: runs the child once per element, each with a DISTINCT prompt, joined in item order', async () => {
    runFlowMock.mockImplementation(async ({ prompt }: { prompt: string }) => ({
      status: 'completed',
      outputText: `OUT[${prompt}]`,
    }));

    const node = makeNode();
    const params = makeParams({ promptTemplate: JSON.stringify(['a', 'b', 'c']), joinSeparator: '|', concurrencyLimit: 3 });
    const prep = await node.prep(makeShared(), params);
    const exec = await node.execCore(prep);

    expect(runFlowMock).toHaveBeenCalledTimes(3);
    expect(calledPrompts()).toEqual(['a', 'b', 'c']); // one item per lane, distinct
    // Every lane targets the SAME single child flow.
    expect(runFlowMock.mock.calls.every((c) => (c[0] as { flowId: string }).flowId === 'child')).toBe(true);
    expect(exec.success).toBe(true);
    expect(exec.outputText).toBe('OUT[a]|OUT[b]|OUT[c]'); // item order
  });

  it('json-array: object elements are re-stringified into each item prompt', async () => {
    runFlowMock.mockResolvedValue({ status: 'completed', outputText: 'x' });
    const node = makeNode();
    const params = makeParams({ promptTemplate: JSON.stringify([{ file: 'a.ts' }, { file: 'b.ts' }]) });
    const prep = await node.prep(makeShared(), params);
    await node.execCore(prep);

    expect(calledPrompts()).toEqual(['{"file":"a.ts"}', '{"file":"b.ts"}']);
  });

  it('lines: splits on newlines and drops blank lines', async () => {
    runFlowMock.mockResolvedValue({ status: 'completed', outputText: 'x' });
    const node = makeNode();
    const params = makeParams({ itemSplit: 'lines', promptTemplate: 'one\n\n  \ntwo\n three \n' });
    const prep = await node.prep(makeShared(), params);
    await node.execCore(prep);

    expect(calledPrompts()).toEqual(['one', 'two', 'three']); // trimmed, blanks dropped
  });

  it('empty list => clean "nothing to map" result, no child run, still hands off', async () => {
    const node = makeNode();
    const params = makeParams({ promptTemplate: '[]' });
    const prep = await node.prep(makeShared(), params);
    const exec = await node.execCore(prep);

    expect(runFlowMock).not.toHaveBeenCalled();
    expect(exec.success).toBe(true);
    expect(exec.outputText).toBe('');

    const shared = makeShared();
    const action = await node.post(prep, exec, shared, params);
    expect(action).toBe('NEXT');
    expect(shared.lastResponse).toBe('');
  });

  it('invalid json (not an array) => nothing to map, no child run', async () => {
    const node = makeNode();
    const params = makeParams({ promptTemplate: 'not json at all' });
    const prep = await node.prep(makeShared(), params);
    const exec = await node.execCore(prep);
    expect(runFlowMock).not.toHaveBeenCalled();
    expect(exec.success).toBe(true);
  });

  it('runs items concurrently through the bounded pool by default', async () => {
    let active = 0;
    let maxActive = 0;
    runFlowMock.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(25);
      active -= 1;
      return { status: 'completed', outputText: 'x' };
    });

    const node = makeNode();
    const params = makeParams({ promptTemplate: JSON.stringify(['a', 'b', 'c', 'd', 'e']), concurrencyLimit: 2 });
    const prep = await node.prep(makeShared(), params);
    await node.execCore(prep);

    expect(runFlowMock).toHaveBeenCalledTimes(5);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBeGreaterThan(1); // genuinely concurrent
  });

  it('sequential:true => one item at a time (maxActive === 1), order preserved', async () => {
    let active = 0;
    let maxActive = 0;
    runFlowMock.mockImplementation(async ({ prompt }: { prompt: string }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(10);
      active -= 1;
      return { status: 'completed', outputText: `OUT_${prompt}` };
    });

    const node = makeNode();
    const params = makeParams({
      sequential: true,
      concurrencyLimit: 4, // ignored: sequential pins the pool to 1
      promptTemplate: JSON.stringify(['a', 'b', 'c']),
      joinSeparator: '|',
    });
    const prep = await node.prep(makeShared(), params);
    const exec = await node.execCore(prep);

    expect(maxActive).toBe(1);
    expect(exec.outputText).toBe('OUT_a|OUT_b|OUT_c');
  });

  it('collect-all: a per-item failure is summarized and the node still succeeds (partial) + hands off', async () => {
    runFlowMock.mockImplementation(async ({ prompt }: { prompt: string }) => {
      if (prompt === 'b') return { status: 'error', outputText: '', error: { message: 'boom-b', statusCode: 500 } };
      return { status: 'completed', outputText: `OUT_${prompt}` };
    });

    const node = makeNode();
    const params = makeParams({
      promptTemplate: JSON.stringify(['a', 'b', 'c']),
      errorStrategy: 'collect-all',
      joinSeparator: '\n',
      concurrencyLimit: 3,
    });
    const prep = await node.prep(makeShared(), params);
    const exec = await node.execCore(prep);

    expect(exec.success).toBe(true);
    expect(exec.partial).toBe(true);
    expect(exec.outputText).toContain('OUT_a');
    expect(exec.outputText).toContain('OUT_c');
    expect(exec.outputText).not.toContain('OUT_b');
    expect(exec.outputText).toContain('boom-b'); // failure summary folded

    const shared = makeShared();
    const action = await node.post(prep, exec, shared, params);
    expect(action).toBe('NEXT');
  });

  it('fail-fast: the first failing item fails the whole node and stops further items', async () => {
    runFlowMock.mockImplementation(async ({ prompt }: { prompt: string }) => {
      if (prompt === 'a') return { status: 'error', outputText: '', error: { message: 'boom-a', statusCode: 500 } };
      await delay(10);
      return { status: 'completed', outputText: `OUT_${prompt}` };
    });

    const node = makeNode();
    const params = makeParams({
      promptTemplate: JSON.stringify(['a', 'b', 'c']),
      errorStrategy: 'fail-fast',
      sequential: true, // pool size 1 => 'a' fails before b/c start
    });
    const prep = await node.prep(makeShared(), params);
    const exec = await node.execCore(prep);

    expect(exec.success).toBe(false);
    expect(exec.error).toContain('boom-a');
    expect(runFlowMock).toHaveBeenCalledTimes(1); // b, c never started

    const shared = makeShared();
    const action = await node.post(prep, exec, shared, params);
    expect(action).toBe(ERROR_ACTION);
  });

  it('runs every item at the same depth (parent+1); mapping does not deepen the call tree', async () => {
    runFlowMock.mockResolvedValue({ status: 'completed', outputText: 'x' });
    const node = makeNode();
    const prep = await node.prep(makeShared({ runDepth: 2 }), makeParams({ promptTemplate: JSON.stringify(['a', 'b', 'c']) }));
    await node.execCore(prep);

    const depths = runFlowMock.mock.calls.map((c) => (c[0] as { depth: number }).depth);
    expect(depths).toEqual([3, 3, 3]);
  });

  it('history mode: items come from the LAST user message content', async () => {
    runFlowMock.mockResolvedValue({ status: 'completed', outputText: 'x' });
    const node = makeNode();
    const shared = makeShared({
      messages: [
        { role: 'user', content: 'ignored earlier', id: '1', timestamp: 1 },
        { role: 'assistant', content: 'noise', id: '2', timestamp: 2 },
        { role: 'user', content: JSON.stringify(['x', 'y']), id: '3', timestamp: 3 },
      ],
    });
    // inputMode latest-message so prep narrows to the last user message, then map splits it.
    const params = makeParams({ inputMode: 'latest-message', promptTemplate: undefined });
    const prep = await node.prep(shared, params);
    await node.execCore(prep);

    expect(calledPrompts()).toEqual(['x', 'y']);
  });

  it('stamps distinct item index/count on folded events (per-item runs separable in the live view)', async () => {
    runFlowMock.mockImplementation(
      async ({ prompt, emit }: { prompt: string; emit?: (e: Record<string, unknown>) => void }) => {
        emit?.({ type: 'run:start', flowId: 'child' });
        emit?.({ type: 'message', message: { role: 'assistant', content: `m-${prompt}`, id: 'x', timestamp: 1 } });
        emit?.({ type: 'run:done', status: 'completed' });
        return { status: 'completed', outputText: `OUT_${prompt}` };
      },
    );

    const events: Array<Record<string, unknown>> = [];
    const node = makeNode();
    const shared = makeShared({ emit: (e: Record<string, unknown>) => events.push(e) });
    const prep = await node.prep(shared, makeParams({ promptTemplate: JSON.stringify(['a', 'b']), concurrencyLimit: 2 }));
    await node.execCore(prep);

    // No raw run boundary ever leaks onto the parent channel.
    expect(events.some((e) => e.type === 'run:done')).toBe(false);
    const starts = events.filter((e) => e.type === 'subflow:start');
    expect(starts.map((e) => e.laneIndex).sort()).toEqual([0, 1]);
    expect(starts.every((e) => e.laneCount === 2)).toBe(true);
  });
});

describe('SubflowNode fan-out regression (per-lane input must NOT affect fan-out)', () => {
  it('fan-out lanes all receive the SAME shared input (no per-lane input)', async () => {
    runFlowMock.mockResolvedValue({ status: 'completed', outputText: 'x' });
    const node = makeNode();
    const params = {
      id: 'sub-1',
      type: 'subflow',
      properties: { promptTemplate: 'SHARED', parallelSubflowIds: ['f0', 'f1', 'f2'] },
    } as unknown as SubflowNodeParams;
    const prep = await node.prep(makeShared(), params);
    await node.execCore(prep);

    expect(calledPrompts()).toEqual(['SHARED', 'SHARED', 'SHARED']); // shared input, byte-for-byte
  });
});
