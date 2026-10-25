const runFlowMock = jest.fn(async (..._args: any[]): Promise<any> => undefined);
const persistConversationStateMock = jest.fn(async (..._args: unknown[]) => undefined);
const listCollectionItemsMock = jest.fn(async (..._args: unknown[]) => []);
const loadCollectionItemMock = jest.fn(async (..._args: unknown[]) => undefined);
const listConversationSummariesMock = jest.fn(async (..._args: unknown[]): Promise<any[]> => []);

jest.mock('@/backend/execution/flow/conversationSummaryStore', () => ({
  listConversationSummaries: (...args: unknown[]) => listConversationSummariesMock(...args),
}));

jest.mock('@/backend/execution/flow/runFlow', () => ({
  runFlow: (...args: unknown[]) => runFlowMock(...args),
}));
jest.mock('@/backend/execution/flow/persistConversationState', () => ({
  persistConversationState: (...args: unknown[]) => persistConversationStateMock(...args),
}));
jest.mock('@/utils/storage/backend', () => ({
  listCollectionItems: (...args: unknown[]) => listCollectionItemsMock(...args),
  loadCollectionItem: (...args: unknown[]) => loadCollectionItemMock(...args),
  withConversationSnapshot: async (id: string, consume: (state: unknown) => Promise<unknown>) => consume(await loadCollectionItemMock('conversations', id, undefined)),
}));

import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import {
  getSubflowRecoveryOptions,
  reportSubflowRunOutcome,
  acknowledgeSubflowContinuation,
  syncLaneFromPersistedChild,
} from '@/backend/execution/flow/subflowRecovery';
import type { SharedState, SubflowInvocation } from '@/backend/execution/flow/types';
import { SubflowOutputBudget, getSubflowOutputDiagnostics } from '@/backend/execution/flow/subflowOutputBudget';

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
    listConversationSummariesMock.mockReset().mockResolvedValue([]);
  });

  it('recovers the same admitted multimodal fallback from a completed child without changing its history', async () => {
    const messages = [
      { id: 'result', role: 'assistant', content: [{ type: 'text', text: 'exact ' }, { type: 'text', text: 'result' }], timestamp: 1 },
      { id: 'finish', role: 'assistant', content: '', tool_calls: [{ id: 'finish-call', type: 'function', function: { name: 'finish', arguments: '{}' } }], timestamp: 2 },
    ];
    FlowExecutor.conversationStates.set('multimodal-child', { conversationId: 'multimodal-child', status: 'completed', lastResponse: '', messages } as SharedState);
    const lane = { id: 'lane', index: 0, count: 1, subflowId: 'child', conversationId: 'multimodal-child', status: 'running' as const, attempt: 1, updatedAt: 1 };
    const before = JSON.stringify(messages), budget = new SubflowOutputBudget();
    try {
      await expect(syncLaneFromPersistedChild(lane, budget)).resolves.toBe(true);
      expect(lane).toMatchObject({ outputText: 'exact result', status: 'completed', attempt: 1 });
      expect(JSON.stringify(messages)).toBe(before); expect(runFlowMock).not.toHaveBeenCalled();
    } finally { budget.release(); }
    expect(getSubflowOutputDiagnostics()).toMatchObject({ active: 0, reservedBytes: 0 });
  });

  it('does not hydrate unrelated histories when an ordinary failed chat opens recovery', async () => {
    FlowExecutor.conversationStates.set('ordinary', {
      conversationId: 'ordinary', status: 'error', messages: [],
    } as unknown as SharedState);
    listConversationSummariesMock.mockResolvedValue([
      { id: 'unrelated-root', status: 'error' },
      { id: 'unrelated-child', parentConversationId: 'unrelated-root', rootConversationId: 'unrelated-root', status: 'error' },
    ]);
    await expect(getSubflowRecoveryOptions('ordinary')).resolves.toMatchObject({
      hasRecoverableFamily: false, canRetryBranch: true, deepestFailedCount: 1,
    });
    expect(listCollectionItemsMock).not.toHaveBeenCalled();
    expect(loadCollectionItemMock).not.toHaveBeenCalled();
  });

  it('stops an obsolete recovery read before hydrating conversation state', async () => {
    const controller = new AbortController();
    controller.abort(new Error('View changed'));
    await expect(getSubflowRecoveryOptions('ordinary', controller.signal)).rejects.toThrow('View changed');
    expect(loadCollectionItemMock).not.toHaveBeenCalled();
    expect(listConversationSummariesMock).not.toHaveBeenCalled();
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
    invocation.foldReceipt = { version: 1, id: 'inv-family:fold:v1', action: 'NEXT', presentation: 'separate', messageIds: [] };
    await expect(getSubflowRecoveryOptions('parent')).resolves.toMatchObject({
      hasRecoverableFamily: true, incompleteSiblingCount: 0, canRetryBranch: true, canRetrySiblings: false,
    });
    expect(acknowledgeSubflowContinuation(parent, 'sub-node')).toBe(true);
    expect(parent.activeSubflowInvocationByNode?.['sub-node']).toBeUndefined();
    expect(invocation.foldReceipt.continuedAt).toEqual(expect.any(Number));
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

  it('never resumes a meeting-owned participant outside MeetingEngine', async () => {
    const invocation: SubflowInvocation = {
      version: 1,
      id: 'inv-meeting',
      parentConversationId: 'parent',
      parentNodeId: 'sub-node',
      status: 'blocked',
      depth: 1,
      showSteps: true,
      concurrencyLimit: 1,
      joinSeparator: '\n\n',
      errorStrategy: 'fail-fast',
      lanes: [{
        id: 'lane-meeting',
        index: 0,
        count: 1,
        subflowId: 'child-flow',
        conversationId: 'child',
        status: 'error',
        attempt: 1,
        error: 'failed',
        updatedAt: 1,
      }],
      createdAt: 1,
      updatedAt: 1,
    };
    const parent = parentState(invocation);
    parent.source = 'meeting';
    parent.meetingParticipant = {
      protocolVersion: 1,
      meetingId: 'meeting-1',
      participantId: 'participant-1',
      participantName: 'Participant',
      role: 'participant',
    };
    FlowExecutor.conversationStates.set('parent', parent);

    const child = {
      conversationId: 'child',
      parentRunId: 'parent',
      parentConversationId: 'parent',
      rootConversationId: 'parent',
      subflowLane: {
        invocationId: 'inv-meeting',
        laneId: 'lane-meeting',
        conversationId: 'child',
      },
      recovery: { classification: 'completed' },
      messages: [],
    } as unknown as SharedState;

    await reportSubflowRunOutcome({
      status: 'completed',
      conversationId: 'child',
      outputText: 'child output',
      sharedState: child,
    });

    expect(runFlowMock).not.toHaveBeenCalled();
    await expect(getSubflowRecoveryOptions('parent')).resolves.toMatchObject({
      hasRecoverableFamily: false,
      canRetryBranch: false,
      canRetrySiblings: false,
      canRetryDeepest: false,
    });
  });
});
