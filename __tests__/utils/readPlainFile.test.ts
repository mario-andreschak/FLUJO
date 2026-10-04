import { promises as fs, type BigIntStats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPlainFile } from '@/utils/readPlainFile';

describe('descriptor-bound plain file reads', () => {
  let root: string;
  let file: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-plain-read-'));
    file = path.join(root, 'record.json');
    await fs.writeFile(file, 'original', { mode: 0o600 });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reads the admitted ordinary file and rejects a lower size budget', async () => {
    expect((await readPlainFile(file, { maxBytes: 8 })).toString()).toBe('original');
    await expect(readPlainFile(file, { maxBytes: 7 })).rejects.toMatchObject({ code: 'SIZE_LIMIT' });
  });

  it('refuses replacement after the caller checked identity, before reading bytes', async () => {
    const expected = await fs.lstat(file, { bigint: true });
    await fs.rename(file, path.join(root, 'old.json'));
    await fs.writeFile(file, 'external');
    await expect(readPlainFile(file, { expected })).rejects.toMatchObject({ code: 'UNSAFE_FILE', detail: 'expected:ino' });
  });

  it('refuses a named-file replacement after open before any descriptor read', async () => {
    const open = fs.open.bind(fs);
    let read: jest.SpyInstance | undefined;
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      read = jest.spyOn(handle, 'read');
      await fs.rename(file, path.join(root, 'old.json'));
      await fs.writeFile(file, 'external');
      return handle;
    });
    await expect(readPlainFile(file)).rejects.toMatchObject({ code: 'UNSAFE_FILE' });
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects growth and limits the allocation to the admitted length plus one', async () => {
    const open = fs.open.bind(fs);
    let allocation = 0;
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      type PositionalRead = (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number; buffer: Buffer }>;
      // This helper uses Node's positional-buffer overload. Give the spy that
      // contract explicitly rather than Jest inferring the object overload.
      const positional: { read: PositionalRead } = handle;
      const read = positional.read.bind(handle);
      jest.spyOn(positional, 'read').mockImplementation(async (buffer, offset, length, position) => {
        allocation = Math.max(allocation, buffer.byteLength);
        await fs.appendFile(file, Buffer.alloc(1024 * 1024));
        return read(buffer, offset, length, position);
      });
      return handle;
    });
    await expect(readPlainFile(file, { maxBytes: 4096 })).rejects.toMatchObject({ code: 'FILE_CHANGED' });
    expect(allocation).toBe(9);
  });

  it('rejects multiply-linked files', async () => {
    await fs.link(file, path.join(root, 'alias.json'));
    await expect(readPlainFile(file)).rejects.toMatchObject({ code: 'UNSAFE_FILE' });
  });

  it('rejects a caller containment recheck before reading content', async () => {
    const verifyPath = jest.fn(async () => { throw new Error('Outside admitted root'); });
    await expect(readPlainFile(file, { verifyPath })).rejects.toThrow('Outside admitted root');
  });

  (process.platform === 'win32' ? it.skip : it)('refuses symlink leaves and non-private credentials on POSIX', async () => {
    const alias = path.join(root, 'alias.json');
    await fs.symlink(file, alias);
    await expect(readPlainFile(alias)).rejects.toThrow();
    await fs.chmod(file, 0o644);
    await expect(readPlainFile(file, { ownerOnly: true })).rejects.toMatchObject({ code: 'UNSAFE_FILE' });
  });

  function copyStat(stat: BigIntStats, field: 'ino' | 'mtimeNs' | 'ctimeNs', value: bigint): BigIntStats {
    const copy: BigIntStats = Object.assign(Object.create(Object.getPrototypeOf(stat)), stat);
    copy[field] = value;
    return copy;
  }
  const colliding = BigInt('9007199254740992');
  it.each(['ino', 'mtimeNs', 'ctimeNs'] as const)('denies caller-checked %s drift that Number would collapse', async field => {
    const actual = await fs.lstat(file, { bigint: true });
    const expected = copyStat(actual, field, colliding);
    const replacement = copyStat(actual, field, colliding + BigInt(1));
    expect(expected[field]).not.toBe(replacement[field]);
    expect(Number(expected[field])).toBe(Number(replacement[field]));
    const lstat = fs.lstat.bind(fs);
    jest.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      if (String(args[0]) === file) {
        expect(args[1]).toEqual({ bigint: true });
        return replacement;
      }
      return lstat(...args);
    });
    const open = fs.open.bind(fs);
    let read: jest.SpyInstance | undefined;
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      jest.spyOn(handle, 'stat').mockResolvedValue(replacement);
      read = jest.spyOn(handle, 'read');
      return handle;
    });
    await expect(readPlainFile(file, { expected })).rejects.toMatchObject({ code: 'UNSAFE_FILE', detail: `expected:${field}` });
    expect(read).not.toHaveBeenCalled();
  });

  it('denies an opened/named inode collision before content reading', async () => {
    const actual = await fs.lstat(file, { bigint: true });
    const opened = copyStat(actual, 'ino', colliding);
    const named = copyStat(actual, 'ino', colliding + BigInt(1));
    expect(Number(opened.ino)).toBe(Number(named.ino));
    jest.spyOn(fs, 'lstat').mockResolvedValue(named);
    const open = fs.open.bind(fs);
    let read: jest.SpyInstance | undefined;
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      jest.spyOn(handle, 'stat').mockResolvedValue(opened);
      read = jest.spyOn(handle, 'read');
      return handle;
    });
    await expect(readPlainFile(file)).rejects.toMatchObject({ code: 'UNSAFE_FILE', detail: 'descriptor-path:ino' });
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['mtimeNs', 'ctimeNs'] as const)('denies post-read %s drift below Number precision', async field => {
    const actual = await fs.lstat(file, { bigint: true });
    const original = copyStat(actual, field, colliding);
    const changed = copyStat(actual, field, colliding + BigInt(1));
    expect(Number(original[field])).toBe(Number(changed[field]));
    jest.spyOn(fs, 'lstat').mockResolvedValue(original);
    const open = fs.open.bind(fs);
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      jest.spyOn(handle, 'stat').mockResolvedValueOnce(original).mockResolvedValue(changed);
      return handle;
    });
    await expect(readPlainFile(file)).rejects.toMatchObject({ code: 'FILE_CHANGED' });
  });
});
