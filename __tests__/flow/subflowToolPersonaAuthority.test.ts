import type { SharedState, SubflowNodePrepResult } from '@/backend/execution/flow/types';

const conversationStates = new Map<string, SharedState>();
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { conversationStates },
}));

const getFlowMock = jest.fn();
jest.mock('@/backend/services/flow/index', () => ({
  flowService: { getFlow: (...args: unknown[]) => getFlowMock(...(args as [])) },
}));

let capturedPreparation: SubflowNodePrepResult | undefined;
const runSubflowLanesMock = jest.fn(async (preparation: SubflowNodePrepResult) => {
  capturedPreparation = preparation;
  return { success: true, outputText: 'child result', lanes: [] };
});
jest.mock('@/backend/execution/flow/nodes/SubflowNode', () => ({
  runSubflowLanes: (...args: unknown[]) => runSubflowLanesMock(...(args as [SubflowNodePrepResult])),
}));

jest.mock('@/backend/execution/flow/runFlow', () => ({
  runFlow: jest.fn(),
}));

jest.mock('@/backend/services/statistics', () => ({
  classifyStatisticsError: jest.fn(() => 'unknown'),
  createStatisticsEvent: jest.fn((event: unknown) => event),
  recordStatisticsEvent: jest.fn(),
}));

jest.mock('@/backend/services/statistics/metadata', () => ({
  newStatisticsInvocationId: jest.fn(() => 'invocation-1'),
  startStatisticsTimer: jest.fn(() => ({ elapsedMs: () => 0 })),
}));

import { executeSubflowToolCall } from '@/backend/execution/flow/handlers/subflowToolInvocation';

describe('callable subflow Persona authority', () => {
  beforeEach(() => {
    conversationStates.clear();
    getFlowMock.mockReset();
    runSubflowLanesMock.mockClear();
    capturedPreparation = undefined;
  });

  it('passes the parent attribution and exact runtime capability into child lanes', async () => {
    const authority = {
      signal: new AbortController().signal,
      assertCurrent: jest.fn(async () => undefined),
    };
    const attribution = {
      personaId: 'persona-1',
      activityId: 'activity-1',
      behaviorRevisionId: 'revision-1',
    };
    conversationStates.set('conversation-1', {
      conversationId: 'conversation-1',
      flowId: 'parent-flow',
      messages: [],
      trackingInfo: { executionId: 'run-1', startTime: 1, nodeExecutionTracker: [] },
      title: 'Parent',
      createdAt: 1,
      updatedAt: 1,
      subflowToolNameMap: { call_subflow_worker: 'subflow-node' },
      personaAttribution: attribution,
      executionAuthority: authority,
    } as unknown as SharedState);
    getFlowMock.mockImplementation(async (id: string) => id === 'parent-flow'
      ? {
          id,
          nodes: [{
            id: 'subflow-node',
            data: {
              label: 'Worker',
              properties: { subflowId: 'child-flow', promptTemplate: 'Do the work' },
            },
          }],
        }
      : { id, name: 'Child flow', nodes: [] });

    const result = await executeSubflowToolCall(
      'call_subflow_worker',
      {},
      { conversationId: 'conversation-1' },
    );

    expect(result.success).toBe(true);
    expect(capturedPreparation?.personaAttribution).toBe(attribution);
    expect(capturedPreparation?.executionAuthority).toBe(authority);
  });
});
