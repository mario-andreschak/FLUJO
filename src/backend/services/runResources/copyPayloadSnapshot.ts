import { promises as fs, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const COPY_CHUNK_BYTES = 64 * 1024;

/** Copy exactly the admitted opened snapshot, without text/base64 materialization. */
export async function copyPayloadSnapshot(source: FileHandle, initial: BigIntStats, filename: string): Promise<string> {
  if (!initial.isFile() || initial.size < BigInt(0) || initial.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Invalid run-resource copy source.');
  }
  // Only an admitted size becomes a numeric buffer length/read offset. Keep
  // descriptor identity and nanosecond timestamps exact through the final check.
  const size = Number(initial.size);
  let destination: FileHandle | undefined = await fs.open(filename, 'wx');
  let owned: BigIntStats | undefined;
  let complete = false;
  try {
    owned = await destination.stat({ bigint: true });
    const buffer = Buffer.alloc(Math.min(COPY_CHUNK_BYTES, size));
    const hash = createHash('sha256');
    let position = 0;
    while (position < size) {
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (!bytesRead) throw new Error('Run-resource copy source changed during its read.');
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written, position + written);
        if (!result.bytesWritten) throw new Error('Run-resource copy made no write progress.');
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    const final = await source.stat({ bigint: true });
    if (!final.isFile() || final.dev !== initial.dev || final.ino !== initial.ino
        || final.size !== initial.size || final.mtimeNs !== initial.mtimeNs || final.ctimeNs !== initial.ctimeNs) {
      throw new Error('Run-resource copy source changed during its read.');
    }
    await destination.close();
    destination = undefined;
    const named = await fs.lstat(filename, { bigint: true });
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== BigInt(1)
        || named.dev !== owned.dev || named.ino !== owned.ino) {
      throw new Error('Run-resource copy destination changed during its write.');
    }
    complete = true;
    return hash.digest('hex');
  } finally {
    await destination?.close().catch(() => undefined);
    // Match the atomic writer's best-effort owned-file cleanup: never remove a
    // replacement observed at this path after our exclusive creation.
    if (!complete && owned) {
      try {
        const current = await fs.lstat(filename, { bigint: true });
        if (current.isFile() && !current.isSymbolicLink() && current.nlink === BigInt(1)
            && current.dev === owned.dev && current.ino === owned.ino) await fs.unlink(filename);
      } catch { /* leave unknown or replaced paths untouched */ }
    }
  }
}
