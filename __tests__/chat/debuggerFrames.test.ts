import {
  buildDebuggerFrames,
  debuggerFramePath,
  DEBUGGER_ROOT_FRAME_KEY,
} from '@/utils/shared/debuggerFrames';
import type { ExecutionEvent } from '@/shared/types/execution/events';

const event = (partial: Record<string, unknown>): ExecutionEvent => ({
  conversationId: 'conv-1',
  seq: 1,
  timestamp: 1_000,
  ...partial,
} as unknown as ExecutionEvent);

describe('debugger subflow frames', () => {
  it('follows a child and restores the parent without losing child history', () => {
    const state = buildDebuggerFrames('root-flow', [
      event({ type: 'subflow:start', seq: 1, depth: 1, subflowId: 'child-flow', subflowName: 'Child', node: { nodeId: 'invoke-child' } }),
      event({ type: 'node:enter', seq: 2, depth: 1, node: { nodeId: 'same-id' } }),
      event({ type: 'subflow:done', seq: 3, depth: 1, subflowId: 'child-flow', status: 'completed', node: { nodeId: 'invoke-child' } }),
    ]);

    const child = Object.values(state.frames).find(frame => frame.flowId === 'child-flow');
    expect(child).toMatchObject({ status: 'completed', parentKey: DEBUGGER_ROOT_FRAME_KEY });
    expect(child?.nodeActivity['same-id']).toMatchObject({ kind: 'active' });
    expect(state.activeFrameKey).toBe(DEBUGGER_ROOT_FRAME_KEY);
  });

  it('routes identical node ids to their depth-qualified frames', () => {
    const state = buildDebuggerFrames('root-flow', [
      event({ type: 'node:enter', seq: 1, depth: 0, node: { nodeId: 'same-id' } }),
      event({ type: 'subflow:start', seq: 2, depth: 1, subflowId: 'child-flow', node: { nodeId: 'invoke-child' } }),
      event({ type: 'node:enter', seq: 3, depth: 1, node: { nodeId: 'same-id' }, timestamp: 2_000 }),
    ]);

    const child = Object.values(state.frames).find(frame => frame.flowId === 'child-flow');
    expect(state.frames[DEBUGGER_ROOT_FRAME_KEY].nodeActivity['same-id']?.ts).toBe(1_000);
    expect(child?.nodeActivity['same-id']?.ts).toBe(2_000);
  });

  it('builds a nested invocation path', () => {
    const state = buildDebuggerFrames('root-flow', [
      event({ type: 'subflow:start', seq: 1, depth: 1, subflowId: 'child-flow', subflowName: 'Child', node: { nodeId: 'child-node' } }),
      event({ type: 'subflow:start', seq: 2, depth: 2, subflowId: 'grandchild-flow', subflowName: 'Grandchild', node: { nodeId: 'grandchild-node' } }),
    ]);

    expect(debuggerFramePath(state, state.activeFrameKey).map(frame => frame.flowId)).toEqual([
      'root-flow',
      'child-flow',
      'grandchild-flow',
    ]);
  });

  it('keeps parallel lanes separate even when they use the same flow and node ids', () => {
    const state = buildDebuggerFrames('root-flow', [
      event({ type: 'subflow:start', seq: 1, depth: 1, laneIndex: 0, laneCount: 2, subflowId: 'worker', node: { nodeId: 'fanout' } }),
      event({ type: 'subflow:start', seq: 2, depth: 1, laneIndex: 1, laneCount: 2, subflowId: 'worker', node: { nodeId: 'fanout' } }),
      event({ type: 'node:enter', seq: 3, depth: 1, laneIndex: 0, laneCount: 2, node: { nodeId: 'work' }, timestamp: 3_000 }),
      event({ type: 'node:enter', seq: 4, depth: 1, laneIndex: 1, laneCount: 2, node: { nodeId: 'work' }, timestamp: 4_000 }),
    ]);

    const lanes = Object.values(state.frames).filter(frame => frame.flowId === 'worker');
    expect(lanes).toHaveLength(2);
    expect(lanes.find(frame => frame.laneIndex === 0)?.nodeActivity.work.ts).toBe(3_000);
    expect(lanes.find(frame => frame.laneIndex === 1)?.nodeActivity.work.ts).toBe(4_000);
  });

  it('ignores malformed frames beyond the runtime depth cap', () => {
    const state = buildDebuggerFrames('root-flow', [
      event({ type: 'subflow:start', seq: 1, depth: 9, subflowId: 'too-deep', node: { nodeId: 'cycle' } }),
    ]);

    expect(state.order).toEqual([DEBUGGER_ROOT_FRAME_KEY]);
  });
});
