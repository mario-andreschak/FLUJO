// These deterministic tests exercise the in-process admission race. Separate
// workspaceProcessGate tests run the real filesystem protocol in two processes.
jest.mock('@/backend/services/enduringAgents/runtimeLock', () => ({
  withWorkspaceProcessMutation: (task: () => Promise<unknown>) => task(),
  withWorkspaceProcessSnapshot: (task: (lock: { assertOwned(): Promise<void> }) => Promise<unknown>) => task({ assertOwned: async () => undefined }),
}));

import * as runtimeLock from '@/backend/services/enduringAgents/runtimeLock';
import { runWithWorkspace } from '@/utils/workspace';

import {
  beginWorkspaceSnapshotBoundary,
  withWorkspaceMutation,
  withWorkspaceRecoveryMutation,
  withWorkspaceRecoveryCapture,
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


describe('workspace participant lifetimes', () => {
  it.each([false, true])('drains started nested writes after root failure=%s', async fail => {
    await runWithWorkspace(`nested-drain-${fail}`, async () => {
      const started = deferred<void>();
      const finish = deferred<void>();
      let child!: Promise<void>;
      const root = withWorkspaceMutation(async () => {
        child = withWorkspaceMutation(async () => { started.resolve(); await finish.promise; });
        await started.promise;
        if (fail) throw new Error('root failure');
      });
      const outcome = root.then(() => 'success', () => 'failure');
      await started.promise;
      await flushMicrotasks();
      expect(workspaceMutationStatus().activeMutations).toBe(1);
      let captured = false;
      const capture = beginWorkspaceSnapshotBoundary().then(boundary => { captured = true; return boundary; });
      await flushMicrotasks();
      expect(captured).toBe(false);
      finish.resolve();
      await child;
      expect(await outcome).toBe(fail ? 'failure' : 'success');
      (await capture).release();
    });
  });

  it('rejects a retired ancestor even while a sibling retains admission', async () => {
    await runWithWorkspace('retired-ancestor', async () => {
      const hold = deferred<void>();
      const ready = deferred<void>();
      const late = deferred<void>();
      let sibling!: Promise<void>;
      let descendant!: Promise<unknown>;
      const write = jest.fn(async () => undefined);
      const root = withWorkspaceMutation(async () => {
        sibling = withWorkspaceMutation(async () => { ready.resolve(); await hold.promise; });
        descendant = (async () => { await late.promise; return withWorkspaceMutation(write); })();
        await ready.promise;
      });
      await ready.promise;
      await flushMicrotasks();
      late.resolve();
      await expect(descendant).rejects.toThrow('context has finished');
      expect(write).not.toHaveBeenCalled();
      expect(workspaceMutationStatus().activeMutations).toBe(1);
      hold.resolve();
      await sibling;
      await root;
    });
  });

  it('keeps cancellation admission until a started recovery child settles and captures the original signal', async () => {
    await runWithWorkspace('recovery-cancel', async () => {
      const controller = new AbortController();
      const options = { signal: controller.signal };
      const ready = deferred<void>();
      const finish = deferred<void>();
      let child!: Promise<unknown>;
      let lateCheck!: () => Promise<void>;
      const root = withWorkspaceRecoveryMutation(async operation => {
        lateCheck = operation.assertOwned;
        child = withWorkspaceMutation(async () => { ready.resolve(); await finish.promise; });
        void child.catch(() => undefined);
        await ready.promise;
        options.signal = new AbortController().signal;
        controller.abort(new Error('SECRET abort reason'));
      }, options);
      const outcome = root.catch(error => error as Error);
      await ready.promise;
      await flushMicrotasks();
      expect(workspaceMutationStatus().blocked).toBe(true);
      await expect(lateCheck()).rejects.toThrow(/cancelled|finished/);
      const outsider = jest.fn(async () => undefined);
      const queued = withWorkspaceMutation(outsider);
      await flushMicrotasks();
      expect(outsider).not.toHaveBeenCalled();
      finish.resolve();
      await expect(child).rejects.toThrow('cancelled');
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain('SECRET');
      await queued;
      expect(outsider).toHaveBeenCalledTimes(1);
      await expect(lateCheck()).rejects.toThrow('finished');
    });
  });
});


it('a read capture cannot borrow write authority or deadlock on its own admission', async () => {
  await runWithWorkspace('capture-is-read-only', async () => {
    const write = jest.fn(async () => undefined);
    await withWorkspaceRecoveryCapture(async () => {
      await expect(withWorkspaceMutation(write)).rejects.toThrow('cannot write from a read capture');
    });
    expect(write).not.toHaveBeenCalled();
    await withWorkspaceMutation(write);
    expect(write).toHaveBeenCalledTimes(1);
  });
});

it('explicit workspace admission binds callbacks to the selected workspace', async () => {
  await runWithWorkspace('outer-workspace', async () => {
    await withWorkspaceMutation(async () => {
      expect(workspaceMutationStatus('selected-workspace').activeMutations).toBe(1);
      await withWorkspaceMutation(async () => undefined);
    }, 'selected-workspace');
    expect(workspaceMutationStatus('selected-workspace').activeMutations).toBe(0);
  });
});


it('retires the root recovery capability while an admitted child still owns its participant', async () => {
  await runWithWorkspace('retired-recovery-root', async () => {
    const ready = deferred<void>();
    const finish = deferred<void>();
    let child!: Promise<void>;
    let assertOwned!: () => Promise<void>;
    const root = withWorkspaceRecoveryMutation(async operation => {
      assertOwned = operation.assertOwned;
      child = withWorkspaceMutation(async () => { ready.resolve(); await finish.promise; });
      await ready.promise;
    });
    await ready.promise;
    await flushMicrotasks();
    await expect(assertOwned()).rejects.toThrow('finished');
    expect(workspaceMutationStatus().blocked).toBe(true);
    finish.resolve();
    await child;
    await root;
  });
});

it('rechecks cancellation after awaited physical ownership before invoking recovery effects', async () => {
  await runWithWorkspace('cancel-during-owned-check', async () => {
    const checking = deferred<void>();
    const release = deferred<void>();
    const controller = new AbortController();
    const assertOwned = async () => { checking.resolve(); await release.promise; };
    const snapshot = jest.spyOn(runtimeLock, 'withWorkspaceProcessSnapshot').mockImplementationOnce(async task => task({ assertOwned }));
    const effect = jest.fn(async () => undefined);
    const root = withWorkspaceRecoveryMutation(effect, { signal: controller.signal });
    const outcome = root.catch(error => error as Error);
    await checking.promise;
    controller.abort(new Error('PRIVATE abort payload'));
    release.resolve();
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('cancelled');
    expect((error as Error).message).not.toContain('PRIVATE');
    expect(effect).not.toHaveBeenCalled();
    expect(workspaceMutationStatus().blocked).toBe(false);
    snapshot.mockRestore();
  });
});
