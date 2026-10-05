import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { writeFileAtomic } from '@/utils/storage/backend';

// Windows opens files without FILE_SHARE_DELETE, so any concurrent reader of the
// target — including FLUJO's own polling loads — makes the atomic write's
// rename fail with EPERM until that reader's handle closes. writeFileAtomic
// retries rather than losing the write; these tests pin that contract without
// depending on real filesystem timing.
describe('writeFileAtomic rename retries', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-atomic-write-'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  function errno(code: string): NodeJS.ErrnoException {
    const error = new Error(`simulated ${code}`) as NodeJS.ErrnoException;
    error.code = code;
    return error;
  }

  it.each(['EPERM', 'EBUSY', 'EACCES'])(
    'survives a burst of %s rename failures and still lands the content',
    async (code) => {
      const target = path.join(dir, 'item.json');
      const realRename = fs.rename.bind(fs);
      let failures = 0;
      // More consecutive failures than the old 5-attempt budget tolerated.
      jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (failures < 8) {
          failures += 1;
          throw errno(code);
        }
        return realRename(from as string, to as string);
      });

      await writeFileAtomic(target, '{"n":1}');

      expect(failures).toBe(8);
      await expect(fs.readFile(target, 'utf-8')).resolves.toBe('{"n":1}');
    },
  );

  it('surfaces a non-retryable rename failure immediately', async () => {
    const target = path.join(dir, 'item.json');
    const rename = jest.spyOn(fs, 'rename').mockRejectedValue(errno('ENOSPC'));

    await expect(writeFileAtomic(target, '{"n":1}')).rejects.toMatchObject({ code: 'ENOSPC' });

    expect(rename).toHaveBeenCalledTimes(1);
    // A failed write must not leave its temp file behind.
    await expect(fs.readdir(dir)).resolves.toEqual([]);
  });

  it('gives up after the retry budget and cleans up the temp file', async () => {
    const target = path.join(dir, 'item.json');
    const rename = jest.spyOn(fs, 'rename').mockRejectedValue(errno('EPERM'));

    await expect(writeFileAtomic(target, '{"n":1}')).rejects.toMatchObject({ code: 'EPERM' });

    expect(rename).toHaveBeenCalledTimes(15);
    await expect(fs.readdir(dir)).resolves.toEqual([]);
  });

  it('refuses a pre-created temporary file without overwriting or deleting it', async () => {
    const target = path.join(dir, 'item.json');
    const open = fs.open.bind(fs);
    let planted: string | undefined;
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (String(args[0]).startsWith(`${target}.tmp.`)) {
        planted = String(args[0]);
        await fs.writeFile(planted, 'unowned');
      }
      return open(...args);
    });
    await expect(writeFileAtomic(target, 'replacement')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(planted!, 'utf8')).toBe('unowned');
    expect(await fs.readdir(dir)).toHaveLength(1);
  });

  it('publishes private file permissions on POSIX', async () => {
    const target = path.join(dir, 'item.json');
    await writeFileAtomic(target, 'replacement');
    if (process.platform !== 'win32') expect((await fs.stat(target)).mode & 0o077).toBe(0);
    expect(await fs.readFile(target, 'utf8')).toBe('replacement');
  });

  it('refuses a changed temporary inode before retrying rename and preserves its replacement', async () => {
    const target = path.join(dir, 'item.json');
    let replacement: string | undefined;
    const rename = fs.rename.bind(fs);
    jest.spyOn(fs, 'rename').mockImplementation(async (from) => {
      replacement = String(from);
      await rename(from, `${from}.original`);
      await fs.writeFile(replacement, 'unowned replacement');
      throw errno('EPERM');
    });
    await expect(writeFileAtomic(target, 'intended')).rejects.toThrow('file or parent changed');
    expect(await fs.readFile(replacement!, 'utf8')).toBe('unowned replacement');
    expect(await fs.readFile(`${replacement}.original`, 'utf8')).toBe('intended');
    expect(await fs.readdir(dir)).not.toContain('item.json');
  });

  it('rejects a parent inode change hidden by numeric Stats rounding', async () => {
    const target = path.join(dir, 'item.json');
    const lstat = fs.lstat.bind(fs);
    const colliding = BigInt('9007199254740992');
    expect(Number(colliding)).toBe(Number(colliding + BigInt(1)));
    let checked = false;
    jest.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      const value = await lstat(...args);
      if (String(args[0]) === dir) {
        expect(args[1]).toEqual({ bigint: true });
        const ino = checked ? colliding + BigInt(1) : colliding;
        checked = true;
        return Object.assign(Object.create(Object.getPrototypeOf(value)), value, { ino });
      }
      return value;
    });
    await expect(writeFileAtomic(target, 'intended')).rejects.toThrow('file or parent changed');
    expect(await fs.readdir(dir)).toEqual([]);
  });
});
