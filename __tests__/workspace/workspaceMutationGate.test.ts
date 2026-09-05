import {
  beginWorkspaceSnapshotBoundary,
  withWorkspaceMutation,
  workspaceMutationStatus,
  type WorkspaceSnapshotBoundary,
} from '@/backend/services/workspace/workspaceMutationGate';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let count = 0; count < 12; count += 1) await Promise.resolve();
}

describe('workspace snapshot mutation admission', () => {
  beforeEach(() => {
    globalThis.__flujoWorkspaceMutationGates?.clear();
  });

  it('accounts for a waiting writer before a second boundary can finish draining', async () => {
    const workspace = 'admission-race';
    const first = await beginWorkspaceSnapshotBoundary(workspace);
    const finishWriter = deferred<void>();
    const writer = withWorkspaceMutation(() => finishWriter.promise, workspace);

    first.release();
    let secondAcquired = false;
    const second = new Promise<WorkspaceSnapshotBoundary>((resolve, reject) => {
      queueMicrotask(() => {
        void beginWorkspaceSnapshotBoundary(workspace).then((boundary) => {
          secondAcquired = true;
          resolve(boundary);
        }, reject);
      });
    });
    await flushMicrotasks();

    expect(workspaceMutationStatus(workspace)).toMatchObject({ blocked: true, activeMutations: 1 });
    expect(secondAcquired).toBe(false);
    finishWriter.resolve();
    await writer;
    (await second).release();
    expect(workspaceMutationStatus(workspace).blocked).toBe(false);
  });

  it('cancels while draining and admits queued writes without waiting for the old writer', async () => {
    const workspace = 'cancel-drain';
    const finishWriter = deferred<void>();
    const writer = withWorkspaceMutation(() => finishWriter.promise, workspace);
    const controller = new AbortController();
    const boundary = beginWorkspaceSnapshotBoundary(workspace, 30_000, controller.signal);
    const rejected = expect(boundary).rejects.toThrow('cancel drain');
    const queuedWriter = jest.fn(async () => undefined);
    const queued = withWorkspaceMutation(queuedWriter, workspace);

    controller.abort(new Error('cancel drain'));
    await rejected;
    await queued;
    expect(queuedWriter).toHaveBeenCalledTimes(1);
    expect(workspaceMutationStatus(workspace).blocked).toBe(false);
    finishWriter.resolve();
    await writer;
  });

  it('releases an acquired boundary immediately on abort and never releases a later boundary', async () => {
    const workspace = 'cancel-capture';
    const controller = new AbortController();
    const first = await beginWorkspaceSnapshotBoundary(workspace, 30_000, controller.signal);
    controller.abort();
    expect(workspaceMutationStatus(workspace).blocked).toBe(false);
    const second = await beginWorkspaceSnapshotBoundary(workspace);
    first.release();
    expect(workspaceMutationStatus(workspace).blocked).toBe(true);
    second.release();
  });
});
