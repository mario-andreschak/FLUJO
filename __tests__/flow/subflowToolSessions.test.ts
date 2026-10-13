import type { SharedState, SubflowNodeProperties } from '@/backend/execution/flow/types';

const conversationStates = new Map<string, SharedState>();
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({ FlowExecutor: { conversationStates } }));
const getFlow = jest.fn();
jest.mock('@/backend/services/flow', () => ({ flowService: { getFlow: (...args: unknown[]) => getFlow(...args) } }));
const runFlow = jest.fn(async (options: Record<string, unknown>) => ({ status: 'completed', outputText: 'done', messages: [], sharedState: { conversationId: options.conversationId } }));
jest.mock('@/backend/execution/flow/runFlow', () => ({ runFlow: (...args: unknown[]) => runFlow(...args as [Record<string, unknown>]) }));
const prepareTranscript = jest.fn(async () => ({ kind: 'valid', summarized: false, trimmedTurns: 0 }));
jest.mock('@/backend/execution/flow/sessionTranscriptPolicy', () => ({ prepareResumedSessionTranscript: (...args: unknown[]) => prepareTranscript(...args as []) }));
jest.mock('@/backend/services/statistics', () => ({ classifyStatisticsError: () => 'unknown', createStatisticsEvent: (event: unknown) => event, recordStatisticsEvent: jest.fn() }));
jest.mock('@/backend/services/statistics/metadata', () => ({ newStatisticsInvocationId: () => 'invocation', startStatisticsTimer: () => ({ elapsedMs: () => 0 }) }));
jest.mock('@/backend/utils/resolveDynamicReferences', () => ({ resolvePromptDynamicReferences: async (text: string) => text }));

import { buildSubflowTool, executeSubflowToolCall } from '@/backend/execution/flow/handlers/subflowToolInvocation';

function setup(properties: Partial<SubflowNodeProperties> = {}, ephemeral = false): SharedState {
  const parent = {
    conversationId: 'parent', flowId: 'parent-flow', logicalRunId: 'run-1',
    title: 'Parent', createdAt: 1, updatedAt: 1, messages: [], ephemeral,
    trackingInfo: { executionId: 'exec', startTime: 1, nodeExecutionTracker: [] },
    subflowToolNameMap: { call_subflow_worker: 'worker' }, variables: { topic: 'scene-a' },
  } as SharedState;
  conversationStates.set('parent', parent);
  getFlow.mockImplementation(async (id: string) => id === 'parent-flow'
    ? { id, name: 'Parent', nodes: [{ id: 'worker', type: 'subflow', data: { label: 'Worker', properties: { subflowId: 'child', ...properties } } }], edges: [] }
    : { id, name: 'Child', nodes: [], edges: [] });
  return parent;
}

const call = (args: Record<string, unknown> = {}) => executeSubflowToolCall('call_subflow_worker', { task: 'Do the work', ...args }, { conversationId: 'parent' });

describe('callable Subflow child memory', () => {
  beforeEach(() => { conversationStates.clear(); jest.clearAllMocks(); });

  it('resumes one per-run child as a follow-up and advances its completed visits', async () => {
    const parent = setup({ sessionScope: 'per-run', sessionInputMode: 'summary', sessionTurnCap: 3 });
    expect((await call({ task: 'Create the artifact' })).success).toBe(true);
    expect((await call({ task: 'Apply the review notes' })).success).toBe(true);
    const [first, second] = runFlow.mock.calls.map(([options]) => options);
    expect(first.mode).toBe('conversation');
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.resumeAsNewTurn).toBe(true);
    expect(second.prompt).toBe('Apply the review notes');
    expect(second.lane).toMatchObject({ sessionVisit: 2 });
    expect(prepareTranscript).toHaveBeenCalledWith(expect.objectContaining({ conversationId: first.conversationId, inputMode: 'summary', sessionTurnCap: 3 }));
    expect(Object.values(parent.subflowSessions ?? {})).toEqual([expect.objectContaining({ conversationId: first.conversationId, visits: 2, status: 'idle' })]);
  });

  it.each([{}, { sessionScope: 'per-visit' }, { sessionScope: 'per-run', saveConversation: false }] as Partial<SubflowNodeProperties>[])
  ('keeps fresh or explicitly unsaved calls ephemeral: %j', async (properties) => {
    const parent = setup(properties);
    await call(); await call();
    const [first, second] = runFlow.mock.calls.map(([options]) => options);
    expect(first.mode).toBe('ephemeral');
    expect(second.conversationId).not.toBe(first.conversationId);
    expect(second.resumeAsNewTurn).toBeUndefined();
    expect(parent.subflowSessions).toBeUndefined();
  });

  it('resolves authored keys and gives caller keys independent reusable children', async () => {
    const parent = setup({ sessionScope: 'per-key', sessionKey: '${var:topic}' });
    await call(); await call();
    await call({ sessionKey: 'scene-b' }); await call({ sessionKey: 'scene-b' });
    const [first, second, other, otherFollowup] = runFlow.mock.calls.map(([options]) => options);
    expect(second.conversationId).toBe(first.conversationId);
    expect(other.conversationId).not.toBe(first.conversationId);
    expect(otherFollowup.conversationId).toBe(other.conversationId);
    expect(Object.values(parent.subflowSessions ?? {}).map(session => ({ key: session.sessionKey, visits: session.visits })))
      .toEqual([{ key: 'scene-a', visits: 2 }, { key: 'scene-b', visits: 2 }]);
    expect(buildSubflowTool('call_subflow_worker', { id: 'worker', label: 'Worker' }, '', true, 'per-key').inputSchema)
      .toMatchObject({ properties: { sessionKey: { minLength: 1, maxLength: 128 } }, required: ['task'] });
  });

  it('keeps a missing key and an ephemeral parent outside saved child memory', async () => {
    setup({ sessionScope: 'per-key', sessionKey: '{{missing}}' });
    await call(); await call();
    expect(runFlow.mock.calls[1][0].conversationId).not.toBe(runFlow.mock.calls[0][0].conversationId);
    expect(runFlow.mock.calls[0][0].mode).toBe('ephemeral');
    setup({ sessionScope: 'per-run' }, true);
    await call();
    expect(runFlow.mock.calls[2][0].mode).toBe('ephemeral');
  });

  it('records a failed visit and retries that session without losing its identity', async () => {
    const parent = setup({ sessionScope: 'per-run' });
    runFlow.mockResolvedValueOnce({ status: 'error', outputText: '', messages: [], sharedState: { conversationId: 'failed-child' } });
    expect((await call()).success).toBe(false);
    expect(Object.values(parent.subflowSessions ?? {})).toEqual([expect.objectContaining({ visits: 1, status: 'failed' })]);
    expect((await call({ task: 'Retry the failed step' })).success).toBe(true);
    expect(runFlow.mock.calls[1][0].conversationId).toBe(runFlow.mock.calls[0][0].conversationId);
    expect(Object.values(parent.subflowSessions ?? {})).toEqual([expect.objectContaining({ visits: 2, status: 'idle' })]);
  });
});
