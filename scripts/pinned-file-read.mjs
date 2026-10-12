import { constants, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino
  && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Bound reads to one regular-file identity, including checks before and after reading. */
export async function readPinnedFile(file, {
  maxBytes, expectedBytes, expectedSha256, signal, check = () => {}, collect = true, root,
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0
    || (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes)
      || expectedBytes < 0 || expectedBytes > maxBytes))) throw new Error('Invalid file byte budget.');
  signal?.throwIfAborted(); check();
  const resolved = path.resolve(file);
  const before = await fs.lstat(resolved, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maxBytes)
    || (expectedBytes !== undefined && before.size !== BigInt(expectedBytes))) {
    throw new Error('Pinned file shape/size changed.');
  }
  const canonical = await fs.realpath(resolved);
  const contained = value => {
    if (!root) return true;
    const relative = path.relative(root, value);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  if (!samePath(canonical, resolved) || !contained(canonical)) throw new Error('Pinned file path changed.');
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await fs.open(resolved, flags);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFile(before, opened)) throw new Error('Pinned file changed during open.');
    const checkPath = async () => {
      const named = await fs.lstat(resolved, { bigint: true });
      const current = await fs.realpath(resolved);
      if (!named.isFile() || named.isSymbolicLink() || !sameFile(opened, named)
        || !samePath(current, canonical) || !contained(current)) throw new Error('Pinned file path changed.');
    };
    await checkPath();
    const budget = expectedBytes ?? Number(opened.size);
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, budget + 1));
    const chunks = [];
    const digest = createHash('sha256');
    let total = 0;
    while (total <= budget) {
      signal?.throwIfAborted(); check();
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, budget + 1 - total), null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > budget) throw new Error('Pinned file grew beyond its byte budget.');
      const bytes = buffer.subarray(0, bytesRead);
      digest.update(bytes);
      if (collect) chunks.push(Buffer.from(bytes));
    }
    if (total !== budget || !sameFile(opened, await handle.stat({ bigint: true }))) {
      throw new Error('Pinned file changed during read.');
    }
    await checkPath();
    signal?.throwIfAborted(); check();
    const sha256 = digest.digest('hex');
    if (expectedSha256 !== undefined && sha256 !== expectedSha256) throw new Error('Pinned file digest changed.');
    return collect ? Buffer.concat(chunks, total) : { bytes: total, sha256 };
  } finally {
    await handle.close();
  }
}
