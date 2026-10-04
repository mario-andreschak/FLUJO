// Process admission is modeled here. Physical filesystem ownership and process
// identity remain the unmodified workspaceProcessGate protocol's responsibility.
const mockProcessMutation = jest.fn();
const mockProcessSnapshot = jest.fn();
const mockAssertOwned = jest.fn();
jest.mock('@/backend/services/enduringAgents/runtimeLock', () => ({
  withWorkspaceProcessMutation: (task: () => Promise<unknown>) => mockProcessMutation(task),
  withWorkspaceProcessSnapshot: (task: (lock: { assertOwned(): Promise<void> }) => Promise<unknown>) => mockProcessSnapshot(task),
}));

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  withWorkspaceMutation,
  withWorkspaceRecoveryCapture,
  withWorkspaceRecoveryMutation,
  workspaceMutationStatus,
  type WorkspaceRecoveryMutation,
} from '@/backend/services/workspace/workspaceMutationGate';
import { getCurrentWorkspace, runWithWorkspace } from '@/utils/workspace';
import { runInWriteChain, writeFileAtomic } from '@/utils/storage/backend';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let count = 0; count < 24; count += 1) await Promise.resolve();
}

async function expectRefusal(promise: Promise<unknown>, code: string, message?: string) {
  const error = await promise.then(() => undefined, caught => caught);
  expect(error).toBeInstanceOf(Error);
  expect(error.code).toBe(code);
  expect(error.cause).toBeUndefined();
  if (message !== undefined) expect(error.message).toBe(message);
  return error;
}

describe('exclusive workspace recovery write admission', () => {
  const held = new Map<string, ReturnType<typeof deferred<void>>>();
  let releases: number;

  beforeEach(() => {
    globalThis.__flujoWorkspaceMutationGates?.clear();
    held.clear();
    releases = 0;
    mockAssertOwned.mockReset().mockResolvedValue(undefined);
    mockProcessMutation.mockReset().mockImplementation(async task => {
      await held.get(getCurrentWorkspace())?.promise;
      return task();
    });
    mockProcessSnapshot.mockReset().mockImplementation(async task => {
      const workspace = getCurrentWorkspace();
      expect(held.has(workspace)).toBe(false);
      const release = deferred<void>();
      held.set(workspace, release);
      try { return await task({ assertOwned: mockAssertOwned }); }
      finally {
        held.delete(workspace);
        releases += 1;
        release.resolve();
      }
    });
  });

  afterEach(() => { expect(held.size).toBe(0); });

  it('permits a real atomic journal write through the ordinary queue without reopening writers', async () => {
    const tempRoot = await fs.realpath(os.tmpdir());
    const root = await fs.mkdtemp(path.join(tempRoot, 'flujo-exclusive-recovery-'));
    const filename = path.join(root, 'journal.json');
    const finish = deferred<void>();
    const entered = deferred<void>();
    let writer: Promise<void> | undefined;
    let recovery: Promise<void> | undefined;
    try {
      recovery = withWorkspaceRecoveryMutation(async operation => {
        expect(operation.workspace).toBe('recovery-atomic');
        expect(Number.isSafeInteger(operation.generation)).toBe(true);
        expect(Object.isFrozen(operation)).toBe(true);
        await operation.assertOwned();
        await runInWriteChain('recovery-journal', () => writeFileAtomic(filename, '{"state":"prepared"}'));
        expect(mockProcessMutation).not.toHaveBeenCalled();
        entered.resolve();
        await finish.promise;
      }, { workspace: 'recovery-atomic' });
      await entered.promise;
      writer = withWorkspaceMutation(() => writeFileAtomic(filename, '{"state":"ordinary"}'), 'recovery-atomic');
      await flush();
      expect(await fs.readFile(filename, 'utf8')).toBe('{"state":"prepared"}');
      expect(workspaceMutationStatus('recovery-atomic')).toMatchObject({ blocked: true, activeMutations: 0 });
      expect(mockProcessMutation).not.toHaveBeenCalled();
      finish.resolve();
      await recovery;
      await writer;
      expect(await fs.readFile(filename, 'utf8')).toBe('{"state":"ordinary"}');
      expect(await fs.readdir(root)).toEqual(['journal.json']);
      expect(mockProcessMutation).toHaveBeenCalledTimes(1);
      expect(releases).toBe(1);
    } finally {
      finish.resolve();
      await Promise.allSettled([recovery, writer].filter(Boolean));
      expect(path.dirname(await fs.realpath(root))).toBe(tempRoot);
      expect((await fs.lstat(root)).isSymbolicLink()).toBe(false);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('drains an admitted writer before giving recovery any exclusive admission', async () => {
    const finish = deferred<void>();
    const writerEntered = deferred<void>();
    const writer = withWorkspaceMutation(async () => { writerEntered.resolve(); await finish.promise; }, 'recovery-drain');
    await writerEntered.promise;
    const task = jest.fn(async () => undefined);
    const recovery = withWorkspaceRecoveryMutation(task, { workspace: 'recovery-drain' });
    try {
      await flush();
      expect(task).not.toHaveBeenCalled();
      expect(mockProcessSnapshot).not.toHaveBeenCalled();
      expect(workspaceMutationStatus('recovery-drain')).toMatchObject({ blocked: true, activeMutations: 1 });
    } finally {
      finish.resolve();
      await writer;
      await recovery;
    }
    expect(task).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('holds process admission until a started nested write settles (root failure=%s)', async failure => {
    const entered = deferred<void>();
    const finish = deferred<void>();
    let child!: Promise<void>;
    let settled = false;
    const recovery = withWorkspaceRecoveryMutation(async () => {
      child = withWorkspaceMutation(async () => { entered.resolve(); await finish.promise; }, 'recovery-child');
      if (failure) throw new Error('Synthetic recovery failure');
    }, { workspace: 'recovery-child' });
    const outcome = recovery.then(() => { settled = true; return 'success'; }, error => {
      settled = true; return (error as Error).message;
    });
    try {
      await entered.promise;
      await flush();
      expect(settled).toBe(false);
      expect(releases).toBe(0);
      expect(held.has('recovery-child')).toBe(true);
      expect(mockProcessMutation).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
      await child;
      await outcome;
    }
    expect(await outcome).toBe(failure ? 'Synthetic recovery failure' : 'success');
    expect(releases).toBe(1);
  });

  it('refuses retired descendants instead of re-admitting staged values as fresh ordinary writes', async () => {
    const resume = deferred<void>();
    const changed = jest.fn(async () => undefined);
    let operation!: WorkspaceRecoveryMutation;
    let descendant!: Promise<string>;
    await withWorkspaceRecoveryMutation(async current => {
      operation = current;
      descendant = resume.promise.then(() => withWorkspaceMutation(changed, 'recovery-retired')).then(
        () => 'unexpected success', error => error.code,
      );
    }, { workspace: 'recovery-retired' });
    resume.resolve();
    expect(await descendant).toBe('RECOVERY_FINISHED');
    await expectRefusal(operation.assertOwned(), 'RECOVERY_FINISHED');
    expect(changed).not.toHaveBeenCalled();
    expect(mockProcessMutation).not.toHaveBeenCalled();
    await withWorkspaceMutation(changed, 'recovery-retired');
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('denies new writes on cancellation and holds modeled process admission until existing native work settles', async () => {
    const controller = new AbortController();
    const entered = deferred<void>();
    const finish = deferred<void>();
    const newWrite = jest.fn(async () => undefined);
    const outsider = jest.fn(async () => undefined);
    let child!: Promise<void>;
    let denied!: Promise<string>;
    const recovery = withWorkspaceRecoveryMutation(async () => {
      child = withWorkspaceMutation(async () => {
        entered.resolve();
        await finish.promise; // Models already-started native IO, which must settle.
      }, 'recovery-cancel');
      await entered.promise;
      controller.abort(new Error('synthetic-sensitive-abort-reason'));
      denied = withWorkspaceMutation(newWrite, 'recovery-cancel').then(() => 'unexpected success', error => error.code);
    }, { workspace: 'recovery-cancel', signal: controller.signal });
    const outcome = recovery.then(() => undefined, error => error);
    let ordinary: Promise<void> | undefined;
    try {
      await entered.promise;
      await flush();
      expect(await denied).toBe('RECOVERY_CANCELLED');
      ordinary = withWorkspaceMutation(outsider, 'recovery-cancel');
      await flush();
      expect(newWrite).not.toHaveBeenCalled();
      expect(outsider).not.toHaveBeenCalled();
      expect(releases).toBe(0);
      expect(held.has('recovery-cancel')).toBe(true);
    } finally {
      finish.resolve();
      await child;
      await outcome;
      await ordinary;
    }
    expect((await outcome).code).toBe('RECOVERY_CANCELLED');
    expect((await outcome).cause).toBeUndefined();
    expect((await outcome).message).not.toContain('synthetic-sensitive-abort-reason');
    expect(outsider).toHaveBeenCalledTimes(1);
    expect(releases).toBe(1);
  });

  it('redacts ownership failure before invoking recovery code and reopens ordinary admission', async () => {
    const task = jest.fn(async () => undefined);
    mockAssertOwned.mockRejectedValueOnce(new Error('synthetic-private-owner-path-and-value'));
    await expectRefusal(withWorkspaceRecoveryMutation(task, { workspace: 'recovery-owner' }), 'RECOVERY_OWNERSHIP',
      'Recovery write ownership was lost; inspect its journal before resuming or rolling back.');
    expect(task).not.toHaveBeenCalled();
    expect(releases).toBe(1);
    expect(workspaceMutationStatus('recovery-owner').blocked).toBe(false);
    await withWorkspaceMutation(task, 'recovery-owner');
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('retains the original cancellation signal when a caller mutates its options object', async () => {
    const controller = new AbortController();
    const options: { workspace: string; signal?: AbortSignal } = { workspace: 'recovery-options', signal: controller.signal };
    const changed = jest.fn(async () => undefined);
    await expectRefusal(withWorkspaceRecoveryMutation(async () => {
      controller.abort(new Error('synthetic-private-abort-value'));
      options.signal = undefined;
      await expectRefusal(withWorkspaceMutation(changed, 'recovery-options'), 'RECOVERY_CANCELLED');
    }, options), 'RECOVERY_CANCELLED');
    expect(changed).not.toHaveBeenCalled();
    expect(releases).toBe(1);
  });

  it('rechecks cancellation after awaiting ownership and never invokes the admitted child effect', async () => {
    const controller = new AbortController();
    const check = deferred<void>();
    const entered = deferred<void>();
    const changed = jest.fn(async () => undefined);
    let child!: Promise<string>;
    const recovery = withWorkspaceRecoveryMutation(async () => {
      mockAssertOwned.mockImplementationOnce(async () => { entered.resolve(); await check.promise; });
      child = withWorkspaceMutation(changed, 'recovery-abort-check').then(() => 'unexpected success', error => error.code);
    }, { workspace: 'recovery-abort-check', signal: controller.signal });
    const outcome = recovery.then(() => undefined, error => error);
    try {
      await entered.promise;
      controller.abort(new Error('synthetic-private-check-abort'));
      await flush();
      expect(changed).not.toHaveBeenCalled();
      expect(releases).toBe(0);
    } finally {
      check.resolve();
      await child;
      await outcome;
    }
    expect(await child).toBe('RECOVERY_CANCELLED');
    expect((await outcome).code).toBe('RECOVERY_CANCELLED');
    expect(changed).not.toHaveBeenCalled();
    expect(releases).toBe(1);
  });

  it('redacts cancellation before acquiring any recovery admission', async () => {
    const controller = new AbortController();
    controller.abort(new Error('synthetic-private-early-abort'));
    const task = jest.fn(async () => undefined);
    await expectRefusal(withWorkspaceRecoveryMutation(task, { workspace: 'recovery-early-abort', signal: controller.signal }),
      'RECOVERY_CANCELLED', 'Recovery write was cancelled; inspect its journal before resuming or rolling back.');
    expect(task).not.toHaveBeenCalled();
    expect(mockProcessSnapshot).not.toHaveBeenCalled();
    expect(workspaceMutationStatus('recovery-early-abort').blocked).toBe(false);
  });

  it('redacts cancellation while draining a pre-existing writer', async () => {
    const controller = new AbortController();
    const finish = deferred<void>();
    const entered = deferred<void>();
    const writer = withWorkspaceMutation(async () => { entered.resolve(); await finish.promise; }, 'recovery-abort-drain');
    await entered.promise;
    const task = jest.fn(async () => undefined);
    const recovery = withWorkspaceRecoveryMutation(task, { workspace: 'recovery-abort-drain', signal: controller.signal });
    const outcome = expectRefusal(recovery, 'RECOVERY_CANCELLED',
      'Recovery write was cancelled; inspect its journal before resuming or rolling back.');
    try {
      controller.abort(new Error('synthetic-private-drain-abort'));
      await outcome;
      expect(task).not.toHaveBeenCalled();
      expect(mockProcessSnapshot).not.toHaveBeenCalled();
      expect(workspaceMutationStatus('recovery-abort-drain').blocked).toBe(false);
    } finally {
      finish.resolve();
      await writer;
    }
  });

  it('checks ownership again before acknowledging completed recovery effects', async () => {
    let effects = 0;
    await expectRefusal(withWorkspaceRecoveryMutation(async () => {
      effects += 1;
      mockAssertOwned.mockRejectedValueOnce(new Error('synthetic-owner-replaced'));
      return 'must not acknowledge';
    }, { workspace: 'recovery-final-owner' }), 'RECOVERY_OWNERSHIP');
    expect(effects).toBe(1); // The future durable journal must recover already-applied effects.
    expect(releases).toBe(1);
  });

  it('binds the ownership capability to its selected workspace and restores explicit nested scope', async () => {
    await withWorkspaceRecoveryMutation(async operation => {
      await runWithWorkspace('recovery-foreign', async () => {
        await expectRefusal(operation.assertOwned(), 'RECOVERY_WORKSPACE');
        await withWorkspaceMutation(async () => {
          expect(getCurrentWorkspace()).toBe('recovery-selected');
          await operation.assertOwned();
        }, 'recovery-selected');
      });
      await withWorkspaceMutation(async () => {
        expect(getCurrentWorkspace()).toBe('recovery-other');
      }, 'recovery-other');
      expect(held.has('recovery-selected')).toBe(true);
    }, { workspace: 'recovery-selected' });
    expect(mockProcessMutation).toHaveBeenCalledTimes(1);
  });

  it('retirement during an awaited public ownership check cannot retain authority', async () => {
    const check = deferred<void>();
    let borrowed!: Promise<string>;
    await withWorkspaceRecoveryMutation(async operation => {
      mockAssertOwned.mockImplementationOnce(() => check.promise);
      borrowed = operation.assertOwned().then(() => 'unexpected success', error => error.code);
    }, { workspace: 'recovery-check-retired' });
    check.resolve();
    expect(await borrowed).toBe('RECOVERY_FINISHED');
    expect(releases).toBe(1);
  });

  it('read capture supplies no nested writer bypass', async () => {
    const changed = jest.fn(async () => undefined);
    let writer!: Promise<void>;
    await withWorkspaceRecoveryCapture(async () => {
      writer = withWorkspaceMutation(changed, 'recovery-read-only');
      await flush();
      expect(changed).not.toHaveBeenCalled();
      expect(mockProcessMutation).not.toHaveBeenCalled();
    }, { workspace: 'recovery-read-only' });
    await writer;
    expect(changed).toHaveBeenCalledTimes(1);
    expect(mockProcessMutation).toHaveBeenCalledTimes(1);
  });

  it('refuses recovery inside an ordinary live mutation', async () => {
    await withWorkspaceMutation(async () => {
      await expect(withWorkspaceRecoveryMutation(async () => undefined, { workspace: 'recovery-self' }))
        .rejects.toThrow('inside a workspace mutation');
    }, 'recovery-self');
    expect(mockProcessSnapshot).not.toHaveBeenCalled();
  });
});
