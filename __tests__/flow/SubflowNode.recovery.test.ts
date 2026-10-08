const runFlowMock = jest.fn(async (..._args: any[]): Promise<any> => undefined);
const persistSubflowParentMock = jest.fn(async (..._args: unknown[]) => undefined);

jest.mock('@/backend/execution/flow/runFlow', () => ({
  runFlow: (...args: unknown[]) => runFlowMock(...args),
}));
jest.mock('@/backend/execution/flow/subflowRecovery', () => ({
  persistSubflowParent: (...args: unknown[]) => persistSubflowParentMock(...args),
  syncLaneFromPersistedChild: jest.fn(async () => false),
}));
jest.mock('@/backend/services/flow/index', () => ({
  flowService: {
    getFlow: jest.fn(async (id: string) => ({ id, name: `flow-${id}` })),
  },
}));

import { SubflowNode } from '@/backend/execution/flow/nodes/SubflowNode';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { ERROR_ACTION, type SharedState, type SubflowNodeParams } from '@/backend/execution/flow/types';

function makeNode(): SubflowNode {
  const node = new SubflowNode();
  (node as unknown as { successors: Map<string, unknown> }).successors = new Map([['NEXT', {}]]);
  return node;
}

function makeShared(): SharedState {
  return {
    logicalRunId: 'parent-run-1',
    conversationId: 'parent-conversation',
    flowId: 'parent-flow',
    runDepth: 0,
    chainDepth: 0,
    status: 'running',
    title: 'Parent',
    createdAt: 1,
    updatedAt: 1,
    messages: [{ id: 'u1', role: 'user', content: 'do the work', timestamp: 1 }],
    trackingInfo: { executionId: 'exec-1', startTime: 1, nodeExecutionTracker: [] },
  } as SharedState;
}

function params(): SubflowNodeParams {
  return {
    id: 'sub-node',
    type: 'subflow',
    properties: {
      subflowId: 'worker',
      spawnBriefs: ['first', 'second'],
      inputMode: 'isolated',
      errorStrategy: 'fail-fast',
      concurrencyLimit: 2,
      saveConversation: true,
    },
  } as SubflowNodeParams;
}

describe('SubflowNode durable invocation recovery', () => {
  beforeEach(() => {
    runFlowMock.mockReset();
    persistSubflowParentMock.mockClear();
    FlowExecutor.conversationStates.clear();
  });

  it('reuses the original batch and child ids, skipping siblings that already completed', async () => {
    const shared = makeShared();
    FlowExecutor.conversationStates.set(shared.conversationId!, shared);
    const node = makeNode();

    runFlowMock.mockImplementation(async ({ flowId, prompt, conversationId }: Record<string, string>) => {
      if (prompt === 'second') {
        return {
          status: 'error',
          conversationId,
          outputText: '',
          error: { message: 'second failed' },
          sharedState: { isCancelled: false, recovery: { classification: 'permanent_failure' } },
        };
      }
      return {
        status: 'completed',
        conversationId,
        outputText: `OUT_${prompt ?? flowId}`,
        sharedState: {},
      };
    });

    const firstPrep = await node.prep(shared, params());
    const firstIds = firstPrep.lanes!.map((lane) => lane.conversationId);
    const firstExec = await node.execCore(firstPrep);
    expect(firstExec.success).toBe(false);
    expect(await node.post(firstPrep, firstExec, shared, params())).toBe(ERROR_ACTION);
    expect(shared.subflowInvocations?.[firstPrep.invocationId!].status).toBe('blocked');

    runFlowMock.mockClear();
    runFlowMock.mockImplementation(async ({ prompt, conversationId }: Record<string, string>) => ({
      status: 'completed',
      conversationId,
      outputText: `OUT_${prompt}`,
      sharedState: {},
    }));

    const retryPrep = await node.prep(shared, params());
    expect(retryPrep.invocationId).toBe(firstPrep.invocationId);
    expect(retryPrep.lanes!.map((lane) => lane.conversationId)).toEqual(firstIds);

    const retryExec = await node.execCore(retryPrep);
    expect(retryExec.success).toBe(true);
    expect(retryExec.outputText).toBe('OUT_first\n\nOUT_second');
    expect(runFlowMock).toHaveBeenCalledTimes(1);
    expect(runFlowMock.mock.calls[0][0]).toMatchObject({
      prompt: 'second',
      conversationId: firstIds[1],
    });

    expect(await node.post(retryPrep, retryExec, shared, params())).toBe('NEXT');
    const invocation = shared.subflowInvocations?.[firstPrep.invocationId!];
    expect(invocation?.status).toBe('folded');
    expect(invocation?.foldedAt).toEqual(expect.any(Number));
    expect(shared.activeSubflowInvocationByNode?.['sub-node']).toBeUndefined();
    expect(shared.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
  });

  it('parks a durable collect-all join when any child was cancelled', async () => {
    const shared = makeShared();
    FlowExecutor.conversationStates.set(shared.conversationId!, shared);
    const node = makeNode();
    const nodeParams = params();
    nodeParams.properties!.errorStrategy = 'collect-all';

    runFlowMock.mockImplementation(async ({ prompt, conversationId }: Record<string, string>) => {
      if (prompt === 'second') {
        return {
          status: 'error',
          conversationId,
          outputText: '',
          error: { message: 'cancelled' },
          sharedState: { isCancelled: true, recovery: { classification: 'cancelled' } },
        };
      }
      return {
        status: 'completed',
        conversationId,
        outputText: 'OUT_first',
        sharedState: {},
      };
    });

    const prep = await node.prep(shared, nodeParams);
    const exec = await node.execCore(prep);
    expect(exec).toMatchObject({ success: false, subStatus: 'error' });
    expect(exec.error).toMatch(/cancelled/i);
    expect(shared.subflowInvocations?.[prep.invocationId!].status).toBe('blocked');
    await expect(node.post(prep, exec, shared, nodeParams)).resolves.toBe(ERROR_ACTION);
    expect(shared.messages.filter((message) => message.role === 'assistant')).toHaveLength(0);
  });
});
