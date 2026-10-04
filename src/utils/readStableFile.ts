import { constants, promises as fs, type BigIntStats } from 'node:fs';

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
    && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid
    && left.nlink === right.nlink;
}

/**
 * One bounded descriptor owns all content reads. Verify the requested name,
 * resolved name, and descriptor still identify the same unchanged regular file.
 * Symlink compatibility is explicit for operator-owned host configuration only.
 * Native filesystem errors remain available to callers for ENOENT classification;
 * callers must project fixed diagnostics rather than log their messages.
 */
export async function readStableFile(
  file: string,
  maxBytes: number,
  options: { allowSymbolicLink?: boolean } = {},
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) {
    throw new Error('Invalid file read limit');
  }
  const requested = await fs.lstat(file, { bigint: true });
  if (!requested.isFile() && !(options.allowSymbolicLink && requested.isSymbolicLink())) {
    throw new Error('File read unavailable');
  }
  const resolved = await fs.realpath(file);
  // A path replaced with a FIFO must not block before descriptor type checks.
  const handle = await fs.open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.size > BigInt(maxBytes)
      || (!requested.isSymbolicLink() && !sameFile(requested, opened))) {
      throw new Error('File read unavailable');
    }
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const requestedAfter = await fs.lstat(file, { bigint: true });
    const resolvedAfter = await fs.realpath(file);
    const namedAfter = await fs.lstat(resolved, { bigint: true });
    if (size > maxBytes || BigInt(size) !== opened.size || !sameFile(opened, after)
      || !sameFile(requested, requestedAfter) || resolvedAfter !== resolved
      || !namedAfter.isFile() || namedAfter.isSymbolicLink() || !sameFile(after, namedAfter)) {
      throw new Error('File read unavailable');
    }
    return bytes.subarray(0, size);
  } finally {
    await handle.close();
  }
}
