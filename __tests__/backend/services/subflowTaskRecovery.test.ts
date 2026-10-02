import type { SharedState } from '@/backend/execution/flow/types';
import type { SubflowTaskRecord } from '@/shared/types/subflowTasks';
import { getCurrentWorkspace, runWithWorkspace, workspaceCacheKey } from '@/utils/workspace';

const items = new Map<string, string>();
const states = new Map<string, SharedState>();
const priorOwners = new Set<string>();
const owner = {
  installationId: 'local-installation', workspace: 'worker', recoveryOwnerId: 'old-owner',
  processInstanceId: 'old-process', pid: 12345,
};
jest.mock('@/utils/storage/backend', () => {
  const actual = jest.requireActual('@/utils/storage/backend');
  const key = (value: string) => `${getCurrentWorkspace()}:${value}`;
  return {
    ...actual,
    saveCollectionItem: jest.fn(async (collection: string, id: string, value: unknown) => items.set(key(`${collection}/${id}`), JSON.stringify(value))),
    loadCollectionItem: jest.fn(async (collection: string, id: string, fallback: unknown) => {
      actual.assertSafeCollectionId(id);
      const value = items.get(key(`${collection}/${id}`));
      return value === undefined ? fallback : JSON.parse(value);
    }),
    listCollectionItems: jest.fn(async (collection: string) => [...items.entries()]
      .filter(([name]) => name.startsWith(key(`${collection}/`))).map(([, value]) => JSON.parse(value))),
    loadItem: jest.fn(async (name: string, fallback: unknown) => {
      const value = items.get(key(name));
      return value === undefined ? fallback : JSON.parse(value);
    }),
  };
});
jest.mock('@/backend/services/subflowTasks/ownership', () => ({
  getDetachedTaskLaunchOwner: jest.fn(async () => ({ ...owner, workspace: getCurrentWorkspace() })),
  isPriorLocalTaskOwner: jest.fn(async (candidate?: SubflowTaskRecord['launchOwner']) =>
    Boolean(candidate && candidate.installationId === owner.installationId
      && candidate.workspace === getCurrentWorkspace() && priorOwners.has(candidate.recoveryOwnerId))),
}));
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({ FlowExecutor: { get conversationStates() { return states; } } }));
jest.mock('@/backend/execution/flow/conversationLog', () => ({
  appendRawForState: jest.fn(async () => undefined), flushConversationLog: jest.fn(async () => undefined),
}));
jest.mock('@/backend/execution/flow/persistConversationState', () => ({
  persistConversationState: jest.fn(async (key: string, value: unknown) => items.set(`${getCurrentWorkspace()}:${key}`, JSON.stringify(value))),
}));
jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: jest.fn(async () => null) }));
jest.mock('@/backend/execution/flow/runFlow', () => ({ runFlow: jest.fn() }));
const runSubflowLanes = jest.fn(async (..._args: unknown[]) => ({ success: true, outputText: 'ok' }));
jest.mock('@/backend/execution/flow/nodes/SubflowNode', () => ({ runSubflowLanes: (...args: unknown[]) => runSubflowLanes(...args) }));
jest.mock('@/backend/services/flow', () => ({ flowService: { getFlow: jest.fn(async () => ({
  id: 'parent-flow', nodes: [{ id: 'detached-node', type: 'subflow', data: { properties: { subflowId: 'child-flow' } } }], edges: [],
})) } }));

import { createTask, getTask, listTasks, patchTask, reconcileOrphanedTasks, _clearSubflowTaskSettingsCache } from '@/backend/services/subflowTasks';
import { executeTaskGet, executeDetachedSubflowStart, detachedJobRegistry } from '@/backend/execution/flow/handlers/subflowDetachedInvocation';
import { executeSubflowCommunicationTool, waitForActiveSubflows } from '@/backend/execution/flow/subflowCommunication';
import { GET } from '@/app/v1/tasks/[taskId]/route';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import { saveCollectionItem } from '@/utils/storage/backend';

function parent(): SharedState {
  const state = {
    conversationId: 'parent', flowId: 'parent-flow', logicalRunId: 'parent-run', status: 'running', messages: [],
    title: 'Parent', createdAt: 1, updatedAt: 1,
    trackingInfo: { executionId: 'parent-exec', startTime: 1, nodeExecutionTracker: [] },
    subflowDetachedToolNameMap: { start_subflow_child: 'detached-node' },
  } as SharedState;
  states.set('parent', state);
  return state;
}

async function seed(childId: string, options: { copied?: boolean; terminal?: boolean; ownerId?: string } = {}) {
  const task = (await createTask({
    originConversationId: 'parent', originLogicalRunId: 'parent-run', flowId: 'child-flow',
    childConversationId: childId, input: { prompt: 'harmless pending child' },
  }))!;
  if (options.copied || options.ownerId) await saveCollectionItem('subflow-tasks', task.taskId, { ...task, launchOwner: {
    ...task.launchOwner!,
    ...(options.copied ? { installationId: 'snapshot-source-installation' } : {}),
    ...(options.ownerId ? { recoveryOwnerId: options.ownerId } : {}),
  } });
  const child = {
    conversationId: childId, flowId: task.flowId, parentRunId: 'parent', parentLogicalRunId: 'parent-run',
    status: options.terminal === false ? 'running' : 'error', messages: [],
    recovery: {
      version: 1, runId: `run-${childId}`, attemptId: 'child-attempt', attempt: 1,
      ownerId: options.ownerId ?? owner.recoveryOwnerId, startedAt: task.createdAt, updatedAt: Date.now(),
      ...(options.terminal === false ? { classification: 'running' } : {
        classification: 'interrupted', terminalAt: Date.now(), manualActionRequired: true,
        failure: { category: 'unclean_process_interruption', retryable: false, message: 'Owner exited' },
      }),
    },
  };
  items.set(`${getCurrentWorkspace()}:conversations/${childId}`, JSON.stringify(child));
  return task;
}

beforeEach(() => {
  items.clear(); states.clear(); priorOwners.clear(); priorOwners.add(owner.recoveryOwnerId);
  detachedJobRegistry.clear(); _clearSubflowTaskSettingsCache(); jest.clearAllMocks();
});

it('makes HTTP and model getters agree on exact durable interruption, with an auditable manual recovery reason', async () => runWithWorkspace('worker', async () => {
  parent();
  const httpTask = await seed('http-child');
  const modelTask = await seed('model-child');
  const response = await GET(new Request(`http://localhost/v1/tasks/${httpTask.taskId}`), { params: Promise.resolve({ taskId: httpTask.taskId }) });
  expect(await response.json()).toMatchObject({ task: { status: 'failed', completedAt: expect.any(Number) }, error: expect.stringMatching(/Manual recovery.*not replayed/) });
  expect(await executeTaskGet(modelTask.taskId, { conversationId: 'parent' })).toMatchObject({ success: true, data: { task: { status: 'failed' } } });
  const record = (await getTask(modelTask.taskId))!;
  expect(record).toMatchObject({ failureReason: 'process-restart', interruption: { childConversationId: 'model-child', recoveryOwnerId: owner.recoveryOwnerId, classification: 'interrupted', manualActionRequired: true } });
  expect(await getTask(modelTask.taskId)).toEqual(record);
  expect(runSubflowLanes).not.toHaveBeenCalled();
}));

it('performs ordinary child interruption recovery once after restart and leaves copied, live, legacy, and unmatched records untouched', async () => runWithWorkspace('worker', async () => {
  const local = await seed('local-child', { terminal: false });
  const copied = await seed('copied-child', { copied: true, terminal: false });
  const liveOwner = await seed('live-owner-child', { ownerId: 'live-owner', terminal: false });
  const liveChild = await seed('live-child');
  states.set('live-child', { status: 'running' } as SharedState);
  const legacy = await seed('legacy-child');
  await saveCollectionItem('subflow-tasks', legacy.taskId, { ...legacy, launchOwner: undefined });
  const unmatched = await seed('unmatched-child');
  const key = 'worker:conversations/unmatched-child';
  items.set(key, JSON.stringify({ ...JSON.parse(items.get(key)!), parentRunId: 'another-parent' }));
  expect(await reconcileOrphanedTasks()).toEqual({ failed: 1 });
  expect(await getTask(local.taskId)).toMatchObject({ status: 'failed', failureReason: 'process-restart' });
  expect(JSON.parse(items.get('worker:conversations/local-child')!)).toMatchObject({ status: 'error', recovery: { classification: 'interrupted', manualActionRequired: true } });
  expect(persistConversationState).toHaveBeenCalledTimes(1);
  for (const protectedTask of [copied, liveOwner, liveChild, legacy, unmatched]) expect(await getTask(protectedTask.taskId)).toMatchObject({ status: 'working' });
  expect(await reconcileOrphanedTasks()).toEqual({ failed: 0 });
}));

it('removes reconciled local tasks from admission counts and lets the orchestrator wait observe their failure', async () => runWithWorkspace('worker', async () => {
  const state = parent();
  const local = await seed('wait-child');
  await seed('stale-child-2'); await seed('stale-child-3');
  const copied = await seed('copied-child', { copied: true });
  state.launchedTaskIds = [local.taskId];
  expect(await executeSubflowCommunicationTool('subflow_wait', { target: local.taskId, timeoutMs: 0 }, { conversationId: 'parent' }))
    .toMatchObject({ success: true, data: { reason: 'completed', agents: [{ status: 'failed' }] } });
  expect(await waitForActiveSubflows(state)).toBe(true);
  expect((await listTasks({ status: 'working' })).map(task => task.taskId)).toEqual([copied.taskId]);
  const started = await executeDetachedSubflowStart('start_subflow_child', {}, { conversationId: 'parent' });
  expect(started.success).toBe(true);
  const handle = started.data as { taskId: string };
  await detachedJobRegistry.get(workspaceCacheKey(handle.taskId))?.promise;
}));

it('does not reconcile a worker record from another workspace or overwrite manual cancellation', async () => {
  const task = await runWithWorkspace('worker', () => seed('cancel-child'));
  await runWithWorkspace('worker', () => patchTask(task.taskId, { status: 'cancelled', failureReason: 'cancelled' }));
  expect(await runWithWorkspace('worker', () => getTask(task.taskId))).toMatchObject({ status: 'cancelled', failureReason: 'cancelled' });
  expect(await runWithWorkspace('another-worker', () => getTask(task.taskId))).toBeNull();
});

it('requires a persisted terminal child and refuses to manufacture success or terminalize a missing child', async () => runWithWorkspace('worker', async () => {
  const refused = await seed('refused-child', { terminal: false });
  jest.mocked(persistConversationState).mockResolvedValueOnce(undefined);
  expect(await getTask(refused.taskId)).toMatchObject({ status: 'working' });
  expect(JSON.parse(items.get('worker:conversations/refused-child')!)).toMatchObject({ status: 'running' });
  const missing = await seed('missing-child');
  items.delete('worker:conversations/missing-child');
  expect(await getTask(missing.taskId)).toMatchObject({ status: 'working' });
  const completed = await seed('completed-child');
  const key = 'worker:conversations/completed-child';
  items.set(key, JSON.stringify({ ...JSON.parse(items.get(key)!), status: 'completed' }));
  expect(await getTask(completed.taskId)).toMatchObject({ status: 'working' });
  expect(runSubflowLanes).not.toHaveBeenCalled();
}));

it('preserves a detached Persona dependency snapshot and attribution while recording interruption without replay', async () => runWithWorkspace('worker', async () => {
  const task = await seed('pinned-persona-child');
  const flowSnapshot = {
    id: 'child-flow', name: 'Pinned child', nodes: [{ id: 'action', type: 'finish', position: { x: 0, y: 0 }, data: { type: 'finish', label: 'Return' } }], edges: [],
    executionDependencies: {
      schemaVersion: 1, workspaceId: 'worker',
      flows: [{ flowId: 'dependency-flow', contentHash: 'a'.repeat(64), flowSnapshot: { id: 'dependency-flow', name: 'Original dependency', nodes: [], edges: [] } }],
    },
  };
  const personaAttribution = { personaId: 'persona-1', activityId: 'activity-1', behaviorRevisionId: 'behavior-1' };
  await saveCollectionItem('subflow-tasks', task.taskId, { ...task, flowSnapshot, personaAttribution });
  expect(await reconcileOrphanedTasks()).toEqual({ failed: 1 });
  expect(await getTask(task.taskId)).toMatchObject({ status: 'failed', flowSnapshot, personaAttribution });
  expect(await reconcileOrphanedTasks()).toEqual({ failed: 0 });
  expect(runSubflowLanes).not.toHaveBeenCalled();
}));
