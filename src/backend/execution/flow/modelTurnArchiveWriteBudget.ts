import { AsyncLocalStorage } from 'node:async_hooks';
import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { types } from 'node:util';

/** Proposed allocation reservations, not measured V8 heap or an OOM guarantee. */
export const MODEL_TURN_ARCHIVE_WRITE_LIMITS = Object.freeze({
  processBytes: 512 * 1024 * 1024,
  snapshotBytes: 64 * 1024 * 1024,
  writeBytes: 256 * 1024 * 1024,
  concurrentWrites: 4,
  localMediaBytes: 32 * 1024 * 1024,
  inspectedValues: 100_000,
  depth: 64,
});

export class ModelTurnArchiveMemoryError extends Error {
  readonly status: 413 | 429;
  constructor(readonly code: 'MODEL_TURN_ARCHIVE_MEMORY_LIMIT' | 'MODEL_TURN_ARCHIVE_MEMORY_BUSY' | 'MODEL_TURN_ARCHIVE_WRITE_CLEANUP', cause?: unknown) {
    super(code === 'MODEL_TURN_ARCHIVE_MEMORY_BUSY'
      ? 'Model-turn archive allocation is busy; this dispatch boundary did not admit a provider request.'
      : 'Model-turn archive allocation or cleanup is unavailable; canonical history was not discarded.', { cause });
    this.name = 'ModelTurnArchiveMemoryError';
    this.status = code === 'MODEL_TURN_ARCHIVE_MEMORY_BUSY' ? 429 : 413;
  }
}

const runtime = globalThis as typeof globalThis & {
  __flujoArchiveWriteMemory?: { bytes: number; writers: number; rejected: number; quarantined: number };
  __flujoArchiveWriteScope?: AsyncLocalStorage<WriteScope>;
};
const ledger = runtime.__flujoArchiveWriteMemory ??= { bytes: 0, writers: 0, rejected: 0, quarantined: 0 };
const scopes = runtime.__flujoArchiveWriteScope ??= new AsyncLocalStorage<WriteScope>();

function refuse(code: ModelTurnArchiveMemoryError['code']): never {
  ledger.rejected = Math.min(Number.MAX_SAFE_INTEGER, ledger.rejected + 1);
  throw new ModelTurnArchiveMemoryError(code);
}

/** Bounded descriptor walk: no stringify, getters, JSON hooks, or full clones. */
export function estimateArchivePayload(value: unknown): number {
  let bytes = 0;
  let inspected = 0;
  const seen = new WeakSet<object>();
  const add = (count: number) => {
    bytes += count;
    if (!Number.isSafeInteger(bytes) || bytes > MODEL_TURN_ARCHIVE_WRITE_LIMITS.writeBytes) {
      refuse('MODEL_TURN_ARCHIVE_MEMORY_LIMIT');
    }
  };
  const visit = (item: unknown, depth: number): void => {
    if (++inspected > MODEL_TURN_ARCHIVE_WRITE_LIMITS.inspectedValues || depth > MODEL_TURN_ARCHIVE_WRITE_LIMITS.depth) {
      refuse('MODEL_TURN_ARCHIVE_MEMORY_LIMIT');
    }
    if (typeof item === 'string') {
      add(item.length * 2 + 40); // Source UTF16 and both serialized quote pairs.
      for (let index = 0; index < item.length; index++) {
        const code = item.charCodeAt(index);
        if (code === 34 || code === 92) add(6);
        else if (code < 32) add((code === 8 || code === 9 || code === 10 || code === 12 || code === 13) ? 6 : 18);
        else if (code < 128) add(3);
        else if (code < 2048) add(4);
        else if (code >= 0xd800 && code <= 0xdbff && item.charCodeAt(index + 1) >= 0xdc00 && item.charCodeAt(index + 1) <= 0xdfff) {
          add(8); index++;
        } else if (code >= 0xd800 && code <= 0xdfff) add(18);
        else add(5);
      }
      return;
    }
    if (!item || typeof item !== 'object') { add(32); return; }
    if (types.isProxy(item)) refuse('MODEL_TURN_ARCHIVE_MEMORY_LIMIT');
    if (seen.has(item)) return;
    seen.add(item);
    add(128);
    if (ArrayBuffer.isView(item)) { add(item.buffer.byteLength); return; }
    if (item instanceof ArrayBuffer) { add(item.byteLength); return; }
    // Map/Set and arbitrary private graphs are not an admitted archive format.
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype) {
      refuse('MODEL_TURN_ARCHIVE_MEMORY_LIMIT');
    }
    if (Array.isArray(item) && item.length > MODEL_TURN_ARCHIVE_WRITE_LIMITS.inspectedValues) {
      refuse('MODEL_TURN_ARCHIVE_MEMORY_LIMIT');
    }
    if (Array.isArray(item)) add(item.length * 8); // Holes still allocate clone slots.
    for (const key in item) {
      if (++inspected > MODEL_TURN_ARCHIVE_WRITE_LIMITS.inspectedValues) refuse('MODEL_TURN_ARCHIVE_MEMORY_LIMIT');
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor) continue;
      if (!('value' in descriptor)) refuse('MODEL_TURN_ARCHIVE_MEMORY_LIMIT');
      add(key.length * 2 + 32);
      visit(descriptor.value, depth + 1);
    }
  };
  visit(value, 0);
  return bytes;
}

export interface ArchiveMemoryReservation {
  grow(bytes: number): void;
  release(): void;
}

export function reserveArchiveSnapshot(payload: unknown): ArchiveMemoryReservation {
  return reserve(estimateArchivePayload(payload) * 2, MODEL_TURN_ARCHIVE_WRITE_LIMITS.snapshotBytes, false);
}

function reserve(bytes: number, limit: number, writer: boolean): ArchiveMemoryReservation {
  let held = 0;
  let released = false;
  const grow = (extra: number) => {
    if (released || !Number.isSafeInteger(extra) || extra < 0 || held + extra > limit) refuse('MODEL_TURN_ARCHIVE_MEMORY_LIMIT');
    if (ledger.bytes + extra > MODEL_TURN_ARCHIVE_WRITE_LIMITS.processBytes) refuse('MODEL_TURN_ARCHIVE_MEMORY_BUSY');
    ledger.bytes += extra;
    held += extra;
  };
  if (writer && ledger.writers >= MODEL_TURN_ARCHIVE_WRITE_LIMITS.concurrentWrites) refuse('MODEL_TURN_ARCHIVE_MEMORY_BUSY');
  grow(bytes);
  if (writer) ledger.writers++;
  return { grow, release: () => {
    if (released) return;
    released = true;
    ledger.bytes -= held;
    if (writer) ledger.writers--;
  } };
}

interface WriteScope {
  reservation: ArchiveMemoryReservation;
  reservedEstimate: number;
  pendingCloses: number;
  settled: boolean;
}

/** Callback evaluation/cloning must occur inside this admitted boundary. */
export async function withArchiveWriteMemory<T>(payload: unknown, task: () => Promise<T>): Promise<T> {
  // Re-entrant or escaped AsyncLocalStorage work cannot borrow a spent permit.
  if (scopes.getStore()) refuse('MODEL_TURN_ARCHIVE_MEMORY_BUSY');
  // Covers copied object/string views, serialization, UTF8 and compression work.
  const reservedEstimate = estimateArchivePayload(payload) * 4;
  const reservation = reserve(reservedEstimate, MODEL_TURN_ARCHIVE_WRITE_LIMITS.writeBytes, true);
  const scope: WriteScope = { reservation, reservedEstimate, pendingCloses: 0, settled: false };
  try { return await scopes.run(scope, task); }
  finally {
    scope.settled = true;
    if (!scope.pendingCloses) reservation.release();
  }
}

/** Recheck references after an ownership await, before clones or serialization. */
export function recheckArchiveWriteMemory(payload: unknown): void {
  const scope = scopes.getStore();
  if (!scope || scope.settled) refuse('MODEL_TURN_ARCHIVE_MEMORY_BUSY');
  const required = estimateArchivePayload(payload) * 4;
  if (required > scope.reservedEstimate) {
    scope.reservation.grow(required - scope.reservedEstimate);
    scope.reservedEstimate = required;
  }
}

/** A failed close never recycles its admission before actual close succeeds. */
export async function closeArchiveWriteHandle(handle: FileHandle, primary?: unknown): Promise<void> {
  try { await handle.close(); }
  catch (error) {
    const scope = scopes.getStore();
    if (!scope) throw error;
    scope.pendingCloses++;
    ledger.quarantined++;
    let attempts = 0;
    const retry = async () => {
      try {
        await handle.close();
        scope.pendingCloses--;
        ledger.quarantined--;
        if (scope.settled && !scope.pendingCloses) scope.reservation.release();
      } catch {
        if (++attempts < 8) setTimeout(retry, 500).unref();
        // Original bounded admission remains quarantined after final failure.
      }
    };
    setTimeout(retry, 500).unref();
    throw new ModelTurnArchiveMemoryError('MODEL_TURN_ARCHIVE_WRITE_CLEANUP',
      primary === undefined ? error : new AggregateError([primary, error], 'Archive operation and close failed'));
  }
}

export async function readArchiveLocalMedia(file: string): Promise<Buffer> {
  const scope = scopes.getStore();
  if (!scope) throw new ModelTurnArchiveMemoryError('MODEL_TURN_ARCHIVE_MEMORY_LIMIT');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  let primary: unknown;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size > MODEL_TURN_ARCHIVE_WRITE_LIMITS.localMediaBytes) {
      refuse('MODEL_TURN_ARCHIVE_MEMORY_LIMIT');
    }
    scope.reservation.grow((stat.size + 1) * 2);
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    if (offset !== stat.size) refuse('MODEL_TURN_ARCHIVE_MEMORY_LIMIT');
    return bytes.subarray(0, offset);
  } catch (error) { primary = error; throw error; }
  finally { await closeArchiveWriteHandle(handle, primary); }
}

/** Await every sibling before surfacing failure and releasing shared memory. */
export async function settleArchiveWrites<T>(tasks: Array<Promise<T>>): Promise<T[]> {
  const settled = await Promise.allSettled(tasks);
  const failures = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    const memoryFailure = failures.find(error => error instanceof ModelTurnArchiveMemoryError);
    if (memoryFailure) throw new ModelTurnArchiveMemoryError(memoryFailure.code, new AggregateError(failures));
    throw new AggregateError(failures, 'Archive sibling writes failed');
  }
  return settled.map(result => (result as PromiseFulfilledResult<T>).value);
}

export function getArchiveWritePressure() { return { ...ledger, limits: { ...MODEL_TURN_ARCHIVE_WRITE_LIMITS } }; }
