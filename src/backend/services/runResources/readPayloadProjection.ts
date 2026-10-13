import { constants, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

const READ_CHUNK_BYTES = 64 * 1024;

/** Read a bounded UTF-16 text range and optionally hash the complete snapshot.
 * The buffer and retained decoded range do not grow with the payload file.
 * A pathname replacement cannot change which file supplies the bytes. */
export async function readPayloadProjection(
  filename: string,
  options: { text: boolean; maxChars: number; startChar?: number; hash: boolean },
): Promise<{ text: string; truncated: boolean; sha256?: string }> {
  if (!Number.isInteger(options.maxChars) || options.maxChars < 1 || options.maxChars > 200_000) {
    throw new Error('Invalid run-resource text prefix limit.');
  }
  const startChar = options.startChar ?? 0;
  if (!Number.isSafeInteger(startChar) || startChar < 0 || startChar > Number.MAX_SAFE_INTEGER - options.maxChars) {
    throw new Error('Invalid run-resource text offset.');
  }
  // Nonblocking open lets fstat refuse a substituted FIFO rather than waiting
  // for a writer. Windows does not expose O_NONBLOCK.
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const initial = await handle.stat();
    if (!initial.isFile() || !Number.isSafeInteger(initial.size) || initial.size < 0) {
      throw new Error('Invalid run-resource payload file.');
    }
    const hasher = options.hash ? createHash('sha256') : undefined;
    const decoder = options.text ? new StringDecoder('utf8') : undefined;
    const chunks: string[] = [];
    let prefixChars = 0;
    let decodedChars = 0;
    let truncated = false;
    let offset = 0;
    // Binary summaries without verification need existence/type checks only.
    if (decoder || hasher) {
      const buffer = Buffer.alloc(Math.min(READ_CHUNK_BYTES, initial.size));
      const retain = (text: string) => {
        const remaining = options.maxChars - prefixChars;
        const skip = Math.max(0, Math.min(text.length, startChar - decodedChars));
        decodedChars += text.length;
        if (text.length - skip > remaining) truncated = true;
        if (remaining > 0) {
          const prefix = text.slice(skip, skip + remaining);
          if (prefix) chunks.push(prefix);
          prefixChars += prefix.length;
        }
      };
      while (offset < initial.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, initial.size - offset), offset);
        if (!bytesRead) throw new Error('Run-resource payload changed during its read.');
        offset += bytesRead;
        const bytes = buffer.subarray(0, bytesRead);
        hasher?.update(bytes);
        if (decoder && !truncated) retain(decoder.write(bytes));
        // Once truncation is known, a range-only fetch has no reason to scan
        // the remaining bytes. Verification still hashes the complete snapshot.
        if (truncated && !hasher) break;
      }
      if (decoder && !truncated) retain(decoder.end());
    }
    // Never label a prefix hash as complete. Also refuse an in-place write or
    // growth while a full verification was running; atomic replacements leave
    // this descriptor's size/mtime unchanged and its original bytes valid.
    if (hasher) {
      const final = await handle.stat();
      if (final.size !== initial.size || final.mtimeMs !== initial.mtimeMs) {
        throw new Error('Run-resource payload changed during verification.');
      }
    }
    return { text: chunks.join(''), truncated, ...(hasher ? { sha256: hasher.digest('hex') } : {}) };
  } finally {
    await handle.close();
  }
}
