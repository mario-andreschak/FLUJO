import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import {
  assertModelCatalogFilesystemLeaseOwned,
  ModelCatalogBusyError,
  retireIdleModelCatalogReader,
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
async function readers() {
  return (await locks()).filter(name => name.startsWith('.model-catalog-reader-'));
}
const ENV = ['FLUJO_MODEL_CATALOG_READER_IDLE_MS', 'FLUJO_MODEL_CATALOG_WRITER_WAIT_MS'] as const;
let savedEnv: Array<string | undefined>;

beforeEach(async () => {
  savedEnv = ENV.map(name => process.env[name]);
  for (const name of ENV) delete process.env[name];
  mockDbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-catalog-lease-lifetime-'));
  savedIdentity = global.__flujo_enduring_agent_process_birth_marker_v2;
  global.__flujo_enduring_agent_process_birth_marker_v2 = Promise.resolve('win32-v2:638927322190000000');
});
afterEach(async () => {
  await retireIdleModelCatalogReader();
  ENV.forEach((name, index) => {
    if (savedEnv[index] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[index];
  });
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
    // A reader's registration stays published for the next model call.
    expect(await readers()).toHaveLength(kind === 'reader' ? 1 : 0);
    expect((await locks()).length).toBe(kind === 'reader' ? 1 : 0);
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
    expect(await readers()).toHaveLength(1);
    // A catalog edit of this process retires the idle registration at once.
    await expect(writerLease(async () => 'edited')).resolves.toBe('edited');
    expect(await locks()).toEqual([]);
  });

  it('lets concurrent model calls of one process share one reader registration (#757)', async () => {
    const inside = deferred();
    const finish = deferred();
    let entered = 0;
    const calls = Array.from({ length: 8 }, () => readerLease(async () => {
      if (++entered === 8) inside.resolve();
      await finish.promise;
      await assertModelCatalogFilesystemLeaseOwned();
    }));
    await inside.promise;
    expect(await readers()).toHaveLength(1);
    // An edit waits for the running calls instead of being refused at once.
    let edited = false;
    const edit = writerLease(async () => { edited = true; return 'edited'; });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(edited).toBe(false);
    finish.resolve();
    await Promise.all(calls);
    await expect(edit).resolves.toBe('edited');
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
    expect(await readers()).toHaveLength(1);
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

  it('keeps one reader registration for model calls that follow each other (#1408)', async () => {
    const seen: string[][] = [];
    for (let call = 0; call < 3; call++) {
      await readerLease(async () => {
        await assertModelCatalogFilesystemLeaseOwned();
        seen.push(await readers());
      });
    }
    expect(seen[0]).toHaveLength(1);
    expect(seen).toEqual([seen[0], seen[0], seen[0]]);
    expect(await readers()).toEqual(seen[0]);
  });

  it('releases the registration after every call when its idle time is 0', async () => {
    process.env.FLUJO_MODEL_CATALOG_READER_IDLE_MS = '0';
    await readerLease(async () => { expect(await readers()).toHaveLength(1); });
    expect(await locks()).toEqual([]);
  });

  it('retires an idle registration when its idle time ends', async () => {
    process.env.FLUJO_MODEL_CATALOG_READER_IDLE_MS = '60';
    await readerLease(async () => undefined);
    expect(await readers()).toHaveLength(1);
    for (let wait = 0; wait < 100 && (await readers()).length; wait++) await new Promise(resolve => setTimeout(resolve, 20));
    expect(await locks()).toEqual([]);
  });

  it('retires an idle registration while another process waits to edit the catalog', async () => {
    await readerLease(async () => undefined);
    expect(await readers()).toHaveLength(1);
    // Another process's writer holds the admission lock while it waits for readers.
    const admission = path.join(mockDbDir, '.runtime-locks', 'enduring-agents', '.model-catalog-admission.lock');
    await fs.writeFile(admission, '{}');
    try {
      for (let wait = 0; wait < 100 && (await readers()).length; wait++) await new Promise(resolve => setTimeout(resolve, 20));
      expect(await readers()).toEqual([]);
    } finally {
      await fs.rm(admission, { force: true });
    }
  });

  it('refuses an edit when a model call outlasts the bounded wait, and admits calls again', async () => {
    process.env.FLUJO_MODEL_CATALOG_WRITER_WAIT_MS = '100';
    const inside = deferred();
    const finish = deferred();
    const call = readerLease(async () => {
      inside.resolve();
      await finish.promise;
      await assertModelCatalogFilesystemLeaseOwned();
    });
    await inside.promise;
    await expect(writerLease(async () => 'edited')).rejects.toBeInstanceOf(ModelCatalogBusyError);
    finish.resolve();
    await call;
    await expect(readerLease(async () => 'next call')).resolves.toBe('next call');
    await expect(writerLease(async () => 'edited')).resolves.toBe('edited');
  });
});
