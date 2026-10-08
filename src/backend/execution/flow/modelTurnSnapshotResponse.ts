import type { FileHandle } from 'fs/promises';
import { createHash } from 'crypto';
import { Readable, Writable, type Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { createGunzip } from 'zlib';
import { LegacyModelTurnOutcomeTransform, type ModelTurnStreamIdentity } from './legacyModelTurnOutcomeStream';
import {
  MODEL_TURN_ARCHIVE_READ_LIMITS, ModelTurnArchiveReadError, ModelTurnArchiveCleanupError,
  recordModelTurnArchiveCleanupFailure, retryModelTurnArchiveCleanup,
} from './modelTurnArchiveReadBudget';
import type { ModelDispatchOutcome } from '@/shared/types/modelTurn';

const CHUNK = 64 * 1024;
export class ModelTurnArchiveChangedError extends Error {
  readonly code = 'MODEL_TURN_ARCHIVE_CHANGED';
  constructor() { super('Model-turn archive changed during inspection. Retry the read.'); }
}
const changed = () => new ModelTurnArchiveChangedError();

export async function closeModelTurnResponseDescriptor(source: FileHandle, primaryError?: unknown) {
  let closeFailure: unknown;
  const close = async () => {
    if (source.fd === -1) return;
    try { await source.close(); }
    catch (error) {
      if (source.fd !== -1) { recordModelTurnArchiveCleanupFailure(); closeFailure = error; throw error; }
    }
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await close(); return; } catch { /* bounded retry of the same owned descriptor */ }
  }
  throw new ModelTurnArchiveCleanupError(retryModelTurnArchiveCleanup(close),
    new AggregateError([primaryError, closeFailure], 'Archive descriptor cleanup failed.'));
}

async function* descriptorChunks(handle: FileHandle, size: number, hash: ReturnType<typeof createHash>,
  verify: () => Promise<void>, signal?: AbortSignal) {
  let offset = 0;
  while (offset <= size) {
    signal?.throwIfAborted();
    await verify();
    const bytes = Buffer.alloc(Math.min(CHUNK, size + 1 - offset));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
    signal?.throwIfAborted();
    await verify();
    if (!bytesRead) break;
    offset += bytesRead;
    if (offset > size) throw changed();
    hash.update(bytes.subarray(0, bytesRead));
    yield bytes.subarray(0, bytesRead);
  }
  if (offset !== size) throw changed();
}

/** Two passes over one held descriptor: validate before headers, then stream.
 * No plaintext spool, transcript object, or complete response string exists. */
export async function prepareModelTurnSnapshotResponse(
  source: FileHandle, identity: ModelTurnStreamIdentity,
  outcome?: Exclude<ModelDispatchOutcome, 'running'>, signal?: AbortSignal,
): Promise<{ body: ReadableStream<Uint8Array>; completed: Promise<void> }> {
  const streams: Array<Readable | Transform> = [];
  let decoding: Promise<void> | undefined;
  let iterator: AsyncIterator<Buffer> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => cleanupPromise ??= (async () => {
    const closures = streams.map(stream => {
      const closed = stream.closed ? Promise.resolve() : new Promise<void>(resolve => stream.once('close', resolve));
      stream.destroy();
      return closed;
    });
    await Promise.allSettled([...closures, ...(decoding ? [decoding] : [])]);
    await closeModelTurnResponseDescriptor(source);
  })();
  try {
    signal?.throwIfAborted();
    const initial = await source.stat({ bigint: true });
    if (!initial.isFile()) throw new Error('Model-turn archive is not a regular file.');
    if (initial.size < BigInt(0) || initial.size > BigInt(MODEL_TURN_ARCHIVE_READ_LIMITS.compressedSnapshotBytes)) {
      throw new ModelTurnArchiveReadError('MODEL_TURN_ARCHIVE_READ_LIMIT',
        'Model-turn archive exceeds compressed inspection limits. The persisted archive is unchanged.');
    }
    let detachedCtime: bigint | undefined;
    const verifyDescriptor = async () => {
      const current = await source.stat({ bigint: true });
      // A producer's atomic replacement can unlink the original held inode.
      // Its bytes/mtime stay pinned; subsequent mutations of it still fail.
      if (initial.nlink === BigInt(1) && current.nlink === BigInt(0) && detachedCtime === undefined) {
        detachedCtime = current.ctimeNs;
      }
      if (current.dev !== initial.dev || current.ino !== initial.ino || current.size !== initial.size
        || current.mtimeNs !== initial.mtimeNs
        || current.nlink !== (detachedCtime === undefined ? initial.nlink : BigInt(0))
        || current.ctimeNs !== (detachedCtime ?? initial.ctimeNs)) throw changed();
    };
    const validatedHash = createHash('sha256');
    const validationInput = Readable.from(descriptorChunks(source, Number(initial.size), validatedHash, verifyDescriptor, signal),
      { objectMode: false, highWaterMark: CHUNK });
    const validationDecoder = createGunzip({ chunkSize: CHUNK });
    const validator = new LegacyModelTurnOutcomeTransform(outcome, identity);
    streams.push(validationInput, validationDecoder, validator);
    let responseBytes = 0;
    await pipeline(validationInput, validationDecoder, validator, new Writable({ write(chunk, _encoding, callback) {
      responseBytes += chunk.length;
      callback(responseBytes > MODEL_TURN_ARCHIVE_READ_LIMITS.decodedSnapshotBytes
        ? new ModelTurnArchiveReadError('MODEL_TURN_ARCHIVE_READ_LIMIT', 'Model-turn response exceeds decoded inspection limits.') : undefined);
    } }), { signal });
    await verifyDescriptor();
    const expectedHash = validatedHash.digest('hex');
    signal?.throwIfAborted();
    let resolveCompleted!: () => void;
    const completed = new Promise<void>(resolve => { resolveCompleted = resolve; });
    let closing: Promise<void> | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const finish = () => closing ??= cleanup().then(() => {
      signal?.removeEventListener('abort', abort);
      resolveCompleted();
    }, error => {
      signal?.removeEventListener('abort', abort);
      if (error instanceof ModelTurnArchiveCleanupError) void error.settled.then(resolveCompleted);
      throw error;
    });
    const fail = async (error: unknown) => {
      controller.error(error);
      try { await finish(); } catch { /* body is errored; cleanup failure remains quarantined */ }
    };
    const abort = () => { void fail(signal?.reason); };
    const body = new ReadableStream<Uint8Array>({
      start(value) { controller = value; signal?.addEventListener('abort', abort, { once: true }); },
      async pull(value) {
        if (closing) return;
        try {
          signal?.throwIfAborted();
          if (!iterator) {
            await verifyDescriptor();
            const hash = createHash('sha256');
            const input = Readable.from(descriptorChunks(source, Number(initial.size), hash, verifyDescriptor, signal),
              { objectMode: false, highWaterMark: CHUNK });
            const decoder = createGunzip({ chunkSize: CHUNK });
            const output = new LegacyModelTurnOutcomeTransform(outcome, identity);
            streams.push(input, decoder, output);
            iterator = output[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
            decoding = pipeline(input, decoder, output, { signal }).then(async () => {
              await verifyDescriptor();
              if (hash.digest('hex') !== expectedHash) throw changed();
            });
            void decoding.catch(() => undefined);
          }
          await verifyDescriptor();
          const next = await iterator.next();
          signal?.throwIfAborted();
          await verifyDescriptor();
          if (closing) return;
          if (next.done) { await decoding; await finish(); value.close(); }
          else value.enqueue(next.value);
        } catch (error) { await fail(signal?.aborted ? signal.reason : error); }
      },
      async cancel() { await finish(); },
    }, { highWaterMark: 0 });
    if (signal?.aborted) abort();
    return { body, completed };
  } catch (error) {
    try { await cleanup(); }
    catch (cleanupError) {
      if (cleanupError instanceof ModelTurnArchiveCleanupError) {
        throw new ModelTurnArchiveCleanupError(cleanupError.settled, new AggregateError([error, cleanupError], 'Archive inspection and cleanup failed.'));
      }
      throw new AggregateError([error, cleanupError], 'Archive inspection and cleanup failed.');
    }
    signal?.throwIfAborted();
    throw error;
  }
}
