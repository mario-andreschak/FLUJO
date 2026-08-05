const runFlowMock = jest.fn(async (..._args: any[]): Promise<any> => undefined);
const persistConversationStateMock = jest.fn(async (..._args: unknown[]) => undefined);
const listCollectionItemsMock = jest.fn(async (..._args: unknown[]) => []);
const loadCollectionItemMock = jest.fn(async (..._args: unknown[]) => undefined);

jest.mock('@/backend/execution/flow/runFlow', () => ({
  runFlow: (...args: unknown[]) => runFlowMock(...args),
}));
jest.mock('@/backend/execution/flow/persistConversationState', () => ({
  persistConversationState: (...args: unknown[]) => persistConversationStateMock(...args),
}));
jest.mock('@/utils/storage/backend', () => ({
  listCollectionItems: (...args: unknown[]) => listCollectionItemsMock(...args),
  loadCollectionItem: (...args: unknown[]) => loadCollectionItemMock(...args),
}));

import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import {
  getSubflowRecoveryOptions,
  reportSubflowRunOutcome,
} from '@/backend/execution/flow/subflowRecovery';
import type { SharedState, SubflowInvocation } from '@/backend/execution/flow/types';

function parentState(invocation: SubflowInvocation): SharedState {
  return {
    logicalRunId: 'parent-run',
    conversationId: 'parent',
    flowId: 'parent-flow',
    currentNodeId: 'sub-node',
    status: 'error',
    source: 'chat',
    title: 'Parent',
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    trackingInfo: { executionId: 'parent-exec', startTime: 1, nodeExecutionTracker: [] },
    subflowInvocations: { [invocation.id]: invocation },
    activeSubflowInvocationByNode: { 'sub-node': invocation.id },
  } as SharedState;
}

describe('subflow recovery coordinator', () => {
  beforeEach(() => {
    FlowExecutor.conversationStates.clear();
    runFlowMock.mockReset();
    persistConversationStateMock.mockClear();
    listCollectionItemsMock.mockClear();
    loadCollectionItemMock.mockClear();
  });

  it('records a recovered child result and resumes its parked parent exactly once', async () => {
    const invocation: SubflowInvocation = {
      version: 1,
      id: 'inv-1',
      parentConversationId: 'parent',
      parentNodeId: 'sub-node',
      status: 'blocked',
      depth: 1,
      showSteps: true,
      concurrencyLimit: 2,
      joinSeparator: '\n\n',
      errorStrategy: 'fail-fast',
      lanes: [{
        id: 'lane-1',
        index: 0,
        count: 1,
        subflowId: 'child-flow',
        conversationId: 'child',
        status: 'cancelled',
        attempt: 1,
        error: 'cancelled',
        updatedAt: 1,
      }],
      createdAt: 1,
      updatedAt: 1,
    };
    const parent = parentState(invocation);
    FlowExecutor.conversationStates.set('parent', parent);
    const child = {
      conversationId: 'child',
      parentRunId: 'parent',
      parentConversationId: 'parent',
      subflowLane: {
        laneIndex: 0,
        invocationId: 'inv-1',
        laneId: 'lane-1',
        parentNodeId: 'sub-node',
        conversationId: 'child',
      },
      recovery: { classification: 'completed' },
      messages: [],
    } as unknown as SharedState;

    runFlowMock.mockResolvedValue({
      status: 'completed',
      conversationId: 'parent',
      outputText: 'parent done',
      sharedState: parent,
    });

    await reportSubflowRunOutcome({
      status: 'completed',
      conversationId: 'child',
      outputText: 'recovered output',
      sharedState: child,
    });

    expect(invocation.lanes[0]).toMatchObject({
      status: 'completed',
      outputText: 'recovered output',
      error: undefined,
    });
    expect(runFlowMock).toHaveBeenCalledTimes(1);
    expect(runFlowMock.mock.calls[0][0]).toMatchObject({
      conversationId: 'parent',
      userTurn: false,
      source: 'chat',
    });
  });

  it('offers active siblings and deepest leaves, but ignores an already-folded family', async () => {
    const invocation: SubflowInvocation = {
      version: 1,
      id: 'inv-family',
      parentConversationId: 'parent',
      parentNodeId: 'sub-node',
      status: 'blocked',
      depth: 1,
      showSteps: true,
      concurrencyLimit: 2,
      joinSeparator: '\n\n',
      errorStrategy: 'collect-all',
      lanes: [
        {
          id: 'lane-1', index: 0, count: 2, subflowId: 'child-flow', conversationId: 'child-1',
          status: 'error', attempt: 1, error: 'failed 1', updatedAt: 1,
        },
        {
          id: 'lane-2', index: 1, count: 2, subflowId: 'child-flow', conversationId: 'child-2',
          status: 'cancelled', attempt: 1, error: 'cancelled 2', updatedAt: 1,
        },
      ],
      createdAt: 1,
      updatedAt: 1,
    };
    const parent = parentState(invocation);
    const child = (id: string, laneId: string): SharedState => ({
      conversationId: id,
      parentRunId: 'parent',
      parentConversationId: 'parent',
      rootConversationId: 'parent',
      status: 'error',
      messages: [],
      subflowLane: { invocationId: 'inv-family', laneId, conversationId: id },
      recovery: { classification: 'permanent_failure' },
    } as unknown as SharedState);
    FlowExecutor.conversationStates.set('parent', parent);
    FlowExecutor.conversationStates.set('child-1', child('child-1', 'lane-1'));
    FlowExecutor.conversationStates.set('child-2', child('child-2', 'lane-2'));

    await expect(getSubflowRecoveryOptions('child-1')).resolves.toMatchObject({
      hasRecoverableFamily: true,
      incompleteSiblingCount: 2,
      deepestFailedCount: 2,
      canRetryBranch: true,
      canRetrySiblings: true,
      canRetryDeepest: true,
    });
    await expect(getSubflowRecoveryOptions('parent')).resolves.toMatchObject({
      hasRecoverableFamily: true,
      incompleteSiblingCount: 2,
      deepestFailedCount: 2,
      canRetryBranch: true,
      canRetrySiblings: false,
      canRetryDeepest: true,
    });

    invocation.status = 'folded';
    invocation.foldedAt = Date.now();
    delete parent.activeSubflowInvocationByNode?.['sub-node'];
    parent.status = 'completed';
    await expect(getSubflowRecoveryOptions('child-1')).resolves.toMatchObject({
      hasRecoverableFamily: false,
      incompleteSiblingCount: 0,
      deepestFailedCount: 0,
      canRetryBranch: true,
      canRetrySiblings: false,
      canRetryDeepest: false,
    });
  });
});
