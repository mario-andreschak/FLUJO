// These deterministic tests exercise the in-process admission race. Separate
// workspaceProcessGate tests run the real filesystem protocol in two processes.
const mockProcessMutation = jest.fn((task: () => Promise<unknown>) => task());
jest.mock('@/backend/services/enduringAgents/runtimeLock', () => ({
  withWorkspaceProcessMutation: (task: () => Promise<unknown>) => mockProcessMutation(task),
}));

import {
  beginWorkspaceSnapshotBoundary,
  withWorkspaceMutation,
  workspaceMutationStatus,
  type WorkspaceSnapshotBoundary,
} from '@/backend/services/workspace/workspaceMutationGate';
import { getCurrentWorkspace } from '@/utils/workspace';

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
    mockProcessMutation.mockReset().mockImplementation(task => task());
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

  it('requires fresh admission for descendants after their mutation owner settles', async () => {
    const workspace = 'retired-mutation-context';
    const resume = deferred<void>();
    const changed = jest.fn(async () => undefined);
    let descendant!: Promise<void>;
    await withWorkspaceMutation(async () => {
      descendant = resume.promise.then(() => withWorkspaceMutation(changed, workspace));
    }, workspace);
    const boundary = await beginWorkspaceSnapshotBoundary(workspace);
    try {
      resume.resolve();
      await flushMicrotasks();
      expect(changed).not.toHaveBeenCalled();
      expect(workspaceMutationStatus(workspace)).toMatchObject({ activeMutations: 0, blocked: true });
    } finally {
      boundary.release();
      await descendant;
    }
    expect(changed).toHaveBeenCalledTimes(1);
    expect(mockProcessMutation).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('retains local and process admission for a started nested mutation after root completion (failure=%s)', async rootFailure => {
    const workspace = 'nested-mutation-lifetime';
    const finishChild = deferred<void>();
    let processReleased = false;
    let rootSettled = false;
    mockProcessMutation.mockImplementationOnce(async task => {
      try { return await task(); }
      finally { processReleased = true; }
    });
    let child!: Promise<void>;
    const root = withWorkspaceMutation(async () => {
      child = withWorkspaceMutation(() => finishChild.promise, workspace);
      if (rootFailure) throw new Error('Synthetic root failure');
    }, workspace);
    const rootOutcome = root.then(() => { rootSettled = true; return 'success'; }, error => {
      rootSettled = true; return (error as Error).message;
    });
    await flushMicrotasks();
    let snapshotAcquired = false;
    const snapshot = beginWorkspaceSnapshotBoundary(workspace).then(boundary => {
      snapshotAcquired = true;
      return boundary;
    });
    try {
      await flushMicrotasks();
      expect(processReleased).toBe(false);
      expect(rootSettled).toBe(false);
      expect(snapshotAcquired).toBe(false);
      expect(workspaceMutationStatus(workspace)).toMatchObject({ activeMutations: 1, blocked: true });
    } finally {
      finishChild.resolve();
      await child;
      await rootOutcome;
      (await snapshot).release();
    }
    expect(processReleased).toBe(true);
    expect(await rootOutcome).toBe(rootFailure ? 'Synthetic root failure' : 'success');
  });

  it('binds reentrant writes to their explicit workspace inside a second workspace context', async () => {
    let observed: string | undefined;
    await withWorkspaceMutation(() => withWorkspaceMutation(() => withWorkspaceMutation(async () => {
      observed = getCurrentWorkspace();
    }, 'lease-first'), 'lease-second'), 'lease-first');
    expect(observed).toBe('lease-first');
    expect(mockProcessMutation).toHaveBeenCalledTimes(2);
  });

  it('preserves nested errors and retires both gates after the caller handles them', async () => {
    await withWorkspaceMutation(async () => {
      await expect(withWorkspaceMutation(async () => { throw new Error('Synthetic nested failure'); }, 'nested-error'))
        .rejects.toThrow('Synthetic nested failure');
    }, 'nested-error');
    expect(mockProcessMutation).toHaveBeenCalledTimes(1);
    expect(workspaceMutationStatus('nested-error')).toMatchObject({ activeMutations: 0, blocked: false });
    (await beginWorkspaceSnapshotBoundary('nested-error')).release();
  });

  it('refuses capture inside a live lease and allows it from a retired descendant context', async () => {
    const workspace = 'lease-capture-context';
    const resume = deferred<void>();
    let descendant!: Promise<void>;
    await withWorkspaceMutation(async () => {
      await expect(beginWorkspaceSnapshotBoundary(workspace)).rejects.toThrow('inside a workspace mutation');
      descendant = resume.promise.then(async () => { (await beginWorkspaceSnapshotBoundary(workspace)).release(); });
    }, workspace);
    resume.resolve();
    await descendant;
    expect(workspaceMutationStatus(workspace)).toMatchObject({ activeMutations: 0, blocked: false });
  });
});
