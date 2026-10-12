import { promises as fs, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { PlainFileReadError, readPlainFile } from '@/utils/readPlainFile';

export class ObservationReadError extends Error {
  constructor(readonly code: 'unsafe-path' | 'budget-exceeded' | 'invalid-json' | 'unavailable') {
    super(code);
  }
}

/** Read-only diagnostic budget; no corrupt-file backup or automatic repair. */
export function boundedJsonReader(root: string, totalBytes = 8 * 1024 * 1024, fileBytes = 2 * 1024 * 1024) {
  if (![totalBytes, fileBytes].every(value => Number.isSafeInteger(value) && value > 0)
      || totalBytes > 8 * 1024 * 1024 || fileBytes > 2 * 1024 * 1024) throw new ObservationReadError('budget-exceeded');
  const boundary = path.resolve(root);
  let remaining = totalBytes;
  return async (relative: string): Promise<unknown | undefined> => {
    const parts = relative.split('/');
    if (!relative || relative.includes('\\') || relative.includes('\0')
        || parts.some(part => !part || part === '.' || part === '..' || part.includes(':'))) {
      throw new ObservationReadError('unsafe-path');
    }
    const file = path.resolve(boundary, ...parts);
    const inside = path.relative(boundary, file);
    if (!inside || path.isAbsolute(inside) || inside === '..' || inside.startsWith(`..${path.sep}`)) {
      throw new ObservationReadError('unsafe-path');
    }
    let admitted = false;
    try {
      const parents: Array<{ directory: string; stats: BigIntStats }> = [];
      let directory = boundary;
      for (const part of ['', ...parts.slice(0, -1)]) {
        directory = path.join(directory, part);
        const stats = await fs.lstat(directory, { bigint: true });
        if (!stats.isDirectory() || stats.isSymbolicLink()) throw new ObservationReadError('unsafe-path');
        parents.push({ directory, stats });
      }
      const before = await fs.lstat(file, { bigint: true });
      admitted = true;
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== BigInt(1)) throw new ObservationReadError('unsafe-path');
      const limit = Math.min(fileBytes, remaining);
      if (limit <= 0 || before.size < BigInt(0) || before.size > BigInt(limit)) throw new ObservationReadError('budget-exceeded');
      // Reserve admitted bytes before any further await, including failed reads.
      remaining -= Number(before.size);
      const verifyPath = async () => {
        for (const parent of parents) {
          const current = await fs.lstat(parent.directory, { bigint: true });
          if (!current.isDirectory() || current.isSymbolicLink()
              || (['dev', 'ino', 'mode', 'uid', 'gid'] as const).some(field => current[field] !== parent.stats[field])) {
            throw new ObservationReadError('unsafe-path');
          }
        }
      };
      const bytes = await readPlainFile(file, { expected: before, maxBytes: limit, verifyPath });
      try { return JSON.parse(bytes.toString('utf8')); }
      catch { throw new ObservationReadError('invalid-json'); }
    } catch (error) {
      if (error instanceof ObservationReadError) throw error;
      if (error instanceof PlainFileReadError) {
        throw new ObservationReadError(error.code === 'SIZE_LIMIT' ? 'budget-exceeded' : 'unsafe-path');
      }
      if (!admitted && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new ObservationReadError('unavailable');
    }
  };
}
