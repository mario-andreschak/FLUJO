/**
 * Tests for DYNAMIC parallel fan-out target selection (issue #130).
 *
 * A subflow node with `parallelSubflowIdsVar` resolves its fan-out target flow
 * ids from a run-scoped variable AT RUNTIME (reusing the plaintext run-var
 * scratchpad), instead of a fixed author-time list. runFlow and the flow service
 * are mocked so no real engine runs; what's pinned here is: the pure resolver
 * (split/dedupe/cap/self-reference), dynamic-overrides-static precedence,
 * unknown-id dropping against the flows store, empty-var fallback to the static
 * list, the all-invalid clean-empty result, and that the well-tested parallel
 * engine downstream is reused unchanged (bounded pool, child-order join).
 */

const runFlowMock = jest.fn();
jest.mock('@/backend/execution/flow/runFlow', () => ({
  runFlow: (...a: unknown[]) => runFlowMock(...a),
}));

// getFlow returns a flow for any id EXCEPT ids starting with "missing" (unknown).
const getFlowMock = jest.fn(async (id: string) =>
  id.startsWith('missing') ? null : { id, name: `flow-${id}` },
);
jest.mock('@/backend/services/flow/index', () => ({
  flowService: { getFlow: (id: string) => getFlowMock(id) },
}));

import {
  SubflowNode,
  resolveDynamicFanoutIds,
  MAX_DYNAMIC_FANOUT_LANES,
} from '@/backend/execution/flow/nodes/SubflowNode';
import type { SharedState, SubflowNodeParams } from '@/backend/execution/flow/types';

function makeShared(overrides: Record<string, unknown> = {}): SharedState {
  return {
    conversationId: 'conv-1',
    flowId: 'parent-flow',
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
    properties: { promptTemplate: 'GO', ...properties },
  } as unknown as SubflowNodeParams;
}

function makeNode(): SubflowNode {
  const node = new SubflowNode();
  (node as unknown as { successors: Record<string, unknown> }).successors = { NEXT: {} };
  return node;
}

beforeEach(() => {
  runFlowMock.mockReset();
  getFlowMock.mockClear();
  runFlowMock.mockImplementation(async ({ flowId }: { flowId: string }) => ({
    status: 'completed',
    outputText: `OUT_${flowId}`,
  }));
});

describe('resolveDynamicFanoutIds (pure helper)', () => {
  it('parses a JSON array of ids (default split)', () => {
    expect(resolveDynamicFanoutIds('["a","b","c"]', 'json-array')).toEqual(['a', 'b', 'c']);
  });

  it('parses a newline list in "lines" mode', () => {
    expect(resolveDynamicFanoutIds('a\n b \n\nc\n', 'lines')).toEqual(['a', 'b', 'c']);
  });

  it('de-duplicates preserving first-seen order and drops empties', () => {
    expect(resolveDynamicFanoutIds('["a","a","","b","a"]', 'json-array')).toEqual(['a', 'b']);
  });

  it('drops a self-reference (recursion guard)', () => {
    expect(resolveDynamicFanoutIds('["a","self","b"]', 'json-array', 'self')).toEqual(['a', 'b']);
  });

  it('caps the resolved set at MAX_DYNAMIC_FANOUT_LANES', () => {
    const many = Array.from({ length: MAX_DYNAMIC_FANOUT_LANES + 10 }, (_, i) => `f${i}`);
    const out = resolveDynamicFanoutIds(JSON.stringify(many), 'json-array');
    expect(out).toHaveLength(MAX_DYNAMIC_FANOUT_LANES);
    expect(out[0]).toBe('f0');
  });

  it('returns [] for empty/undefined/non-array input', () => {
    expect(resolveDynamicFanoutIds('', 'json-array')).toEqual([]);
    expect(resolveDynamicFanoutIds(undefined, 'json-array')).toEqual([]);
    expect(resolveDynamicFanoutIds('not json', 'json-array')).toEqual([]);
    expect(resolveDynamicFanoutIds('{"x":1}', 'json-array')).toEqual([]);
  });
});

describe('SubflowNode dynamic fan-out (issue #130)', () => {
  it('fans out over exactly the flows named in the run variable', async () => {
    const node = makeNode();
    const params = makeParams({ parallelSubflowIdsVar: 'TARGETS' });
    const shared = makeShared({ variables: { TARGETS: '["a","b","c"]' } });
    const prep = await node.prep(shared, params);
    const exec = await node.execCore(prep);

    expect(prep.lanes?.map((l) => l.subflowId)).toEqual(['a', 'b', 'c']);
    expect(runFlowMock).toHaveBeenCalledTimes(3);
    expect(exec.success).toBe(true);
    expect(exec.outputText).toBe('OUT_a\n\nOUT_b\n\nOUT_c'); // child-order join
  });

  it('dynamic targets OVERRIDE the static parallelSubflowIds when non-empty', async () => {
    const node = makeNode();
    const params = makeParams({
      parallelSubflowIds: ['static1', 'static2'],
      parallelSubflowIdsVar: 'TARGETS',
    });
    const shared = makeShared({ variables: { TARGETS: '["dyn1","dyn2"]' } });
    const prep = await node.prep(shared, params);

    expect(prep.lanes?.map((l) => l.subflowId)).toEqual(['dyn1', 'dyn2']);
  });

  it('falls back to the static list when the variable resolves to nothing', async () => {
    const node = makeNode();
    const params = makeParams({
      parallelSubflowIds: ['static1', 'static2'],
      parallelSubflowIdsVar: 'TARGETS',
    });
    const shared = makeShared({ variables: { TARGETS: '' } });
    const prep = await node.prep(shared, params);

    expect(prep.lanes?.map((l) => l.subflowId)).toEqual(['static1', 'static2']);
  });

  it('drops unknown ids (validated against the flows store) but runs the known ones', async () => {
    const node = makeNode();
    const params = makeParams({ parallelSubflowIdsVar: 'TARGETS' });
    const shared = makeShared({ variables: { TARGETS: '["a","missing-x","b"]' } });
    const prep = await node.prep(shared, params);
    const exec = await node.execCore(prep);

    expect(prep.lanes?.map((l) => l.subflowId)).toEqual(['a', 'b']); // "missing-x" dropped
    expect(runFlowMock).toHaveBeenCalledTimes(2);
    expect(exec.success).toBe(true);
  });

  it('folds a clean empty result when EVERY dynamic id is unknown (no single-child fallthrough)', async () => {
    const node = makeNode();
    // Node also has a static single subflowId; the all-invalid dynamic fan-out
    // must NOT silently fall through and run it.
    const params = makeParams({ subflowId: 'solo', parallelSubflowIdsVar: 'TARGETS' });
    const shared = makeShared({ variables: { TARGETS: '["missing-1","missing-2"]' } });
    const prep = await node.prep(shared, params);
    const exec = await node.execCore(prep);

    expect(prep.fanOutResolvedEmpty).toBe(true);
    expect(prep.lanes).toEqual([]);
    expect(runFlowMock).not.toHaveBeenCalled();
    expect(exec.success).toBe(true);
    expect(exec.outputText).toBe('');
  });

  it('honors the itemSplit "lines" mode for the variable value', async () => {
    const node = makeNode();
    const params = makeParams({ parallelSubflowIdsVar: 'TARGETS', itemSplit: 'lines' });
    const shared = makeShared({ variables: { TARGETS: 'a\nb\nc' } });
    const prep = await node.prep(shared, params);

    expect(prep.lanes?.map((l) => l.subflowId)).toEqual(['a', 'b', 'c']);
  });

  it('runs dynamic lanes at the same depth as the parent + 1 (no deepening)', async () => {
    const node = makeNode();
    const params = makeParams({ parallelSubflowIdsVar: 'TARGETS' });
    const shared = makeShared({ runDepth: 2, variables: { TARGETS: '["a","b"]' } });
    const prep = await node.prep(shared, params);
    await node.execCore(prep);

    const depths = runFlowMock.mock.calls.map((c) => (c[0] as { depth: number }).depth);
    expect(depths).toEqual([3, 3]);
  });
});
