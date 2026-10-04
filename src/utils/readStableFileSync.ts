import fs, { type BigIntStats } from 'node:fs';

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink']
    .every(field => left[field as keyof BigIntStats] === right[field as keyof BigIntStats]);
}

/** Synchronous authority seams still require one bounded, nonblocking, unchanged descriptor. */
export function readStableFileSync(file: string, maxBytes: number, options: {
  validateOpenedFile?: (stat: Readonly<BigIntStats>, canonicalPath: string) => boolean;
} = {}): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) {
    throw new Error('Invalid file read limit');
  }
  const requested = fs.lstatSync(file, { bigint: true });
  if (!requested.isFile() || requested.isSymbolicLink()) throw new Error('File read unavailable');
  const resolved = fs.realpathSync.native(file);
  const descriptor = fs.openSync(resolved, fs.constants.O_RDONLY
    | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.size < BigInt(0) || opened.size > BigInt(maxBytes) || !sameFile(requested, opened)
        || (options.validateOpenedFile && options.validateOpenedFile(opened, resolved) !== true)) {
      throw new Error('File read unavailable');
    }
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = fs.readSync(descriptor, bytes, size, bytes.length - size, size);
      if (count === 0) break;
      size += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const requestedAfter = fs.lstatSync(file, { bigint: true });
    const resolvedAfter = fs.realpathSync.native(file);
    const namedAfter = fs.lstatSync(resolved, { bigint: true });
    if (size > maxBytes || BigInt(size) !== opened.size || !after.isFile() || !sameFile(opened, after)
        || !sameFile(requested, requestedAfter) || resolvedAfter !== resolved
        || !namedAfter.isFile() || namedAfter.isSymbolicLink() || !sameFile(after, namedAfter)) {
      throw new Error('File read unavailable');
    }
    return bytes.subarray(0, size);
  } finally { fs.closeSync(descriptor); }
}
