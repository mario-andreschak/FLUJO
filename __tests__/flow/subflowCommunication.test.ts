import type { SharedState } from '@/backend/execution/flow/types';
import type { SubflowTaskRecord } from '@/shared/types/subflowTasks';
import { runWithWorkspace, getCurrentWorkspace } from '@/utils/workspace';

const states = new Map<string, Map<string, SharedState>>();
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { get conversationStates() {
    const workspace = getCurrentWorkspace();
    if (!states.has(workspace)) states.set(workspace, new Map());
    return states.get(workspace)!;
  } },
}));
const tasks = new Map<string, SubflowTaskRecord>();
jest.mock('@/backend/services/subflowTasks', () => ({
  getTask: jest.fn(async (id: string) => tasks.get(`${getCurrentWorkspace()}:${id}`) ?? null),
  listTasks: jest.fn(async ({ conversationId }: { conversationId: string }) =>
    [...tasks.entries()].filter(([key, task]) => key.startsWith(`${getCurrentWorkspace()}:`) && task.originConversationId === conversationId).map(([, task]) => task)),
}));
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { executeSubflowCommunicationTool as execute, waitForActiveSubflows, publishSubflowCompletion, resumeSubflowOrchestrator } from '@/backend/execution/flow/subflowCommunication';
import { takeSteeringMessages, peekSteeringMessages, clearSteeringInbox } from '@/backend/execution/flow/steeringInbox';
import { toApiMessages } from '@/backend/execution/flow/buildNodeContext';

function state(id: string, parent?: string): SharedState {
  const value = { conversationId: id, flowId: `flow-${id}`, logicalRunId: `run-${id}`, status: 'running', messages: [],
    ...(parent ? { parentRunId: parent, parentLogicalRunId: `run-${parent}` } : {}) } as unknown as SharedState;
  FlowExecutor.conversationStates.set(id, value);
  return value;
}
function task(status: SubflowTaskRecord['status'] = 'working'): SubflowTaskRecord {
  const value = { version: 1, taskId: 'task-child', uri: 'flujo://task/task-child', status, pollInterval: 1000, createdAt: 1, updatedAt: 1,
    originConversationId: 'parent', originLogicalRunId: 'run-parent', childConversationId: 'child', flowId: 'flow-child', input: { prompt: 'work' } } as SubflowTaskRecord;
  tasks.set(`${getCurrentWorkspace()}:${value.taskId}`, value);
  return value;
}
beforeEach(() => {
  states.clear(); tasks.clear();
  for (const workspace of ['default-workspace', 'other']) runWithWorkspace(workspace, () => {
    for (const id of ['parent', 'child', 'stranger']) clearSteeringInbox(id);
  });
});

it('delivers targeted parent instructions and child replies with stable IDs and provider-safe provenance', async () => {
  state('parent'); state('child', 'parent'); state('stranger');
  const args = { target: 'child', message: 'Use the revised plan' };
  const first = await execute('subflow_send_message', args, { conversationId: 'parent', toolCallId: 'call-1' });
  await execute('subflow_send_message', args, { conversationId: 'parent', toolCallId: 'call-1' });
  expect(first).toMatchObject({ success: true, data: { status: 'queued', recipientConversationId: 'child' } });
  expect(peekSteeringMessages('child')).toHaveLength(1);
  const message = takeSteeringMessages('child')[0];
  expect(message).toMatchObject({ injected: true, agentMessage: { senderConversationId: 'parent', recipientConversationId: 'child', kind: 'message' } });
  const wire = toApiMessages([message]);
  expect(wire[0]).not.toHaveProperty('agentMessage');
  expect(wire[0].content).toContain('Use the revised plan');
  expect(wire[0].content).toContain('parent');
  expect(await execute('subflow_send_message', { target: 'parent', message: 'I need a decision' }, { conversationId: 'child' })).toMatchObject({ success: true });
  expect(takeSteeringMessages('parent')[0].content).toContain('I need a decision');
  expect(peekSteeringMessages('stranger')).toEqual([]);
});

it('discovers exact background IDs and can steer before child initialization', async () => {
  state('parent'); task();
  expect(await execute('subflow_list', {}, { conversationId: 'parent' })).toMatchObject({ data: { agents: [{ conversationId: 'child', taskId: 'task-child' }] } });
  expect(await execute('subflow_send_message', { target: 'task-child', message: 'Correction' }, { conversationId: 'parent' })).toMatchObject({ success: true });
  expect(takeSteeringMessages('child')[0].content).toContain('Correction');
});

it('rejects unrelated and other-workspace recipients', async () => {
  state('parent'); state('stranger');
  runWithWorkspace('other', () => state('child', 'parent'));
  for (const target of ['stranger', 'child', 'parent']) {
    expect(await execute('subflow_send_message', { target, message: 'hello' }, { conversationId: 'parent' })).toMatchObject({ success: false });
  }
  expect(runWithWorkspace('other', () => peekSteeringMessages('child'))).toEqual([]);
});

it('does not send an old child reply into a new parent generation', async () => {
  state('parent').logicalRunId = 'replacement-run'; state('child', 'parent');
  expect(await execute('subflow_send_message', { target: 'parent', message: 'Late reply' }, { conversationId: 'child' })).toMatchObject({ success: false });
  expect(await execute('subflow_list', {}, { conversationId: 'parent' })).toMatchObject({ data: { agents: [] } });
});

it.each(['completed', 'error', 'capped'] as const)('rejects terminal recipient %s honestly', async status => {
  state('parent'); state('child', 'parent').status = status;
  expect(await execute('subflow_send_message', { target: 'child', message: 'hello' }, { conversationId: 'parent' })).toMatchObject({ success: false });
  expect(peekSteeringMessages('child')).toEqual([]);
});

it('preserves Persona fencing and does not swallow revoked authority', async () => {
  const parent = state('parent'); state('child', 'parent');
  parent.executionAuthority = { assertCurrent: async () => { throw new Error('revoked'); } } as unknown as SharedState['executionAuthority'];
  await expect(execute('subflow_send_message', { target: 'child', message: 'hello' }, { conversationId: 'parent' })).rejects.toMatchObject({ code: 'flow_execution_authority_lost' });
  expect(peekSteeringMessages('child')).toEqual([]);
});

it('wakes a waiting child for a parent reply without consuming it inside a tool exchange', async () => {
  state('parent'); state('child', 'parent'); task();
  const waiting = execute('subflow_wait', { target: 'parent', timeoutMs: 1000 }, { conversationId: 'child' });
  await execute('subflow_send_message', { target: 'child', message: 'Proceed' }, { conversationId: 'parent' });
  expect(await waiting).toMatchObject({ data: { reason: 'message' } });
  expect(peekSteeringMessages('child')).toHaveLength(1);
});

it('does not busy-loop on an already finished child while another is working', async () => {
  state('parent'); state('child', 'parent').status = 'completed'; state('other-child', 'parent');
  expect(await execute('subflow_wait', { timeoutMs: 0 }, { conversationId: 'parent' })).toMatchObject({ data: { reason: 'timeout', agents: [{ conversationId: 'other-child' }] } });
});

it('holds a finishing parent until a worker message arrives', async () => {
  const parent = state('parent'); parent.launchedTaskIds = ['task-child']; state('child', 'parent'); task();
  const waiting = waitForActiveSubflows(parent);
  await execute('subflow_send_message', { target: 'parent', message: 'Please clarify' }, { conversationId: 'child' });
  expect(await waiting).toBe(true);
  expect(peekSteeringMessages('parent')[0].content).toContain('Please clarify');
});

it('delivers completion once and lets the parent finish after it has seen the result', async () => {
  const parent = state('parent'); parent.launchedTaskIds = ['task-child']; state('child', 'parent');
  const completed = task('completed'); completed.outputText = 'Done';
  expect(await waitForActiveSubflows(parent)).toBe(true);
  parent.messages.push(...takeSteeringMessages('parent'));
  await publishSubflowCompletion(completed);
  expect(peekSteeringMessages('parent')).toEqual([]);
  expect(await waitForActiveSubflows(parent)).toBe(false);
});

it('cancellation stops an automatic parent wait', async () => {
  const parent = state('parent'); parent.launchedTaskIds = ['task-child']; task();
  const waiting = waitForActiveSubflows(parent); parent.isCancelled = true;
  expect(await waiting).toBe(false);
});


it('returns from Finish to the launching process so a worker question can be answered', async () => {
  const parent = state('parent');
  parent.currentNodeId = 'finish'; parent.subflowOrchestratorNodeId = 'orchestrator';
  parent.flowSnapshot = { id: 'flow', nodes: [{ id: 'finish', type: 'finish' }, { id: 'orchestrator', type: 'process' }] } as SharedState['flowSnapshot'];
  await resumeSubflowOrchestrator(parent);
  expect(parent.currentNodeId).toBe('orchestrator');
});


it('prevents a synchronous child from deadlocking on a parent that is waiting for its result', async () => {
  state('parent'); state('child', 'parent');
  expect(await execute('subflow_send_message', { target: 'parent', message: 'A progress update' }, { conversationId: 'child' }))
    .toMatchObject({ success: true, data: { replyAvailability: 'after_child_returns' } });
  expect(await execute('subflow_wait', { target: 'parent' }, { conversationId: 'child' }))
    .toMatchObject({ success: false, error: expect.stringContaining('synchronous subflow') });
});
