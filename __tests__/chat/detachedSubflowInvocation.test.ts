/**
 * Detached subflow workers with durable job handles (#386, Phase 6 step 2).
 *
 * The whole point of `invocationMode: 'detached'` is that the model gets a
 * durable handle back BEFORE the child finishes and keeps working. These tests
 * pin that contract end to end against the real task store (storage mocked
 * in-memory, write chain and id gate real) with `runSubflowLanes` stubbed:
 *
 *  - start returns `working` while the child is still pending, and the handle is
 *    already persisted (a crash before completion is visible, not invisible);
 *  - the child's terminal state is written back to the store;
 *  - a child error becomes `failed` + `child-error`, never a thrown exception;
 *  - the concurrency cap refuses the (N+1)th launch instead of queueing silently;
 *  - cancel aborts the worker and a late child completion cannot resurrect the
 *    task to `completed`;
 *  - the detached child is launched WITHOUT a parent run id, so parent
 *    cancellation ancestry cannot reach it.
 */
jest.mock('@/utils/storage/backend', () => {
  const actual = jest.requireActual('@/utils/storage/backend');
  const items = new Map<string, string>();
  return {
    ...actual,
    __reset: () => items.clear(),
    saveCollectionItem: jest.fn(async (collection: string, id: string, value: unknown) => {
      actual.assertSafeCollectionId(id);
      items.set(`${collection}/${id}`, JSON.stringify(value));
    }),
    loadCollectionItem: jest.fn(async (collection: string, id: string, fallback: unknown) => {
      actual.assertSafeCollectionId(id);
      const hit = items.get(`${collection}/${id}`);
      return hit === undefined ? fallback : JSON.parse(hit);
    }),
    listCollectionItems: jest.fn(async (collection: string) =>
      [...items.entries()]
        .filter(([key]) => key.startsWith(`${collection}/`))
        .map(([, value]) => JSON.parse(value))),
    deleteCollectionItem: jest.fn(async (collection: string, id: string) => {
      items.delete(`${collection}/${id}`);
    }),
    loadItem: jest.fn(async (_key: unknown, defaultValue: unknown) => defaultValue),
  };
});

jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { conversationStates: new Map() },
}));

jest.mock('@/backend/execution/flow/runFlow', () => ({ runFlow: jest.fn() }));

const runSubflowLanesMock = jest.fn();
jest.mock('@/backend/execution/flow/nodes/SubflowNode', () => ({
  runSubflowLanes: (...args: unknown[]) => runSubflowLanesMock(...args),
}));

const getFlowMock = jest.fn();
jest.mock('@/backend/services/flow', () => ({
  flowService: { getFlow: (...args: unknown[]) => getFlowMock(...args) },
}));

import {
  buildDetachedSubflowTool,
  detachedJobRegistry,
  executeDetachedSubflowStart,
  executeTaskCancel,
  executeTaskGet,
} from '@/backend/execution/flow/handlers/subflowDetachedInvocation';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import {
  _clearSubflowTaskSettingsCache,
  createTask,
  getTask,
} from '@/backend/services/subflowTasks';
import { DEFAULT_SUBFLOW_TASK_SETTINGS, SUBFLOW_TASK_SCHEME } from '@/shared/types/subflowTasks';
import type { SharedState, SubflowNodePrepResult } from '@/backend/execution/flow/types';
import * as backend from '@/utils/storage/backend';

const conversationStates = FlowExecutor.conversationStates as Map<string, SharedState>;
const TOOL = 'start_subflow_worker';

/** A promise whose resolution the test controls, so "still running" is assertable. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const seedParent = (conversationId = 'conv-parent'): SharedState => {
  const state = {
    trackingInfo: { executionId: 'e1', startTime: 1, nodeExecutionTracker: [] },
    messages: [],
    flowId: 'flow-parent',
    conversationId,
    status: 'running',
    runDepth: 0,
    subflowDetachedToolNameMap: { [TOOL]: 'subflow-node-1' },
  } as unknown as SharedState;
  conversationStates.set(conversationId, state);
  return state;
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  (backend as unknown as { __reset: () => void }).__reset();
  _clearSubflowTaskSettingsCache();
  conversationStates.clear();
  detachedJobRegistry.clear();
  runSubflowLanesMock.mockReset();
  getFlowMock.mockReset().mockResolvedValue({
    id: 'flow-parent',
    nodes: [
      {
        id: 'subflow-node-1',
        type: 'subflow',
        data: {
          label: 'Worker',
          properties: { subflowId: 'flow-child', promptTemplate: 'default task' },
        },
      },
    ],
    edges: [],
  });
});

describe('detached subflow tool definition', () => {
  it('advertises the durable handle contract and the poll/cancel companions', () => {
    const tool = buildDetachedSubflowTool(TOOL, { id: 'flow-child', label: 'Worker' }, 'Run the worker.', true);
    expect(tool.name).toBe(TOOL);
    expect(tool.description).toContain('DETACHED SUBFLOW');
    expect(tool.description).toContain('subflow_task_get');
    expect(tool.description).toContain('subflow_task_cancel');
    expect(tool.inputSchema.required).toEqual(['task']);

    const optional = buildDetachedSubflowTool(TOOL, { id: 'flow-child', label: 'Worker' }, 'Run.', false);
    expect(optional.inputSchema.required).toEqual([]);
  });
});

describe('executeDetachedSubflowStart', () => {
  it('returns a durable working handle before the child finishes, then records completion', async () => {
    const child = deferred<{ success: boolean; outputText?: string }>();
    runSubflowLanesMock.mockReturnValue(child.promise);
    const parent = seedParent();

    const started = await executeDetachedSubflowStart(TOOL, { task: 'crunch the numbers' }, {
      conversationId: 'conv-parent',
    });

    expect(started.success).toBe(true);
    const handle = started.data as { taskId: string; uri: string; status: string; pollInterval: number };
    expect(handle.status).toBe('working');
    expect(handle.uri).toBe(`${SUBFLOW_TASK_SCHEME}${handle.taskId}`);
    expect(handle.pollInterval).toBe(DEFAULT_SUBFLOW_TASK_SETTINGS.defaultPollIntervalMs);

    // The child is still running: the handle is already durable and pollable.
    expect(detachedJobRegistry.has(handle.taskId)).toBe(true);
    expect((await getTask(handle.taskId))!.status).toBe('working');
    expect(parent.launchedTaskIds).toEqual([handle.taskId]);

    const polled = await executeTaskGet(handle.taskId);
    expect(polled.success).toBe(true);
    expect((polled.data as { task: { status: string } }).task.status).toBe('working');

    // The launcher must not adopt the parent's cancellation ancestry.
    const prep = runSubflowLanesMock.mock.calls[0][0] as SubflowNodePrepResult & { parentRunId?: string };
    expect(prep.persistConversation).toBe(true);
    expect(prep.parentRunId).toBeUndefined();
    expect(prep.lanes).toHaveLength(1);
    expect(prep.lanes![0].input).toEqual({ prompt: 'crunch the numbers' });

    child.resolve({ success: true, outputText: 'the answer is 42' });
    await detachedJobRegistry.get(handle.taskId)?.promise;
    await flush();

    const done = await getTask(handle.taskId);
    expect(done!.status).toBe('completed');
    expect(done!.outputText).toBe('the answer is 42');
    expect(detachedJobRegistry.has(handle.taskId)).toBe(false);
  });

  it('falls back to the node prompt template when no task argument is supplied', async () => {
    runSubflowLanesMock.mockResolvedValue({ success: true, outputText: 'ok' });
    seedParent();

    const started = await executeDetachedSubflowStart(TOOL, {}, { conversationId: 'conv-parent' });
    expect(started.success).toBe(true);
    // The worker is launched without being awaited, so let the job settle first.
    await detachedJobRegistry.get((started.data as { taskId: string }).taskId)?.promise;
    const prep = runSubflowLanesMock.mock.calls[0][0] as SubflowNodePrepResult;
    expect(prep.lanes![0].input).toEqual({ prompt: 'default task' });
  });

  it('records a child failure as failed/child-error instead of throwing', async () => {
    runSubflowLanesMock.mockResolvedValue({ success: false, error: 'child blew up' });
    seedParent();

    const started = await executeDetachedSubflowStart(TOOL, { task: 'go' }, { conversationId: 'conv-parent' });
    const { taskId } = started.data as { taskId: string };
    await detachedJobRegistry.get(taskId)?.promise;
    await flush();

    const failed = await getTask(taskId);
    expect(failed!.status).toBe('failed');
    expect(failed!.error).toBe('child blew up');
    expect(failed!.failureReason).toBe('child-error');
  });

  it('records a thrown worker error as failed/child-error', async () => {
    runSubflowLanesMock.mockRejectedValue(new Error('worker exploded'));
    seedParent();

    const started = await executeDetachedSubflowStart(TOOL, { task: 'go' }, { conversationId: 'conv-parent' });
    const { taskId } = started.data as { taskId: string };
    await detachedJobRegistry.get(taskId)?.promise;
    await flush();

    const failed = await getTask(taskId);
    expect(failed!.status).toBe('failed');
    expect(failed!.error).toBe('worker exploded');
    expect(failed!.failureReason).toBe('child-error');
  });

  it('refuses to launch past the concurrency cap rather than queueing silently', async () => {
    seedParent();
    for (let i = 0; i < DEFAULT_SUBFLOW_TASK_SETTINGS.maxConcurrentDetachedJobs; i += 1) {
      await createTask({
        status: 'working',
        originConversationId: 'conv-parent',
        flowId: 'flow-child',
        childConversationId: `conv-child-${i}`,
        input: { prompt: 'busy' },
      } as Parameters<typeof createTask>[0]);
    }

    const refused = await executeDetachedSubflowStart(TOOL, { task: 'one too many' }, {
      conversationId: 'conv-parent',
    });
    expect(refused.success).toBe(false);
    expect(refused.error).toContain('Detached job limit reached');
    expect(runSubflowLanesMock).not.toHaveBeenCalled();
  });

  it('refuses an unknown tool name and a conversation-less call', async () => {
    seedParent();
    await expect(executeDetachedSubflowStart('start_subflow_ghost', {}, { conversationId: 'conv-parent' }))
      .resolves.toEqual({ success: false, error: 'Unknown detached subflow tool "start_subflow_ghost".' });
    await expect(executeDetachedSubflowStart(TOOL, {}, {}))
      .resolves.toEqual({ success: false, error: 'No active conversation to start a detached subflow.' });
  });

  it('refuses when the target subflow node has no configured subflowId', async () => {
    seedParent();
    getFlowMock.mockResolvedValue({
      id: 'flow-parent',
      nodes: [{ id: 'subflow-node-1', type: 'subflow', data: { label: 'Worker', properties: {} } }],
      edges: [],
    });

    const result = await executeDetachedSubflowStart(TOOL, { task: 'go' }, { conversationId: 'conv-parent' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('no configured subflowId');
  });
});

describe('subflow_task_get / subflow_task_cancel', () => {
  it('returns a structured error for an unknown task instead of throwing', async () => {
    await expect(executeTaskGet('does-not-exist')).resolves.toEqual({ success: false, error: 'Task not found.' });
    await expect(executeTaskCancel('does-not-exist')).resolves.toEqual({ success: false, error: 'Task not found.' });
  });

  it('cancels a running job and a late child completion cannot resurrect it', async () => {
    const child = deferred<{ success: boolean; outputText?: string }>();
    runSubflowLanesMock.mockReturnValue(child.promise);
    seedParent();

    const started = await executeDetachedSubflowStart(TOOL, { task: 'long job' }, {
      conversationId: 'conv-parent',
    });
    const { taskId } = started.data as { taskId: string };
    const entry = detachedJobRegistry.get(taskId)!;

    const cancelled = await executeTaskCancel(taskId);
    expect(cancelled.success).toBe(true);
    expect((cancelled.data as { status: string }).status).toBe('cancelled');
    expect(entry.controller.signal.aborted).toBe(true);

    child.resolve({ success: true, outputText: 'too late' });
    await entry.promise;
    await flush();

    const final = await getTask(taskId);
    expect(final!.status).toBe('cancelled');
    expect(final!.outputText).toBeUndefined();
  });

  it('surfaces the completed result through the poll tool', async () => {
    runSubflowLanesMock.mockResolvedValue({ success: true, outputText: 'done and dusted' });
    seedParent();

    const started = await executeDetachedSubflowStart(TOOL, { task: 'go' }, { conversationId: 'conv-parent' });
    const { taskId } = started.data as { taskId: string };
    await detachedJobRegistry.get(taskId)?.promise;
    await flush();

    const polled = await executeTaskGet(taskId);
    expect(polled.success).toBe(true);
    const body = polled.data as { task: { status: string; taskId: string }; result?: string };
    expect(body.task.status).toBe('completed');
    expect(body.task.taskId).toBe(taskId);
    expect(body.result).toBe('done and dusted');
  });
});
