import { promises as fs } from 'node:fs';

type BoundedFileRead =
  | { status: 'unavailable' }
  | { status: 'too-large'; size: number }
  | { status: 'read'; bytes: Buffer };

/** Check and read one descriptor; pathname replacement cannot change that read. */
export async function readBoundedRegularFile(filePath: string, maxBytes: number): Promise<BoundedFileRead> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes === Number.MAX_SAFE_INTEGER) {
    throw new RangeError('Expected a safe nonnegative file byte limit.');
  }
  const handle = await fs.open(filePath, 'r').catch(() => undefined);
  if (!handle) return { status: 'unavailable' };
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0) return { status: 'unavailable' };
    if (stat.size > maxBytes) return { status: 'too-large', size: stat.size };
    const chunks: Buffer[] = [];
    let total = 0;
    // A file may grow after fstat. Read no more than limit+1 so growth cannot
    // bypass the bound; the extra byte distinguishes exact-limit EOF.
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) return { status: 'too-large', size: Math.max(stat.size, total) };
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return { status: 'read', bytes: Buffer.concat(chunks, total) };
  } finally {
    await handle.close();
  }
}
