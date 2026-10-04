import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { withSnapshotStoreLease } from '@/backend/services/snapshot/snapshotLock';

const mockTransition = jest.fn(async (task: (fence: { assertOwned: () => Promise<void> }) => Promise<unknown>) => task({ assertOwned: async () => undefined }));
jest.mock('@/backend/services/enduringAgents/runtimeLock', () => ({
  getRuntimeProcessIdentity: async () => ({ pid: process.pid, processInstanceId: 'fixture-process' }),
  isRuntimeProcessIdentityAlive: async (identity: { pid: number }) => identity.pid === process.pid,
  withWorkspaceRuntimeLock: async (_name: string, task: (fence: { assertOwned: () => Promise<void> }) => Promise<unknown>) => mockTransition(task),
}));

describe('snapshot lease publication and generation ownership', () => {
  let directory: string;
  let root: string;
  let lock: string;
  beforeEach(async () => {
    mockTransition.mockReset().mockImplementation(async task => task({ assertOwned: async () => undefined }));
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-snapshot-lease-'));
    root = path.join(directory, 'snapshots');
    lock = `${root}.operation-lock`;
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function plantOwner(overrides: Record<string, unknown> = {}) {
    await fs.mkdir(lock, { mode: 0o700 });
    const owner = { pid: process.pid, ownerId: randomUUID(), startedAt: new Date().toISOString(), operation: 'read', ...overrides };
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    return owner;
  }

  it('publishes a complete private owner before the lock becomes visible', async () => {
    const rename = fs.rename.bind(fs);
    let inspected = false;
    jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === lock) {
        const record = JSON.parse(await fs.readFile(path.join(String(from), 'owner.json'), 'utf8'));
        expect(record).toMatchObject({ pid: process.pid, identity: { processInstanceId: 'fixture-process' } });
        expect(record.ownerId).toBeTruthy();
        if (process.platform !== 'win32') {
          expect((await fs.stat(String(from))).mode & 0o077).toBe(0);
          expect((await fs.stat(path.join(String(from), 'owner.json'))).mode & 0o077).toBe(0);
        }
        inspected = true;
      }
      return rename(from, to);
    });
    await withSnapshotStoreLease(root, 'capture', async () => { expect(inspected).toBe(true); });
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('preserves an unknown partial owner and never admits a second operation', async () => {
    await fs.mkdir(lock);
    const task = jest.fn(async () => undefined);
    await expect(withSnapshotStoreLease(root, 'capture', task)).rejects.toMatchObject({ code: 'SNAPSHOT_STORE_BUSY' });
    expect(task).not.toHaveBeenCalled();
    expect((await fs.lstat(lock)).isDirectory()).toBe(true);
    expect(await fs.readdir(lock)).toEqual([]);
  }, 10_000);

  it('does not retire a successor with the same PID when releasing the original generation', async () => {
    let successor: unknown;
    await expect(withSnapshotStoreLease(root, 'capture', async () => {
      await fs.rename(lock, `${lock}.original`);
      successor = await plantOwner();
    })).rejects.toMatchObject({ code: 'SNAPSHOT_STORE_BUSY' });
    expect(JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8'))).toEqual(successor);
    // Failed release must not strand the in-process promise queue.
    await fs.rename(lock, `${lock}.successor`);
    await expect(withSnapshotStoreLease(root, 'read', async () => 'next')).resolves.toBe('next');
  });

  it('retires a proven dead generation and preserves unknown extra files', async () => {
    await plantOwner({ pid: 99999999, identity: { pid: 99999999, processInstanceId: 'dead-fixture' } });
    await fs.writeFile(path.join(lock, 'unexpected'), 'preserve');
    const task = jest.fn(async () => undefined);
    await expect(withSnapshotStoreLease(root, 'read', task)).rejects.toMatchObject({ code: 'ENOTEMPTY' });
    expect(task).not.toHaveBeenCalled();
    const retained = (await fs.readdir(directory)).find(name => name.includes('.retired-'))!;
    expect(await fs.readFile(path.join(directory, retained, 'unexpected'), 'utf8')).toBe('preserve');
  });

  it('allows nested leases without replacing the admitted generation', async () => {
    await withSnapshotStoreLease(root, 'capture', async () => {
      const original = await fs.readFile(path.join(lock, 'owner.json'), 'utf8');
      await withSnapshotStoreLease(root, 'read', async () => {
        expect(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')).toBe(original);
      });
    });
  });

  it('rechecks stale ownership under the canonical transition fence before creating a retirement claim', async () => {
    await plantOwner({ pid: 99999999, identity: { pid: 99999999, processInstanceId: 'dead-fixture' } });
    let successor: unknown;
    mockTransition.mockImplementationOnce(async task => {
      await fs.rename(lock, `${lock}.original`);
      successor = await plantOwner();
      return task({ assertOwned: async () => undefined });
    });
    const task = jest.fn(async () => undefined);
    await expect(withSnapshotStoreLease(root, 'read', task)).rejects.toMatchObject({ code: 'SNAPSHOT_STORE_BUSY' });
    expect(task).not.toHaveBeenCalled();
    expect(await fs.readdir(lock)).toEqual(['owner.json']);
    expect(JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8'))).toEqual(successor);
  }, 10_000);

  it('refuses publication when a candidate and visible directory have colliding numeric inode values', async () => {
    const lstat = fs.lstat.bind(fs);
    const colliding = BigInt('9007199254740992');
    expect(Number(colliding)).toBe(Number(colliding + BigInt(1)));
    jest.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      const value = await lstat(...args);
      if (value.isDirectory() && String(args[0]).startsWith(lock)) {
        expect(args[1]).toEqual({ bigint: true });
        return Object.assign(Object.create(Object.getPrototypeOf(value)), value, {
          ino: String(args[0]) === lock ? colliding + BigInt(1) : colliding,
        });
      }
      return value;
    });
    const task = jest.fn(async () => undefined);
    await expect(withSnapshotStoreLease(root, 'capture', task)).rejects.toMatchObject({ code: 'SNAPSHOT_STORE_BUSY' });
    expect(task).not.toHaveBeenCalled();
    expect(await fs.readdir(lock)).toEqual(['owner.json']);
  });

  it('refuses retirement of a directory replacement with identical owner bytes and a rounded inode collision', async () => {
    const lstat = fs.lstat.bind(fs);
    const colliding = BigInt('9007199254740992');
    let replaced = false;
    let ownerBytes = '';
    jest.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      const value = await lstat(...args);
      if (value.isDirectory() && String(args[0]).startsWith(lock)) {
        expect(args[1]).toEqual({ bigint: true });
        return Object.assign(Object.create(Object.getPrototypeOf(value)), value, { ino: colliding + BigInt(replaced ? 1 : 0) });
      }
      return value;
    });
    await expect(withSnapshotStoreLease(root, 'capture', async () => {
      ownerBytes = await fs.readFile(path.join(lock, 'owner.json'), 'utf8');
      replaced = true;
    })).rejects.toMatchObject({ code: 'SNAPSHOT_STORE_BUSY' });
    expect(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')).toBe(ownerBytes);
    expect(await fs.readdir(lock)).toEqual(['owner.json']);
  });

  it('preserves an unpublished owner replacement whose inode collides as a Number', async () => {
    const colliding = BigInt('9007199254740992');
    expect(Number(colliding)).toBe(Number(colliding + BigInt(1)));
    const open = fs.open.bind(fs);
    const lstat = fs.lstat.bind(fs);
    let candidateOwnerPath = '';
    let replaced = false;
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).startsWith(`${lock}.candidate-`)) {
        candidateOwnerPath = String(args[0]);
        const stat = handle.stat.bind(handle);
        jest.spyOn(handle, 'stat').mockImplementation(async (...options) => {
          const value = await stat(...options);
          return Object.assign(Object.create(Object.getPrototypeOf(value)), value, { ino: colliding });
        });
      }
      return handle;
    });
    jest.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      const value = await lstat(...args);
      if (String(args[0]) === candidateOwnerPath) {
        expect(args[1]).toEqual({ bigint: true });
        return Object.assign(Object.create(Object.getPrototypeOf(value)), value, { ino: colliding + BigInt(replaced ? 1 : 0) });
      }
      return value;
    });
    mockTransition.mockImplementationOnce(async () => {
      replaced = true;
      throw Object.assign(new Error('controlled transition failure'), { code: 'EIO' });
    });
    await expect(withSnapshotStoreLease(root, 'capture', async () => undefined)).rejects.toMatchObject({ code: 'EIO' });
    expect(JSON.parse(await fs.readFile(candidateOwnerPath, 'utf8'))).toMatchObject({ pid: process.pid });
  });

  it('binds the completed owner write after timestamps settle at writer close', async () => {
    const open = fs.open.bind(fs);
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).startsWith(`${lock}.candidate-`) && args[1] === 'wx') {
        const stat = handle.stat.bind(handle);
        jest.spyOn(handle, 'stat').mockImplementation(async (...options) => {
          expect(options).toEqual([{ bigint: true }]);
          const value = await stat({ bigint: true });
          return Object.assign(Object.create(Object.getPrototypeOf(value)), value, {
            mtimeNs: value.mtimeNs - BigInt(100), ctimeNs: value.ctimeNs - BigInt(100),
          });
        });
      }
      return handle;
    });
    const task = jest.fn(async () => 'owned');
    await expect(withSnapshotStoreLease(root, 'capture', task)).resolves.toBe('owned');
    expect(task).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('rejects different authored owner bytes at the same inode and length after writer close', async () => {
    const open = fs.open.bind(fs);
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).startsWith(`${lock}.candidate-`) && args[1] === 'wx') {
        const close = handle.close.bind(handle);
        jest.spyOn(handle, 'close').mockImplementation(async () => {
          await close();
          const original = await fs.readFile(String(args[0]));
          const replacement = Buffer.from(original.toString('utf8').replace('"operation":"capture"', '"operation":"cleanup"'));
          expect(replacement.byteLength).toBe(original.byteLength);
          expect(replacement.equals(original)).toBe(false);
          await fs.writeFile(String(args[0]), replacement);
        });
      }
      return handle;
    });
    const task = jest.fn(async () => undefined);
    await expect(withSnapshotStoreLease(root, 'capture', task)).rejects.toMatchObject({ code: 'SNAPSHOT_STORE_BUSY' });
    expect(task).not.toHaveBeenCalled();
  });

  it('preserves a different inode with identical owner bytes after writer close', async () => {
    const open = fs.open.bind(fs);
    let candidateOwnerPath = '';
    let originalBytes: Buffer | undefined;
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).startsWith(`${lock}.candidate-`) && args[1] === 'wx') {
        candidateOwnerPath = String(args[0]);
        const close = handle.close.bind(handle);
        jest.spyOn(handle, 'close').mockImplementation(async () => {
          await close();
          originalBytes = await fs.readFile(candidateOwnerPath);
          await fs.rename(candidateOwnerPath, `${candidateOwnerPath}.original`);
          await fs.writeFile(candidateOwnerPath, originalBytes, { flag: 'wx', mode: 0o600 });
        });
      }
      return handle;
    });
    const task = jest.fn(async () => undefined);
    await expect(withSnapshotStoreLease(root, 'capture', task)).rejects.toMatchObject({ code: 'SNAPSHOT_STORE_BUSY' });
    expect(task).not.toHaveBeenCalled();
    expect(await fs.readFile(candidateOwnerPath)).toEqual(originalBytes);
    expect(await fs.readFile(`${candidateOwnerPath}.original`)).toEqual(originalBytes);
  });
});
