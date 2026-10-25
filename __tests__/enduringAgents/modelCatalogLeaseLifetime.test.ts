import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import {
  assertModelCatalogFilesystemLeaseOwned,
  ModelCatalogBusyError,
  withModelCatalogFilesystemLease,
  withModelCatalogFilesystemWriteLease,
} from '@/backend/services/enduringAgents/runtimeLock';

jest.mock('@/utils/storage/backend', () => ({
  assertSafeCollectionId: jest.fn(),
  runInWriteChain: (_key: string, task: () => Promise<unknown>) => task(),
}));
jest.mock('@/utils/workspace', () => ({
  ensureWorkspaceDirs: jest.fn(async () => undefined),
  getCurrentWorkspace: () => 'catalog-lease-lifetime-test',
  getWorkspaceDbDir: () => mockDbDir,
}));

let mockDbDir: string;
let savedIdentity: Promise<string | null> | undefined;
const readerLease = withModelCatalogFilesystemLease;
const writerLease = withModelCatalogFilesystemWriteLease;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function locks() {
  return fs.readdir(path.join(mockDbDir, '.runtime-locks', 'enduring-agents'));
}

beforeEach(async () => {
  mockDbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-catalog-lease-lifetime-'));
  savedIdentity = global.__flujo_enduring_agent_process_birth_marker_v2;
  global.__flujo_enduring_agent_process_birth_marker_v2 = Promise.resolve('win32-v2:638927322190000000');
});
afterEach(async () => {
  global.__flujo_enduring_agent_process_birth_marker_v2 = savedIdentity;
  if (path.dirname(path.resolve(mockDbDir)) !== path.resolve(os.tmpdir())
      || !path.basename(mockDbDir).startsWith('flujo-catalog-lease-lifetime-')) throw new Error('Unexpected test directory.');
  await fs.rm(mockDbDir, { recursive: true, force: true });
});

describe('model catalog lease dynamic lifetime', () => {
  it.each(['reader', 'writer'] as const)('admits a detached continuation after its inherited %s has released', async kind => {
    const gate = deferred();
    let continuation!: Promise<void>;
    await (kind === 'reader' ? readerLease : writerLease)(async () => {
      // Promise callbacks, like a scheduler timer, inherit the ALS store at
      // registration even when they execute after the creating call returns.
      continuation = gate.promise.then(async () => {
        await expect(assertModelCatalogFilesystemLeaseOwned()).rejects.toThrow();
        await readerLease(async () => {
          await assertModelCatalogFilesystemLeaseOwned();
          expect((await locks()).filter(name => name.startsWith('.model-catalog-reader-'))).toHaveLength(1);
        });
        await writerLease(async () => { await assertModelCatalogFilesystemLeaseOwned(); });
      });
    });
    expect(await locks()).toEqual([]);
    gate.resolve();
    await continuation;
    expect(await locks()).toEqual([]);
  });

  it.each(['reader', 'writer'] as const)('expires an inherited %s even when its callback fails', async kind => {
    const gate = deferred();
    let continuation!: Promise<void>;
    await expect((kind === 'reader' ? readerLease : writerLease)(async () => {
      continuation = gate.promise.then(() => writerLease(async () => { await assertModelCatalogFilesystemLeaseOwned(); }));
      throw new Error('planned callback failure');
    })).rejects.toThrow('planned callback failure');
    gate.resolve();
    await continuation;
    expect(await locks()).toEqual([]);
  });

  it('shares an active reader with awaited children and excludes catalog writes', async () => {
    await readerLease(async () => {
      const originalLocks = await locks();
      await readerLease(async () => {
        await assertModelCatalogFilesystemLeaseOwned();
        expect(await locks()).toEqual(originalLocks);
        await expect(writerLease(async () => undefined)).rejects.toBeInstanceOf(ModelCatalogBusyError);
      });
    });
    expect(await locks()).toEqual([]);
  });

  it('drains an already admitted child before releasing its physical reader', async () => {
    const started = deferred();
    const finish = deferred();
    let child!: Promise<void>;
    let parentFinished = false;
    const parent = readerLease(async () => {
      child = readerLease(async () => {
        started.resolve();
        await finish.promise;
        await assertModelCatalogFilesystemLeaseOwned();
      });
      await started.promise;
    }).then(() => { parentFinished = true; });
    await started.promise;
    await new Promise(resolve => setImmediate(resolve));
    expect(parentFinished).toBe(false);
    finish.resolve();
    await Promise.all([parent, child]);
    expect(await locks()).toEqual([]);
  });

  it('does not treat a lost active reader as an expired context to reacquire', async () => {
    await readerLease(async () => {
      const reader = (await locks()).find(name => name.startsWith('.model-catalog-reader-'))!;
      const readFile = fs.readFile.bind(fs);
      const spy = jest.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
        if (String(args[0]).endsWith(reader)) throw Object.assign(new Error('planned observation failure'), { code: 'EIO' });
        return readFile(...args);
      });
      try {
        const task = jest.fn(async () => undefined);
        await expect(readerLease(task)).rejects.toThrow('planned observation failure');
        expect(task).not.toHaveBeenCalled();
      } finally { spy.mockRestore(); }
    });
  });
});
