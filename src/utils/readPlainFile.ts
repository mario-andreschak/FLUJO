import { constants, promises as fs, type BigIntStats } from 'node:fs';
import { constants as bufferConstants } from 'node:buffer';

type IdentityField = 'dev' | 'ino' | 'size' | 'mtimeNs' | 'ctimeNs' | 'mode' | 'uid' | 'gid' | 'nlink';
type AdmissionDetail = 'not-plain-file' | 'hard-linked' | 'permissions'
  | `descriptor-path:${IdentityField}` | `expected:${IdentityField}`;

export class PlainFileReadError extends Error {
  constructor(readonly code: 'UNSAFE_FILE' | 'FILE_CHANGED' | 'SIZE_LIMIT', readonly detail?: AdmissionDetail) {
    super(code === 'SIZE_LIMIT' ? 'File exceeds the size limit.' : 'File is unsafe or changed while being read.');
    this.name = 'PlainFileReadError';
  }
}

function identityDetail(first: BigIntStats, second: BigIntStats): IdentityField | undefined {
  for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink'] as const) {
    if (first[field] !== second[field]) return field;
  }
  return undefined;
}

function sameFile(first: BigIntStats, second: BigIntStats): boolean {
  return first.dev === second.dev && first.ino === second.ino
    && first.size === second.size && first.mtimeNs === second.mtimeNs
    && first.ctimeNs === second.ctimeNs && first.mode === second.mode
    && first.uid === second.uid && first.gid === second.gid
    && first.nlink === second.nlink;
}

/**
 * Read only from the descriptor whose identity and permissions were admitted.
 * Path checks are repeated after open (including on Windows without NOFOLLOW).
 * Growth cannot increase the allocation beyond the admitted size plus one byte.
 * Parent containment remains the caller's responsibility; this is no OS sandbox.
 */
export async function readPlainFile(file: string, options: {
  expected?: BigIntStats;
  maxBytes?: number;
  ownerOnly?: boolean;
  signal?: AbortSignal;
  verifyPath?: () => Promise<void>;
} = {}): Promise<Buffer> {
  options.signal?.throwIfAborted();
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    const named = await fs.lstat(file, { bigint: true });
    if (!opened.isFile() || !named.isFile() || named.isSymbolicLink() || opened.nlink !== BigInt(1)
        || !sameFile(opened, named) || (options.expected && !sameFile(options.expected, opened))
        || (options.ownerOnly && process.platform !== 'win32' && (opened.mode & BigInt(0o077)) !== BigInt(0))) {
      // Only an allowlisted predicate is exposed; no pathname, identity value,
      // owner record or credential is included in the diagnostic.
      const namedDifference = identityDetail(opened, named);
      const expectedDifference = options.expected && identityDetail(options.expected, opened);
      const detail: AdmissionDetail = !opened.isFile() || !named.isFile() || named.isSymbolicLink() ? 'not-plain-file'
        : opened.nlink !== BigInt(1) ? 'hard-linked'
        : namedDifference ? `descriptor-path:${namedDifference}`
        : expectedDifference ? `expected:${expectedDifference}` : 'permissions';
      throw new PlainFileReadError('UNSAFE_FILE', detail);
    }
    const maxBytes = Math.min(options.maxBytes ?? bufferConstants.MAX_LENGTH - 1, bufferConstants.MAX_LENGTH - 1);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || opened.size < BigInt(0) || opened.size > BigInt(maxBytes)) {
      throw new PlainFileReadError('SIZE_LIMIT');
    }
    await options.verifyPath?.();
    // Conversion is only for a size already bounded below Buffer.MAX_LENGTH;
    // filesystem identity and nanosecond timestamps never pass through Number.
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      options.signal?.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, offset, Math.min(bytes.length - offset, 1024 * 1024), offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (BigInt(offset) !== opened.size || !sameFile(opened, await handle.stat({ bigint: true }))) throw new PlainFileReadError('FILE_CHANGED');
    const finalNamed = await fs.lstat(file, { bigint: true });
    if (finalNamed.isSymbolicLink() || !sameFile(opened, finalNamed)) throw new PlainFileReadError('FILE_CHANGED');
    await options.verifyPath?.();
    options.signal?.throwIfAborted();
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}
