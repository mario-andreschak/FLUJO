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
});
