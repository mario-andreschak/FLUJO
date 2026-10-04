import { constants, promises as fs, type Stats } from 'node:fs';
import { constants as bufferConstants } from 'node:buffer';

export class PlainFileReadError extends Error {
  constructor(readonly code: 'UNSAFE_FILE' | 'FILE_CHANGED' | 'SIZE_LIMIT') {
    super(code === 'SIZE_LIMIT' ? 'File exceeds the size limit.' : 'File is unsafe or changed while being read.');
    this.name = 'PlainFileReadError';
  }
}

function sameFile(first: Stats, second: Stats): boolean {
  return first.dev === second.dev && first.ino === second.ino
    && first.size === second.size && first.mtimeMs === second.mtimeMs
    && first.ctimeMs === second.ctimeMs && first.mode === second.mode
    && first.nlink === second.nlink;
}

/**
 * Read only from the descriptor whose identity and permissions were admitted.
 * Path checks are repeated after open (including on Windows without NOFOLLOW).
 * Growth cannot increase the allocation beyond the admitted size plus one byte.
 * Parent containment remains the caller's responsibility; this is no OS sandbox.
 */
export async function readPlainFile(file: string, options: {
  expected?: Stats;
  maxBytes?: number;
  ownerOnly?: boolean;
  signal?: AbortSignal;
  verifyPath?: () => Promise<void>;
} = {}): Promise<Buffer> {
  options.signal?.throwIfAborted();
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    const named = await fs.lstat(file);
    if (!opened.isFile() || !named.isFile() || named.isSymbolicLink() || opened.nlink !== 1
        || !sameFile(opened, named) || (options.expected && !sameFile(options.expected, opened))
        || (options.ownerOnly && process.platform !== 'win32' && (opened.mode & 0o077) !== 0)) {
      throw new PlainFileReadError('UNSAFE_FILE');
    }
    const maxBytes = Math.min(options.maxBytes ?? bufferConstants.MAX_LENGTH - 1, bufferConstants.MAX_LENGTH - 1);
    if (!Number.isSafeInteger(opened.size) || opened.size < 0 || opened.size > maxBytes) {
      throw new PlainFileReadError('SIZE_LIMIT');
    }
    await options.verifyPath?.();
    const bytes = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      options.signal?.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, offset, Math.min(bytes.length - offset, 1024 * 1024), offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== opened.size || !sameFile(opened, await handle.stat())) throw new PlainFileReadError('FILE_CHANGED');
    const finalNamed = await fs.lstat(file);
    if (finalNamed.isSymbolicLink() || !sameFile(opened, finalNamed)) throw new PlainFileReadError('FILE_CHANGED');
    await options.verifyPath?.();
    options.signal?.throwIfAborted();
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}
