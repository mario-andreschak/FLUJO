import type { SharedState, SubflowNodePrepResult } from '@/backend/execution/flow/types';
import { snapshotBehaviorFlowDependencies } from '@/backend/services/enduringAgents/behaviorRevisions';
import { getCurrentWorkspace } from '@/utils/workspace';

const conversationStates = new Map<string, SharedState>();
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { conversationStates },
}));

const getFlowMock = jest.fn();
jest.mock('@/backend/services/flow/index', () => ({
  flowService: { getFlow: (...args: unknown[]) => getFlowMock(...(args as [])), readFlowExecutionSnapshot: async (id: string) => ({ workspaceId: getCurrentWorkspace(), flow: await getFlowMock(id) }) },
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

  it.each([
    { executionExtensionOwned: true },
    { executionExtensionContext: {} },
  ])('refuses a synthetic child from protected parent state before flow lookup or lane execution', async protectedFields => {
    conversationStates.set('protected-parent', {
      conversationId: 'protected-parent',
      flowId: 'parent-flow',
      subflowToolNameMap: { call_subflow_worker: 'subflow-node' },
      ...protectedFields,
    } as unknown as SharedState);

    await expect(executeSubflowToolCall('call_subflow_worker', { task: 'private input' }, {
      conversationId: 'protected-parent',
    })).resolves.toEqual({ success: false, error: 'execution_subflow_child_authority_required' });
    expect(getFlowMock).not.toHaveBeenCalled();
    expect(runSubflowLanesMock).not.toHaveBeenCalled();
  });

  it('passes trusted attribution, immutable dependency snapshots and only the child fence into lanes', async () => {
    const authority = {
      signal: new AbortController().signal,
      assertCurrent: jest.fn(async () => undefined),
    };
    const attribution = {
      personaId: 'persona-1',
      activityId: 'activity-1',
      behaviorRevisionId: 'revision-1',
    };
    getFlowMock.mockImplementation(async (id: string) => id === 'parent-flow'
      ? {
          id, name: 'Parent', edges: [],
          nodes: [{
            id: 'subflow-node', type: 'subflow', position: { x: 0, y: 0 },
            data: { type: 'subflow', label: 'Worker', properties: { subflowId: 'child-flow', promptTemplate: 'Do the work' } },
          }],
        }
      : { id, name: 'Child flow', nodes: [
          { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { type: 'start', label: 'Start' } },
          { id: 'finish', type: 'finish', position: { x: 1, y: 0 }, data: { type: 'finish', label: 'Finish' } },
        ], edges: [{ id: 'end', source: 'start', target: 'finish' }] });
    const flowSnapshot = await snapshotBehaviorFlowDependencies(await getFlowMock('parent-flow'));
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
      flowSnapshot,
    } as unknown as SharedState);

    const result = await executeSubflowToolCall(
      'call_subflow_worker',
      {},
      { conversationId: 'conversation-1' },
    );

    expect(result.success).toBe(true);
    expect(capturedPreparation?.personaAttribution).toBe(attribution);
    expect(capturedPreparation?.parentFlowSnapshot).toBe(flowSnapshot);
    expect(capturedPreparation?.executionAuthority?.signal).toBe(authority.signal);
    await capturedPreparation!.executionAuthority!.assertCurrent();
    expect(authority.assertCurrent).toHaveBeenCalled();
  });
});
