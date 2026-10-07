import { constants, promises as fs } from 'fs';
import { promisify } from 'util';
import { gunzip } from 'zlib';

const gunzipAsync = promisify(gunzip);
const READ_CHUNK_BYTES = 64 * 1024;

/** Match existing media/cache byte ceilings and the resource-index read count. */
export const MODEL_TURN_ARCHIVE_READ_LIMITS = Object.freeze({
  concurrentReads: 4,
  compressedSnapshotBytes: 32 * 1024 * 1024,
  decodedSnapshotBytes: 64 * 1024 * 1024,
  mediaBytes: 32 * 1024 * 1024,
});

type ReadErrorCode = 'MODEL_TURN_ARCHIVE_READ_BUSY' | 'MODEL_TURN_ARCHIVE_READ_LIMIT';

export class ModelTurnArchiveReadError extends Error {
  readonly status: 413 | 429;

  constructor(readonly code: ReadErrorCode, message: string) {
    super(message);
    this.name = 'ModelTurnArchiveReadError';
    this.status = code === 'MODEL_TURN_ARCHIVE_READ_BUSY' ? 429 : 413;
  }
}

const runtime = globalThis as typeof globalThis & {
  __flujoModelTurnArchiveReads?: { active: number; rejected: number };
};
const admission = runtime.__flujoModelTurnArchiveReads ??= { active: 0, rejected: 0 };

/** No waiting queue or workspace/id registry may retain rejected read closures. */
export async function withModelTurnArchiveRead<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (admission.active >= MODEL_TURN_ARCHIVE_READ_LIMITS.concurrentReads) {
    admission.rejected = Math.min(Number.MAX_SAFE_INTEGER, admission.rejected + 1);
    throw new ModelTurnArchiveReadError(
      'MODEL_TURN_ARCHIVE_READ_BUSY',
      'Model-turn archive inspection is busy. Retry after another archive read finishes.',
    );
  }
  admission.active += 1;
  try {
    const result = await task();
    signal?.throwIfAborted();
    return result;
  } finally {
    admission.active -= 1;
  }
}

/** Counters and declared limits only; never conversation ids, paths or payloads. */
export function getModelTurnArchiveReadDiagnostics() {
  return { activeReads: admission.active, rejectedReads: admission.rejected, ...MODEL_TURN_ARCHIVE_READ_LIMITS };
}

/** One descriptor and one admitted allocation, including a growth sentinel. */
export async function readBoundedModelTurnFile(file: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MODEL_TURN_ARCHIVE_READ_LIMITS.decodedSnapshotBytes) {
    throw new RangeError('Invalid model-turn archive file inspection limit.');
  }
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    signal?.throwIfAborted();
    const stat = await handle.stat();
    signal?.throwIfAborted();
    if (!stat.isFile()) throw new Error('Model-turn archive is not a regular file.');
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes) {
      throw new ModelTurnArchiveReadError(
        'MODEL_TURN_ARCHIVE_READ_LIMIT',
        `Model-turn archive file exceeds the ${maxBytes}-byte inspection limit. The persisted archive is unchanged.`,
      );
    }
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted();
      const result = await handle.read(bytes, offset, Math.min(READ_CHUNK_BYTES, bytes.length - offset), offset);
      signal?.throwIfAborted();
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    if (offset !== stat.size) throw new Error('Model-turn archive changed during inspection. Retry the read.');
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export async function readBoundedModelTurnJson<T>(
  file: string,
  limits = {
    compressedBytes: MODEL_TURN_ARCHIVE_READ_LIMITS.compressedSnapshotBytes,
    decodedBytes: MODEL_TURN_ARCHIVE_READ_LIMITS.decodedSnapshotBytes,
  },
  signal?: AbortSignal,
): Promise<T> {
  if (!Number.isSafeInteger(limits.decodedBytes) || limits.decodedBytes < 1
    || limits.decodedBytes > MODEL_TURN_ARCHIVE_READ_LIMITS.decodedSnapshotBytes
    || limits.compressedBytes > MODEL_TURN_ARCHIVE_READ_LIMITS.compressedSnapshotBytes) {
    throw new RangeError('Invalid model-turn snapshot inspection limits.');
  }
  const compressed = await readBoundedModelTurnFile(file, limits.compressedBytes, signal);
  let decoded: Buffer;
  try {
    signal?.throwIfAborted();
    decoded = await gunzipAsync(compressed, { maxOutputLength: limits.decodedBytes });
    signal?.throwIfAborted();
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code !== 'ERR_BUFFER_TOO_LARGE') throw error;
    throw new ModelTurnArchiveReadError(
      'MODEL_TURN_ARCHIVE_READ_LIMIT',
      `Model-turn snapshot exceeds the ${limits.decodedBytes}-byte decoded inspection limit. The persisted archive is unchanged.`,
    );
  }
  return JSON.parse(decoded.toString('utf8')) as T;
}
