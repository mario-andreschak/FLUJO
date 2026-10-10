import { promises as fs, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { copyPayloadSnapshot } from '@/backend/services/runResources/copyPayloadSnapshot';

let root: string;
let source: FileHandle;
let initial: BigIntStats;
let destination: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-copy-snapshot-'));
  const filename = path.join(root, 'source');
  await fs.writeFile(filename, 'original bytes');
  source = await fs.open(filename, 'r');
  initial = await source.stat({ bigint: true });
  destination = path.join(root, 'destination');
});
afterEach(async () => {
  jest.restoreAllMocks();
  await source.close();
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('flujo-copy-snapshot-')) {
    throw new Error('Unsafe snapshot fixture cleanup');
  }
  await fs.rm(root, { recursive: true, force: true });
});
const copy = () => copyPayloadSnapshot(source, initial, destination);
function statsWith(fields: Partial<BigIntStats>): BigIntStats {
  return Object.assign(Object.create(Object.getPrototypeOf(initial)), initial, fields);
}

it.each(['mtimeNs', 'ctimeNs'] as const)('rejects exact %s drift hidden by numeric millisecond rounding', async field => {
  // Two exact metadata values differing by one ns collapse to the same Number.
  // Real descriptor stats supply all other fields; this seam isolates precision.
  const before = BigInt('1791082000000000000');
  const after = before + BigInt(1);
  expect(Number(before) / 1e6).toBe(Number(after) / 1e6);
  initial = statsWith({ [field]: before });
  jest.spyOn(source, 'stat').mockImplementation(async options => {
    expect(options).toEqual({ bigint: true });
    return statsWith({ [field]: after });
  });
  await expect(copy()).rejects.toThrow('source changed');
  await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([
  ['negative size', { size: BigInt(-1) }],
  ['unsafe numeric size', { size: BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1) }],
  ['nonregular file', { isFile: () => false }],
] as const)('refuses an inadmissible descriptor before allocation or destination creation (%s)', async (_label, fields) => {
  initial = statsWith(fields);
  const open = jest.spyOn(fs, 'open');
  const read = jest.spyOn(source, 'read');
  await expect(copy()).rejects.toThrow('Invalid');
  expect(open).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

async function replaceDestination(mode: 'regular' | 'hardlink') {
  await fs.rename(destination, path.join(root, 'owned-partial'));
  if (mode === 'regular') await fs.writeFile(destination, 'foreign replacement');
  else {
    const foreign = path.join(root, 'foreign');
    await fs.writeFile(foreign, 'foreign replacement');
    await fs.link(foreign, destination);
  }
}

function destinationHook(hook: (handle: FileHandle) => void) {
  const open = fs.open.bind(fs);
  jest.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (args[0] === destination) hook(handle);
    return handle;
  });
}

it.each(['regular', 'hardlink'] as const)('preserves a foreign %s replacement after a failed copy write', async mode => {
  destinationHook(handle => {
    jest.spyOn(handle, 'write').mockImplementation(async () => {
      await replaceDestination(mode);
      throw new Error('Injected copy failure');
    });
  });
  await expect(copy()).rejects.toThrow('Injected copy failure');
  expect(await fs.readFile(destination, 'utf8')).toBe('foreign replacement');
  expect(await fs.readFile(path.join(root, 'owned-partial'), 'utf8')).toBe('');
});

it('preserves a foreign replacement installed during destination close failure', async () => {
  destinationHook(handle => {
    const close = handle.close.bind(handle);
    let closed = false;
    jest.spyOn(handle, 'close').mockImplementation(async () => {
      if (closed) return;
      closed = true;
      await close();
      await replaceDestination('regular');
      throw new Error('Injected close failure');
    });
  });
  await expect(copy()).rejects.toThrow('Injected close failure');
  expect(await fs.readFile(destination, 'utf8')).toBe('foreign replacement');
});

it('refuses publication when the destination pathname changes after a successful write', async () => {
  destinationHook(handle => {
    const write = handle.write.bind(handle);
    jest.spyOn(handle, 'write').mockImplementation(async (...args: Parameters<typeof handle.write>) => {
      const result = await write(...args);
      await replaceDestination('regular');
      return result;
    });
  });
  await expect(copy()).rejects.toThrow('destination changed');
  expect(await fs.readFile(destination, 'utf8')).toBe('foreign replacement');
  expect(await fs.readFile(path.join(root, 'owned-partial'), 'utf8')).toBe('original bytes');
});

it('refuses publication when destination close succeeds after a pathname replacement', async () => {
  destinationHook(handle => {
    const close = handle.close.bind(handle);
    jest.spyOn(handle, 'close').mockImplementation(async () => {
      await close();
      await replaceDestination('regular');
    });
  });
  await expect(copy()).rejects.toThrow('destination changed');
  expect(await fs.readFile(destination, 'utf8')).toBe('foreign replacement');
});

it('removes its own partial payload after write failure', async () => {
  destinationHook(handle => {
    jest.spyOn(handle, 'write').mockImplementation(async () => { throw new Error('Injected copy failure'); });
  });
  await expect(copy()).rejects.toThrow('Injected copy failure');
  await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('leaves an unknown created identity for recovery when descriptor stat fails', async () => {
  destinationHook(handle => {
    jest.spyOn(handle, 'stat').mockRejectedValue(new Error('Injected stat failure'));
  });
  await expect(copy()).rejects.toThrow('Injected stat failure');
  expect(await fs.readFile(destination)).toEqual(Buffer.alloc(0));
});

it('preserves a destination that existed before exclusive creation', async () => {
  await fs.writeFile(destination, 'existing history');
  await expect(copy()).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await fs.readFile(destination, 'utf8')).toBe('existing history');
});
