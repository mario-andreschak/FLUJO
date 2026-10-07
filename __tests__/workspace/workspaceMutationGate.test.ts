import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { runInWriteChain, writeFileAtomic } from '@/utils/storage/backend';

// These deterministic tests exercise the in-process admission race. Separate
// workspaceProcessGate tests run the real filesystem protocol in two processes.
const mockProcessMutation = jest.fn((task: () => Promise<unknown>) => task());
const mockProcessSnapshot = jest.fn((task: (lock: { assertOwned(): Promise<void> }) => Promise<unknown>) => task({ assertOwned: async () => undefined }));

jest.mock('@/backend/services/enduringAgents/runtimeLock', () => ({
  withWorkspaceProcessMutation: (task: () => Promise<unknown>) => mockProcessMutation(task),
  withWorkspaceProcessSnapshot: (task: (lock: { assertOwned(): Promise<void> }) => Promise<unknown>) => mockProcessSnapshot(task),
}));

import { getCurrentWorkspace, runWithWorkspace } from '@/utils/workspace';

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
    mockProcessSnapshot.mockImplementationOnce(async task => task({ assertOwned }));
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

  });
});


it('explicitly rebinds a live inherited A participant from ambient B and restores B afterward', async () => {
  await withWorkspaceMutation(async () => {
    await runWithWorkspace('rebind-b', async () => {
      expect(getCurrentWorkspace()).toBe('rebind-b');
      await withWorkspaceMutation(async () => {
        expect(getCurrentWorkspace()).toBe('rebind-a');
        expect(workspaceMutationStatus('rebind-a').activeMutations).toBe(1);
      }, 'rebind-a');
      expect(getCurrentWorkspace()).toBe('rebind-b');
    });
  }, 'rebind-a');
});

it('refuses predecessor hot-reload contexts without treating their Set as authority', async () => {
  const context = globalThis.__flujoWorkspaceMutationContext!;
  const predecessor = { workspaces: new Set(['legacy-context']) } as unknown as NonNullable<ReturnType<typeof context.getStore>>;
  const effect = jest.fn(async () => undefined);
  await context.run(predecessor, async () => {
    await expect(withWorkspaceMutation(effect, 'legacy-context')).rejects.toThrow('predates the current admission protocol');
    await expect(beginWorkspaceSnapshotBoundary('legacy-context')).rejects.toThrow('predates the current admission protocol');
  });
  expect(effect).not.toHaveBeenCalled();
  await withWorkspaceMutation(effect, 'legacy-context');
  expect(effect).toHaveBeenCalledTimes(1);
});


it('drains a preexisting ordinary writer before exclusive recovery effects', async () => {
  await runWithWorkspace('recovery-existing-writer', async () => {
    const finish = deferred<void>();
    const writer = withWorkspaceMutation(() => finish.promise);
    let entered = false;
    const recovery = withWorkspaceRecoveryMutation(async () => { entered = true; });
    await flushMicrotasks();
    expect(entered).toBe(false);
    expect(workspaceMutationStatus()).toMatchObject({ blocked: true, activeMutations: 1 });
    finish.resolve();
    await writer;
    await recovery;
    expect(entered).toBe(true);
  });
});

it.each([false, true])('retains modeled physical recovery admission through started child drain (root failure=%s)', async fail => {
  await runWithWorkspace(`recovery-physical-drain-${fail}`, async () => {
    let held = false;
    mockProcessSnapshot.mockImplementationOnce(async task => {
      held = true;
      try { return await task({ assertOwned: async () => undefined }); }
      finally { held = false; }
    });
    const ready = deferred<void>();
    const finish = deferred<void>();
    let child!: Promise<void>;
    const root = withWorkspaceRecoveryMutation(async () => {
      child = withWorkspaceMutation(async () => { ready.resolve(); await finish.promise; });
      await ready.promise;
      if (fail) throw new Error('recovery root failure');
    });
    const outcome = root.then(() => 'success', () => 'failure');
    await ready.promise;
    await flushMicrotasks();
    expect(held).toBe(true);
    expect(workspaceMutationStatus().blocked).toBe(true);
    let outsider = false;
    const queued = withWorkspaceMutation(async () => { outsider = true; });
    await flushMicrotasks();
    expect(outsider).toBe(false);
    finish.resolve();
    await child;
    expect(await outcome).toBe(fail ? 'failure' : 'success');
    await queued;
    expect(held).toBe(false);
    expect(outsider).toBe(true);
  });
});

it('redacts physical ownership failure before recovery effects and reopens ordinary admission', async () => {
  await runWithWorkspace('recovery-owner-failure', async () => {
    mockProcessSnapshot.mockImplementationOnce(async task => task({ assertOwned: async () => { throw new Error('PRIVATE physical owner detail'); } }));
    const effect = jest.fn(async () => undefined);
    await expect(withWorkspaceRecoveryMutation(effect)).rejects.toThrow('ownership was lost');
    expect(effect).not.toHaveBeenCalled();
    expect(workspaceMutationStatus().blocked).toBe(false);
    await withWorkspaceMutation(async () => undefined);
  });
});

it('denies final acknowledgement when physical ownership is lost after child effects and drain', async () => {
  await runWithWorkspace('recovery-final-owner-failure', async () => {
    let lost = false;
    mockProcessSnapshot.mockImplementationOnce(async task => task({ assertOwned: async () => { if (lost) throw new Error('PRIVATE final owner detail'); } }));
    const ready = deferred<void>();
    const finish = deferred<void>();
    let child!: Promise<void>;
    const root = withWorkspaceRecoveryMutation(async () => {
      child = withWorkspaceMutation(async () => { ready.resolve(); await finish.promise; lost = true; });
      void child.catch(() => undefined);
      await ready.promise;
      return 'must not acknowledge success';
    });
    const rejected = expect(root).rejects.toThrow('ownership was lost');
    await ready.promise;
    await flushMicrotasks();
    finish.resolve();
    await expect(child).rejects.toThrow('ownership was lost');
    await rejected;
    expect(workspaceMutationStatus().blocked).toBe(false);
  });
});

it.each([false, true])('redacts cancellation before recovery effects (preexisting writer=%s)', async draining => {
  await runWithWorkspace(`recovery-early-cancel-${draining}`, async () => {
    const controller = new AbortController();
    const finish = deferred<void>();
    const writer = draining ? withWorkspaceMutation(() => finish.promise) : undefined;
    if (!draining) controller.abort(new Error('PRIVATE early abort reason'));
    const effect = jest.fn(async () => undefined);
    const root = withWorkspaceRecoveryMutation(effect, { signal: controller.signal });
    const outcome = root.catch(error => error as Error);
    if (draining) controller.abort(new Error('PRIVATE drain abort reason'));
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('cancelled');
    expect((error as Error).message).not.toContain('PRIVATE');
    expect(effect).not.toHaveBeenCalled();
    expect(workspaceMutationStatus().blocked).toBe(false);
    finish.resolve();
    await writer;
    await withWorkspaceMutation(async () => undefined);
  });
});

it('keeps public recovery authority workspace-bound while an explicit inherited write rebinds', async () => {
  await withWorkspaceRecoveryMutation(async operation => {
    await runWithWorkspace('recovery-foreign-b', async () => {
      await expect(operation.assertOwned()).rejects.toThrow('workspace changed');
      await withWorkspaceMutation(async () => { expect(getCurrentWorkspace()).toBe('recovery-selected-a'); }, 'recovery-selected-a');
      expect(getCurrentWorkspace()).toBe('recovery-foreign-b');
    });
  }, { workspace: 'recovery-selected-a' });
});

it('denies a public ownership check that finishes after its root participant retires', async () => {
  await runWithWorkspace('recovery-deferred-public-check', async () => {
    const checking = deferred<void>();
    const finishCheck = deferred<void>();
    const childReady = deferred<void>();
    const finishChild = deferred<void>();
    let holdNext = false;
    let child!: Promise<void>;
    let pending!: Promise<void>;
    mockProcessSnapshot.mockImplementationOnce(async task => task({ assertOwned: async () => {
      if (holdNext) { holdNext = false; checking.resolve(); await finishCheck.promise; }
    } }));
    const root = withWorkspaceRecoveryMutation(async operation => {
      child = withWorkspaceMutation(async () => { childReady.resolve(); await finishChild.promise; });
      await childReady.promise;
      holdNext = true;
      pending = operation.assertOwned();
      await checking.promise;
    });
    await checking.promise;
    await flushMicrotasks();
    const rejected = expect(pending).rejects.toThrow('finished');
    finishCheck.resolve();
    await rejected;
    expect(workspaceMutationStatus().blocked).toBe(true);
    finishChild.resolve();
    await child;
    await root;
  });
});

it('refuses exclusive recovery inside a live ordinary mutation before physical capture', async () => {
  await runWithWorkspace('recovery-inside-writer', async () => {
    const calls = mockProcessSnapshot.mock.calls.length;
    await withWorkspaceMutation(async () => {
      await expect(withWorkspaceRecoveryMutation(async () => undefined)).rejects.toThrow('cannot begin inside a workspace mutation');
    });
    expect(mockProcessSnapshot.mock.calls.length).toBe(calls);
  });
});


it('composes the native per-key queue and atomic writer under recovery without admitting outsiders', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-recovery-queue-'));
  const savedData = process.env.FLUJO_DATA_DIR;
  const savedParent = process.env.FLUJO_PARENT_DATA_DIR;
  process.env.FLUJO_DATA_DIR = fixture;
  delete process.env.FLUJO_PARENT_DATA_DIR;
  const finish = deferred<void>();
  let root: Promise<unknown> | undefined;
  let child: Promise<void> | undefined;
  let outsider: Promise<void> | undefined;
  try {
    await runWithWorkspace('native-recovery-queue', async () => {
      const destination = path.join(getWorkspaceDataDir(), 'db', 'queue-marker.txt');
      const ready = deferred<void>();
      root = withWorkspaceRecoveryMutation(async () => {
        child = runInWriteChain('native-recovery-marker', async () => {
          await writeFileAtomic(destination, 'recovery child bytes');
          ready.resolve();
          await finish.promise;
        });
        await ready.promise;
      });
      await ready.promise;
      await flushMicrotasks();
      outsider = runInWriteChain('native-recovery-marker', async () => writeFileAtomic(destination, 'queued outsider bytes'));
      await flushMicrotasks();
      expect(await fs.readFile(destination, 'utf8')).toBe('recovery child bytes');
      expect(workspaceMutationStatus().blocked).toBe(true);
      finish.resolve();
      await child;
      await root;
      await outsider;
      expect(await fs.readFile(destination, 'utf8')).toBe('queued outsider bytes');
      expect((await fs.readdir(path.dirname(destination))).filter(name => name.includes('.tmp.'))).toEqual([]);
    });
  } finally {
    finish.resolve();
    await Promise.allSettled([root, child, outsider].filter((value): value is Promise<unknown> => value !== undefined));
    if (savedData === undefined) delete process.env.FLUJO_DATA_DIR; else process.env.FLUJO_DATA_DIR = savedData;
    if (savedParent === undefined) delete process.env.FLUJO_PARENT_DATA_DIR; else process.env.FLUJO_PARENT_DATA_DIR = savedParent;
    const relative = path.relative(path.resolve(os.tmpdir()), fixture);
    if (!/^flujo-recovery-queue-[A-Za-z0-9]+$/.test(relative)) throw new Error('Unsafe owned recovery fixture cleanup');
    await fs.rm(fixture, { recursive: true, force: true });
  }
});
