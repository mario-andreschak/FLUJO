import { promises as fs, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const COPY_CHUNK_BYTES = 64 * 1024;

/** Copy exactly the admitted opened snapshot, without text/base64 materialization. */
export async function copyPayloadSnapshot(source: FileHandle, initial: Stats, filename: string): Promise<string> {
  if (!initial.isFile() || !Number.isSafeInteger(initial.size) || initial.size < 0) {
    throw new Error('Invalid run-resource copy source.');
  }
  let destination: FileHandle | undefined = await fs.open(filename, 'wx');
  let complete = false;
  try {
    const buffer = Buffer.alloc(Math.min(COPY_CHUNK_BYTES, initial.size));
    const hash = createHash('sha256');
    let position = 0;
    while (position < initial.size) {
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, initial.size - position), position);
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
    const final = await source.stat();
    if (final.size !== initial.size || final.mtimeMs !== initial.mtimeMs) {
      throw new Error('Run-resource copy source changed during its read.');
    }
    await destination.close();
    destination = undefined;
    complete = true;
    return hash.digest('hex');
  } finally {
    await destination?.close().catch(() => undefined);
    // A failed copy is never published and cannot leave a partial new payload.
    if (!complete) await fs.unlink(filename).catch(() => undefined);
  }
}
