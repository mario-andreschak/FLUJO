import { constants, promises as fs } from 'fs';
import { AsyncLocalStorage } from 'async_hooks';
import { getHeapStatistics } from 'v8';
import { createGunzip } from 'zlib';

const READ_CHUNK_BYTES = 64 * 1024;

/** Match existing media/cache byte ceilings and the resource-index read count. */
export const MODEL_TURN_ARCHIVE_READ_LIMITS = Object.freeze({
  concurrentReads: 4,
  compressedSnapshotBytes: 32 * 1024 * 1024,
  decodedSnapshotBytes: 64 * 1024 * 1024,
  mediaBytes: 32 * 1024 * 1024,
  jsonAllocationBytes: 128 * 1024 * 1024,
  jsonHeapHeadroomBytes: 64 * 1024 * 1024,
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
  __flujoModelTurnArchiveReads?: { active: number; rejected: number; allocated?: number };
  __flujoModelTurnArchiveAllocationScope?: AsyncLocalStorage<{ bytes: number }>;
};
const admission = runtime.__flujoModelTurnArchiveReads ??= { active: 0, rejected: 0 };
admission.allocated ??= 0;
const allocationScope = runtime.__flujoModelTurnArchiveAllocationScope ??= new AsyncLocalStorage<{ bytes: number }>();

function allocationLimit() {
  return new ModelTurnArchiveReadError('MODEL_TURN_ARCHIVE_READ_LIMIT',
    'Model-turn JSON exceeds available inspection allocation. The persisted archive is unchanged.');
}

function reserveJsonAllocation(scope: { bytes: number }, bytes: number) {
  const { heap_size_limit: heapLimit, used_heap_size: heapUsed } = getHeapStatistics();
  if (scope.bytes + bytes > MODEL_TURN_ARCHIVE_READ_LIMITS.jsonAllocationBytes
    || scope.bytes + bytes > heapLimit - heapUsed - MODEL_TURN_ARCHIVE_READ_LIMITS.jsonHeapHeadroomBytes) {
    throw allocationLimit();
  }
  if (admission.allocated! + bytes > MODEL_TURN_ARCHIVE_READ_LIMITS.jsonAllocationBytes) {
    admission.rejected = Math.min(Number.MAX_SAFE_INTEGER, admission.rejected + 1);
    throw new ModelTurnArchiveReadError('MODEL_TURN_ARCHIVE_READ_BUSY',
      'Model-turn JSON allocation is busy. Retry after another archive inspection finishes.');
  }
  admission.allocated! += bytes;
  scope.bytes += bytes;
}

function releaseJsonAllocation(scope: { bytes: number }) {
  admission.allocated! -= scope.bytes;
  scope.bytes = 0;
}

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
  const scope = { bytes: 0 };
  try {
    const result = await allocationScope.run(scope, task);
    signal?.throwIfAborted();
    return result;
  } finally {
    releaseJsonAllocation(scope);
    admission.active -= 1;
  }
}

/** Counters and declared limits only; never conversation ids, paths or payloads. */
export function getModelTurnArchiveReadDiagnostics() {
  return { activeReads: admission.active, rejectedReads: admission.rejected,
    reservedJsonAllocationBytes: admission.allocated!, ...MODEL_TURN_ARCHIVE_READ_LIMITS };
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
  return parseBoundedModelTurnJson<T>(compressed, limits, signal);
}

/** Also usable after a private reader has verified its own descriptor/path identity. */
export async function parseBoundedModelTurnJson<T>(
  compressed: Buffer,
  limits = {
    compressedBytes: MODEL_TURN_ARCHIVE_READ_LIMITS.compressedSnapshotBytes,
    decodedBytes: MODEL_TURN_ARCHIVE_READ_LIMITS.decodedSnapshotBytes,
  },
  signal?: AbortSignal,
): Promise<T> {
  if (!Number.isSafeInteger(limits.decodedBytes) || limits.decodedBytes < 1
    || limits.decodedBytes > MODEL_TURN_ARCHIVE_READ_LIMITS.decodedSnapshotBytes
    || !Number.isSafeInteger(limits.compressedBytes) || limits.compressedBytes < 0
    || limits.compressedBytes > MODEL_TURN_ARCHIVE_READ_LIMITS.compressedSnapshotBytes) {
    throw new RangeError('Invalid model-turn snapshot inspection limits.');
  }
  if (compressed.length > limits.compressedBytes) throw allocationLimit();
  const inherited = allocationScope.getStore();
  const scope = inherited ?? { bytes: 0 };
  // Account for retained chunks, concatenation, two-byte source/parsed strings,
  // and rewrite serialization. Structural tokens receive additional charges;
  // encoded bytes alone cannot bound dense JSON object allocation.
  let inString = false, escaped = false, inScalar = false;
  let total = 0;
  const chunks: Buffer[] = [];
  const decoder = createGunzip({ chunkSize: READ_CHUNK_BYTES });
  try {
    reserveJsonAllocation(scope, compressed.length * 2);
    signal?.throwIfAborted();
    decoder.end(compressed);
    for await (const chunk of decoder) {
      signal?.throwIfAborted();
      const bytes = chunk as Buffer;
      total += bytes.length;
      if (total > limits.decodedBytes) throw new ModelTurnArchiveReadError(
        'MODEL_TURN_ARCHIVE_READ_LIMIT',
        `Model-turn snapshot exceeds the ${limits.decodedBytes}-byte decoded inspection limit. The persisted archive is unchanged.`,
      );
      let allocation = bytes.length * 8;
      for (const byte of bytes) {
        if (inString) {
          if (escaped) escaped = false;
          else if (byte === 92) escaped = true;
          else if (byte === 34) inString = false;
          continue;
        }
        if (byte === 34) { inString = true; inScalar = false; allocation += 64; }
        else if (byte === 123 || byte === 91 || byte === 58 || byte === 44) {
          allocation += 128; inScalar = false;
        } else if (byte === 125 || byte === 93 || byte === 32 || byte === 10 || byte === 13 || byte === 9) {
          inScalar = false;
        } else if (!inScalar) { allocation += 64; inScalar = true; }
      }
      reserveJsonAllocation(scope, allocation);
      chunks.push(bytes);
    }
    signal?.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as T;
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    const closed = decoder.closed ? Promise.resolve() : new Promise<void>(resolve => decoder.once('close', resolve));
    decoder.destroy();
    await closed;
    if (!inherited) releaseJsonAllocation(scope);
  }
}
