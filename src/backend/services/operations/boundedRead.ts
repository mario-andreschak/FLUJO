import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

export class ObservationReadError extends Error {
  constructor(readonly code: 'unsafe-path' | 'budget-exceeded' | 'invalid-json' | 'unavailable') {
    super(code);
  }
}

/** Read-only diagnostic budget; no corrupt-file backup or automatic repair. */
export function boundedJsonReader(root: string, totalBytes = 8 * 1024 * 1024, fileBytes = 2 * 1024 * 1024) {
  let remaining = totalBytes;
  return async (relative: string): Promise<unknown | undefined> => {
    const file = path.resolve(root, relative);
    const inside = path.relative(root, file);
    if (!inside || path.isAbsolute(inside) || inside === '..' || inside.startsWith(`..${path.sep}`)) {
      throw new ObservationReadError('unsafe-path');
    }
    let directory = root;
    try {
      for (const part of ['', ...path.relative(root, path.dirname(file)).split(path.sep)]) {
        directory = path.join(directory, part);
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ObservationReadError('unsafe-path');
      }
      const before = await fs.lstat(file);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new ObservationReadError('unsafe-path');
      const limit = Math.min(fileBytes, remaining);
      if (limit <= 0 || before.size > limit) throw new ObservationReadError('budget-exceeded');
      const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev) {
          throw new ObservationReadError('unsafe-path');
        }
        const bytes = Buffer.alloc(limit + 1);
        let length = 0;
        while (length < bytes.length) {
          const result = await handle.read(bytes, length, bytes.length - length, null);
          if (result.bytesRead === 0) break;
          length += result.bytesRead;
        }
        remaining -= length;
        if (length > limit) throw new ObservationReadError('budget-exceeded');
        try { return JSON.parse(bytes.subarray(0, length).toString('utf8')); }
        catch { throw new ObservationReadError('invalid-json'); }
      } finally { await handle.close(); }
    } catch (error) {
      if (error instanceof ObservationReadError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new ObservationReadError('unavailable');
    }
  };
}
