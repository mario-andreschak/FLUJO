import { promises as fs } from 'node:fs';
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
    const expected = await fs.lstat(file);
    await fs.rename(file, path.join(root, 'old.json'));
    await fs.writeFile(file, 'external');
    await expect(readPlainFile(file, { expected })).rejects.toMatchObject({ code: 'UNSAFE_FILE' });
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
});
