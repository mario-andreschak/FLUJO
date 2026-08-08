/**
 * Durable detached-subflow task store (#386, Phase 6 step 1).
 *
 * A detached job's handle is the ONLY thing that survives the parent run, so the
 * store's contract is load-bearing: SEP-2663 handle shape, terminal-state
 * bookkeeping, never-throw behaviour on a hostile id, serialized patches (no
 * lost updates), TTL sweep, and the restart reconciliation that turns an
 * orphaned `working` record into an honest `failed`.
 *
 * Storage is mocked at the collection layer (in-memory) but keeps the REAL
 * `assertSafeCollectionId` and `runInWriteChain`, so the path-safety gate and
 * the write serialization under test are the production ones.
 */
jest.mock('@/utils/storage/backend', () => {
  const actual = jest.requireActual('@/utils/storage/backend');
  const items = new Map<string, string>();
  return {
    ...actual,
    __items: items,
    __reset: () => items.clear(),
    saveCollectionItem: jest.fn(async (collection: string, id: string, value: unknown) => {
      actual.assertSafeCollectionId(id);
      // A real write goes through JSON, so clone the same way: callers must not
      // be able to mutate a stored record by holding on to the object.
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
      actual.assertSafeCollectionId(id);
      items.delete(`${collection}/${id}`);
    }),
    loadItem: jest.fn(async (_key: unknown, defaultValue: unknown) => defaultValue),
  };
});

import {
  _clearSubflowTaskSettingsCache,
  buildSubflowTaskUri,
  createTask,
  getTask,
  listTasks,
  parseSubflowTaskUri,
  patchTask,
  reconcileOrphanedTasks,
  requestCancel,
  sweepOldSubflowTasks,
  toTaskHandle,
} from '@/backend/services/subflowTasks';
import { DEFAULT_SUBFLOW_TASK_SETTINGS, SUBFLOW_TASK_SCHEME } from '@/shared/types/subflowTasks';
import * as backend from '@/utils/storage/backend';

const resetStore = () => (backend as unknown as { __reset: () => void }).__reset();

const seed = (overrides: Record<string, unknown> = {}) =>
  createTask({
    originConversationId: 'conv-parent',
    originNodeId: 'node-1',
    flowId: 'flow-child',
    childConversationId: 'conv-child',
    input: { prompt: 'do the thing' },
    ...overrides,
  } as Parameters<typeof createTask>[0]);

beforeEach(() => {
  resetStore();
  _clearSubflowTaskSettingsCache();
});

describe('subflow task handles', () => {
  it('mints a SEP-2663 shaped handle and persists the full record', async () => {
    const task = await seed();
    expect(task).not.toBeNull();

    expect(task!.version).toBe(1);
    expect(task!.status).toBe('working');
    expect(task!.pollInterval).toBe(DEFAULT_SUBFLOW_TASK_SETTINGS.defaultPollIntervalMs);
    expect(task!.uri).toBe(`${SUBFLOW_TASK_SCHEME}${task!.taskId}`);
    expect(task!.createdAt).toBeGreaterThan(0);
    expect(task!.updatedAt).toBe(task!.createdAt);
    expect(task!.completedAt).toBeUndefined();

    const loaded = await getTask(task!.taskId);
    expect(loaded).toEqual(task);
    expect(loaded!.input).toEqual({ prompt: 'do the thing' });
  });

  it('round-trips the task URI and refuses a traversal id', () => {
    const uri = buildSubflowTaskUri('abc-123');
    expect(uri).toBe(`${SUBFLOW_TASK_SCHEME}abc-123`);
    expect(parseSubflowTaskUri(uri)).toBe('abc-123');
    expect(parseSubflowTaskUri(`${SUBFLOW_TASK_SCHEME}../../evil`)).toBeNull();
    expect(parseSubflowTaskUri('flujo://run/conv/res-1')).toBeNull();
    expect(() => buildSubflowTaskUri('../../evil')).toThrow(/Unsafe collection item id/);
  });

  it('never throws on an unsafe or unknown task id', async () => {
    await expect(getTask('../../etc/passwd')).resolves.toBeNull();
    await expect(patchTask('../../etc/passwd', { status: 'failed' })).resolves.toBeNull();
    await expect(getTask('does-not-exist')).resolves.toBeNull();
    await expect(requestCancel('does-not-exist')).resolves.toBeNull();
  });

  it('stamps completedAt on the first terminal transition and pins identity fields', async () => {
    const task = await seed();
    const done = await patchTask(task!.taskId, { status: 'completed', outputText: 'child said hi' });

    expect(done!.status).toBe('completed');
    expect(done!.outputText).toBe('child said hi');
    expect(done!.completedAt).toBeGreaterThanOrEqual(done!.createdAt);
    expect(done!.taskId).toBe(task!.taskId);
    expect(done!.uri).toBe(task!.uri);
    expect(done!.createdAt).toBe(task!.createdAt);

    // A later patch must not re-stamp the completion time.
    const again = await patchTask(task!.taskId, { outputText: 'amended' });
    expect(again!.completedAt).toBe(done!.completedAt);
  });

  it('cancels a working task and leaves a terminal task untouched', async () => {
    const task = await seed();
    const cancelled = await requestCancel(task!.taskId);
    expect(cancelled!.status).toBe('cancelled');
    expect(cancelled!.failureReason).toBe('cancelled');
    expect(cancelled!.cancelRequestedAt).toBeGreaterThan(0);

    const noop = await requestCancel(task!.taskId);
    expect(noop).toEqual(cancelled);

    const finished = await seed();
    await patchTask(finished!.taskId, { status: 'completed' });
    const terminal = await requestCancel(finished!.taskId);
    expect(terminal!.status).toBe('completed');
  });

  it('serializes concurrent patches without losing an update', async () => {
    const task = await seed();
    await Promise.all([
      patchTask(task!.taskId, { outputText: 'a' }),
      patchTask(task!.taskId, { originLogicalRunId: 'run-9' }),
      patchTask(task!.taskId, { status: 'completed' }),
    ]);

    const final = await getTask(task!.taskId);
    expect(final!.outputText).toBe('a');
    expect(final!.originLogicalRunId).toBe('run-9');
    expect(final!.status).toBe('completed');
    expect(final!.completedAt).toBeGreaterThan(0);
  });

  it('lists newest-first and filters by conversation and status', async () => {
    const a = await seed({ originConversationId: 'conv-a' });
    const b = await seed({ originConversationId: 'conv-b' });
    await patchTask(b!.taskId, { status: 'failed', error: 'boom' });

    const all = await listTasks({});
    expect(all).toHaveLength(2);
    expect(all[0].createdAt).toBeGreaterThanOrEqual(all[1].createdAt);

    expect((await listTasks({ conversationId: 'conv-a' })).map((t) => t.taskId)).toEqual([a!.taskId]);
    expect((await listTasks({ status: 'working' })).map((t) => t.taskId)).toEqual([a!.taskId]);
    expect((await listTasks({ status: 'failed' })).map((t) => t.taskId)).toEqual([b!.taskId]);
  });

  it('sweeps only tasks past the retention window', async () => {
    const fresh = await seed();
    const stale = await seed();
    const retentionMs = DEFAULT_SUBFLOW_TASK_SETTINGS.retentionAgeDays * 24 * 60 * 60 * 1_000;
    await patchTask(stale!.taskId, { status: 'completed', expiresAt: Date.now() - retentionMs - 1_000 });

    const { removed } = await sweepOldSubflowTasks();
    expect(removed).toBe(1);
    expect(await getTask(stale!.taskId)).toBeNull();
    expect(await getTask(fresh!.taskId)).not.toBeNull();
  });

  it('reconciles orphaned working tasks after a process restart', async () => {
    const orphan = await seed();
    const finished = await seed();
    await patchTask(finished!.taskId, { status: 'completed' });

    const { failed } = await reconcileOrphanedTasks();
    expect(failed).toBe(1);

    const reconciled = await getTask(orphan!.taskId);
    expect(reconciled!.status).toBe('failed');
    expect(reconciled!.failureReason).toBe('process-restart');
    expect(reconciled!.error).toMatch(/process restart/i);
    expect((await getTask(finished!.taskId))!.status).toBe('completed');
  });

  it('projects a handle that leaks no run payload', async () => {
    const task = await seed();
    const handle = toTaskHandle(task!);
    expect(Object.keys(handle).sort()).toEqual(
      ['createdAt', 'pollInterval', 'status', 'taskId', 'updatedAt', 'uri', 'version'].sort(),
    );
    expect(JSON.stringify(handle)).not.toContain('do the thing');
    expect(JSON.stringify(handle)).not.toContain('conv-parent');
  });
});
