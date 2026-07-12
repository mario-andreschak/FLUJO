/**
 * Tests for the #13 subflow node (flow-as-callable consumer).
 *
 * SubflowNode runs another flow via runFlow in ephemeral mode and folds the
 * result back into the parent conversation. runFlow is mocked here (the keystone
 * itself is covered by runFlow.test.ts), so these tests pin the node's contract:
 *   - it calls runFlow with the child flowId, the mapped prompt, ephemeral mode,
 *     and depth = parent runDepth + 1;
 *   - a successful run appends the subflow output as an assistant message
 *     attributed to this node and hands off to the node's successor edge;
 *   - with no successor it ends the flow (FINAL_RESPONSE_ACTION);
 *   - a failed subflow surfaces as ERROR_ACTION;
 *   - a missing subflowId fails without ever calling runFlow.
 *
 * The lazy `await import('../runFlow')` inside execCore resolves to the same
 * module path as the alias below, so jest.mock intercepts it.
 */
import type { SharedState } from '@/backend/execution/flow/types';
import { FINAL_RESPONSE_ACTION, ERROR_ACTION } from '@/backend/execution/flow/types';

jest.mock('@/backend/execution/flow/runFlow', () => ({
  runFlow: jest.fn(async (input: any) => {
    if (input.flowId === 'error-flow') {
      return {
        status: 'error',
        conversationId: 'sub',
        outputText: '',
        messages: [],
        error: { message: 'subflow boom', statusCode: 500 },
        finalAction: 'ERROR',
        sharedState: {},
      };
    }
    return {
      status: 'completed',
      conversationId: 'sub',
      outputText: input.prompt !== undefined ? `echo:${input.prompt}` : 'echo:history',
      messages: [],
      finalAction: 'FINAL_RESPONSE',
      sharedState: {},
    };
  }),
}));

// prep() looks up the child flow's display name (subflow:start attribution)
// via a dynamic import of the flow service; mock it so tests never touch disk.
jest.mock('@/backend/services/flow/index', () => ({
  flowService: {
    getFlow: jest.fn(async (id: string) => ({ id, name: `flow-${id}` })),
    loadFlows: jest.fn(async () => []),
  },
}));

import { SubflowNode, FinishNode } from '@/backend/execution/flow/nodes';
import { runFlow } from '@/backend/execution/flow/runFlow';

const runFlowMock = runFlow as jest.Mock;

function makeState(overrides: Partial<SharedState> = {}): SharedState {
  return {
    trackingInfo: { executionId: 'e1', startTime: 1, nodeExecutionTracker: [] },
    messages: [{ role: 'user', content: 'hello world', id: 'u1', timestamp: 1 } as any],
    flowId: 'parent-flow',
    conversationId: 'parent-conv',
    runDepth: 0,
    title: 't',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as SharedState;
}

function makeNode(properties: Record<string, unknown>, successorEdge?: string): SubflowNode {
  const node = new SubflowNode();
  node.setParams({}, { id: 'sub-node', label: 'Sub', type: 'subflow', properties });
  if (successorEdge) {
    node.addSuccessor(new FinishNode(), successorEdge);
  }
  return node;
}

beforeEach(() => {
  runFlowMock.mockClear();
});

describe('SubflowNode', () => {
  it('runs the child flow ephemerally at depth+1 and hands off to its successor', async () => {
    const node = makeNode({ subflowId: 'inner-flow' }, 'edge-next');
    const state = makeState();

    const { action } = await node.run(state);

    // Default (no promptTemplate): the parent history is passed, not a prompt.
    const call = runFlowMock.mock.calls[0][0];
    expect(call).toMatchObject({ flowId: 'inner-flow', mode: 'ephemeral', depth: 1, requireApproval: false });
    expect(call.prompt).toBeUndefined();
    expect(call.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'hello world' }),
    ]);

    // Subflow output folded back into the parent transcript as this node's message.
    const last = state.messages[state.messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.content).toBe('echo:history');
    expect(last.processNodeId).toBe('sub-node');
    expect(state.lastResponse).toBe('echo:history');

    // Hands off via the successor edge.
    expect(action).toBe('edge-next');
  });

  it('passes sanitized history: drops system/tool/handoff plumbing and processNodeId', async () => {
    const node = makeNode({ subflowId: 'inner-flow' }, 'edge-next');
    const state = makeState({
      messages: [
        { role: 'system', content: 'parent system prompt', id: 's1', timestamp: 1 } as any,
        { role: 'user', content: 'I want to research about cats', id: 'u1', timestamp: 2, processNodeId: 'parent-start' } as any,
        { role: 'assistant', content: "I'll hand this off", id: 'a1', timestamp: 3, processNodeId: 'parent-proc',
          tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'handoff_to_x', arguments: '{}' } }] } as any,
        { role: 'tool', tool_call_id: 'tc1', content: 'Handoff processed', id: 't1', timestamp: 4 } as any,
      ],
    });

    await node.run(state);

    const call = runFlowMock.mock.calls[0][0];
    // system, tool, and the handoff assistant turn are all gone; processNodeId
    // stripped. Left ending on the user's actual task.
    expect(call.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'I want to research about cats' }),
    ]);
    expect(call.messages.every((m: any) => m.processNodeId === undefined)).toBe(true);
  });

  it("inputMode 'full-history' (the default) passes the whole sanitized transcript", async () => {
    // An orchestrator loop: an already-finished task, then the current task.
    const node = makeNode({ subflowId: 'inner-flow', inputMode: 'full-history' }, 'edge-next');
    const state = makeState({
      messages: [
        { role: 'user', content: 'Plan issue #69', id: 'u1', timestamp: 1 } as any,
        { role: 'assistant', content: 'Done with #69', id: 'a1', timestamp: 2 } as any,
        { role: 'user', content: 'Plan issue #70', id: 'u2', timestamp: 3 } as any,
      ],
    });

    await node.run(state);

    const call = runFlowMock.mock.calls[0][0];
    expect(call.messages.map((m: any) => m.content)).toEqual([
      'Plan issue #69',
      'Done with #69',
      'Plan issue #70',
    ]);
  });

  it("inputMode 'latest-message' scopes the subflow to only the most recent user instruction (#74)", async () => {
    const node = makeNode({ subflowId: 'inner-flow', inputMode: 'latest-message' }, 'edge-next');
    const state = makeState({
      messages: [
        { role: 'user', content: 'Plan issue #69', id: 'u1', timestamp: 1 } as any,
        { role: 'assistant', content: 'Done with #69', id: 'a1', timestamp: 2 } as any,
        { role: 'user', content: 'Plan issue #70', id: 'u2', timestamp: 3 } as any,
      ],
    });

    await node.run(state);

    const call = runFlowMock.mock.calls[0][0];
    // Only the current task survives — the finished #69 task can't re-anchor it.
    expect(call.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'Plan issue #70' }),
    ]);
    expect(call.prompt).toBeUndefined();
  });

  it('back-compat: a promptTemplate with no inputMode is treated as isolated (sent as a prompt)', async () => {
    const node = makeNode({ subflowId: 'inner-flow', promptTemplate: 'use me instead' }, 'edge-next');
    await node.run(makeState());

    const call = runFlowMock.mock.calls[0][0];
    expect(call.prompt).toBe('use me instead');
    expect(call.messages).toBeUndefined();
  });

  it("inputMode 'isolated' sends the promptTemplate as the subflow's prompt, ignoring the history", async () => {
    const node = makeNode({ subflowId: 'inner-flow', inputMode: 'isolated', promptTemplate: 'fixed task' }, 'edge-next');
    await node.run(makeState({
      messages: [{ role: 'user', content: 'conversation task', id: 'u1', timestamp: 1 } as any],
    }));

    const call = runFlowMock.mock.calls[0][0];
    expect(call.prompt).toBe('fixed task');
    expect(call.messages).toBeUndefined();
  });

  it("an explicit inputMode wins over a leftover promptTemplate (history is used, prompt ignored)", async () => {
    // A flow switched from Isolated back to Full conversation keeps its old
    // promptTemplate in properties, but the explicit mode must win.
    const node = makeNode({ subflowId: 'inner-flow', inputMode: 'full-history', promptTemplate: 'stale' }, 'edge-next');
    await node.run(makeState());

    const call = runFlowMock.mock.calls[0][0];
    expect(call.prompt).toBeUndefined();
    expect(call.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'hello world' }),
    ]);
  });

  it('propagates parent runDepth (depth = runDepth + 1)', async () => {
    const node = makeNode({ subflowId: 'inner-flow' }, 'edge-next');
    await node.run(makeState({ runDepth: 3 }));

    expect(runFlowMock).toHaveBeenCalledWith(expect.objectContaining({ depth: 4 }));
  });

  it('ends the flow (FINAL_RESPONSE_ACTION) when there is no successor', async () => {
    const node = makeNode({ subflowId: 'inner-flow' }); // no successor edge
    const { action } = await node.run(makeState());
    expect(action).toBe(FINAL_RESPONSE_ACTION);
  });

  it('surfaces a failed subflow as ERROR_ACTION', async () => {
    const node = makeNode({ subflowId: 'error-flow' }, 'edge-next');
    const state = makeState();

    const { action } = await node.run(state);

    expect(action).toBe(ERROR_ACTION);
    expect(state.lastResponse).toMatchObject({ success: false });
  });

  it('fails without calling runFlow when no subflowId is configured', async () => {
    const node = makeNode({}, 'edge-next'); // no subflowId
    const { action } = await node.run(makeState());

    expect(runFlowMock).not.toHaveBeenCalled();
    expect(action).toBe(ERROR_ACTION);
  });
});

describe('subflow event folding into the parent conversation (Phase 3)', () => {
  it('forwards child events onto the parent emit at depth+1, translating run boundaries', async () => {
    // Simulate a child run that emits its lifecycle through the emit it was given.
    runFlowMock.mockImplementationOnce(async (input: any) => {
      input.emit?.({ type: 'run:start', flowId: input.flowId });
      input.emit?.({ type: 'message', message: { role: 'assistant', content: 'child step', id: 'child-1', timestamp: 2 } });
      input.emit?.({ type: 'run:done', status: 'completed' });
      return {
        status: 'completed', conversationId: 'sub', outputText: 'child final',
        messages: [], finalAction: 'FINAL_RESPONSE', sharedState: {},
      };
    });

    const parentEvents: any[] = [];
    const node = makeNode({ subflowId: 'inner-flow' }, 'edge-next');
    const state = makeState({ emit: (e: any) => parentEvents.push(e) } as Partial<SharedState>);

    await node.run(state);

    expect(parentEvents.map(e => e.type)).toEqual(['subflow:start', 'message', 'subflow:done']);
    // The child's raw run boundaries never reach the parent channel (a raw
    // run:done would terminate the parent's SSE streams mid-run).
    const [start, message, done] = parentEvents;
    expect(start).toMatchObject({ subflowId: 'inner-flow', subflowName: 'flow-inner-flow', depth: 1, node: { nodeId: 'sub-node' } });
    // depth is stamped on the event AND on the message payload (nested display
    // and the log projection both key off it).
    expect(message).toMatchObject({ depth: 1, message: { id: 'child-1', depth: 1 } });
    expect(done).toMatchObject({ subflowId: 'inner-flow', status: 'completed', depth: 1 });
  });

  it('wrappers compose: an already-nested child event is forwarded one level deeper', async () => {
    runFlowMock.mockImplementationOnce(async (input: any) => {
      // A grandchild's event arriving at the child wrapper already carries depth 1.
      input.emit?.({ type: 'message', depth: 1, message: { role: 'assistant', content: 'grandchild', id: 'gc-1', timestamp: 3, depth: 1 } });
      return {
        status: 'completed', conversationId: 'sub', outputText: 'x',
        messages: [], finalAction: 'FINAL_RESPONSE', sharedState: {},
      };
    });

    const parentEvents: any[] = [];
    const node = makeNode({ subflowId: 'inner-flow' }, 'edge-next');
    await node.run(makeState({ emit: (e: any) => parentEvents.push(e) } as Partial<SharedState>));

    expect(parentEvents[0]).toMatchObject({ type: 'message', depth: 2, message: { id: 'gc-1', depth: 2 } });
  });

  it("outputMode 'final-only' runs the child without an emit (no steps forwarded)", async () => {
    const parentEvents: any[] = [];
    const node = makeNode({ subflowId: 'inner-flow', outputMode: 'final-only' }, 'edge-next');
    const state = makeState({ emit: (e: any) => parentEvents.push(e) } as Partial<SharedState>);

    await node.run(state);

    expect(runFlowMock.mock.calls[0][0].emit).toBeUndefined();
    expect(parentEvents).toEqual([]);
    // The folded final output still lands in the parent transcript.
    expect(state.messages[state.messages.length - 1]).toMatchObject({ role: 'assistant', content: 'echo:history' });
  });

  it('runs the child without an emit when the parent has none (headless runs unchanged)', async () => {
    const node = makeNode({ subflowId: 'inner-flow' }, 'edge-next');
    await node.run(makeState()); // no state.emit
    expect(runFlowMock.mock.calls[0][0].emit).toBeUndefined();
  });
});
