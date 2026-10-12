import { AsyncLocalStorage } from 'node:async_hooks';
import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { types } from 'node:util';
import { z } from 'zod';
import { getOwnedArchiveSchema, isOwnedArchiveDescriptor, type ArchiveSchemaProjectionPolicy } from '@/backend/services/model/adapters/ownedArchiveSchema';

export function archiveOmission(key: string): string | undefined {
  if (/(api[_-]?key|authorization|cookie|(?:^|[_-])(?:access[_-]?|refresh[_-]?|oauth[_-]?)?token$|secret|password|signature)/i.test(key)) return '[redacted]';
  if (key === 'env') return '[environment omitted]';
  if (key === 'abortController') return '[AbortController]';
  if (key === 'signal' || key === 'abortSignal') return '[AbortSignal]';
}

// Use only the installed library's public constructor prototypes. In Zod 4.6
// toJSONSchema moved to a prototype accessor; reading it would evaluate a hook.
const archiveSchemaPrototypes = new Set<object>(Object.entries(z)
  .filter(([name, constructor]) => name.startsWith('Zod') && typeof constructor === 'function')
  .map(([, constructor]) => Object.getOwnPropertyDescriptor(constructor, 'prototype')?.value)
  .filter((prototype): prototype is object => !!prototype && typeof prototype === 'object'));

export function isArchiveSchema(value: object): value is z.ZodType {
  if (types.isProxy(value)) return false;
  // Zod's Symbol.hasInstance reads _zod.traits and can invoke a user getter.
  // Recognize its trusted prototype and opaque own descriptors without
  // following that graph or reading any inherited property.
  const marker = Object.getOwnPropertyDescriptor(value, '_zod');
  const kind = Object.getOwnPropertyDescriptor(value, 'type');
  return !!marker && !marker.enumerable && 'value' in marker
    && typeof kind?.value === 'string' && archiveSchemaPrototypes.has(Object.getPrototypeOf(value));
}

/** Intrinsic Object prototypes can come from another VM/structuredClone realm. */
export function isArchivePlainObject(value: object): boolean {
  if (types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) return true;
  if (types.isProxy(prototype) || Object.getPrototypeOf(prototype) !== null) return false;
  const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
  if (!constructor || !('value' in constructor) || typeof constructor.value !== 'function'
      || types.isProxy(constructor.value)) return false;
  const constructorPrototype = Object.getOwnPropertyDescriptor(constructor.value, 'prototype');
  return constructorPrototype?.value === prototype
    && Function.prototype.toString.call(constructor.value) === Function.prototype.toString.call(Object);
}

/** Proposed allocation reservations, not measured V8 heap or an OOM guarantee. */
export const MODEL_TURN_ARCHIVE_WRITE_LIMITS = Object.freeze({
  processBytes: 512 * 1024 * 1024,
  snapshotBytes: 64 * 1024 * 1024,
  writeBytes: 256 * 1024 * 1024,
  concurrentWrites: 4,
  localMediaBytes: 32 * 1024 * 1024,
  inspectedValues: 100_000,
  depth: 64,
  queuedWrites: 512,
  queueTimeoutMs: 30_000,
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
export function estimateArchivePayload(value: unknown, archiveProjection = false, unowned?: (schema: object) => void): number {
  let bytes = 0;
  let inspected = 0;
  const seen = new WeakSet<object>();
  const add = (count: number) => {
    bytes += count;
    if (!Number.isSafeInteger(bytes) || bytes > MODEL_TURN_ARCHIVE_WRITE_LIMITS.writeBytes) {
      refuse('MODEL_TURN_ARCHIVE_MEMORY_LIMIT');
    }
  };
  const visit = (item: unknown, depth: number, schemaData = false): void => {
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
    if (seen.has(item)) { add(32); return; }
    seen.add(item);
    add(128);
    schemaData ||= isOwnedArchiveDescriptor(item);
    if (archiveProjection && isArchiveSchema(item)) {
      const descriptor = getOwnedArchiveSchema(item);
      if (descriptor) visit(descriptor, depth + 1, true);
      else unowned?.(item);
      seen.delete(item); return;
    }
    if (ArrayBuffer.isView(item)) { add(item.buffer.byteLength); seen.delete(item); return; }
    if (item instanceof ArrayBuffer) { add(item.byteLength); seen.delete(item); return; }
    // Map/Set and arbitrary private graphs are not an admitted archive format.
    if (!Array.isArray(item) && !isArchivePlainObject(item)) {
      if (!archiveProjection) refuse('MODEL_TURN_ARCHIVE_MEMORY_LIMIT');
      seen.delete(item); return; // Sanitizer omits private graphs without traversal.
    }
    if (Array.isArray(item) && item.length > MODEL_TURN_ARCHIVE_WRITE_LIMITS.inspectedValues) {
      refuse('MODEL_TURN_ARCHIVE_MEMORY_LIMIT');
    }
    if (Array.isArray(item)) add(item.length * 8); // Holes still allocate clone slots.
    for (const key in item) {
      if (++inspected > MODEL_TURN_ARCHIVE_WRITE_LIMITS.inspectedValues) refuse('MODEL_TURN_ARCHIVE_MEMORY_LIMIT');
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor) continue;
      const omitted = archiveProjection && !schemaData ? archiveOmission(key) : undefined;
      if (omitted !== undefined) { add(key.length * 2 + 128); continue; }
      if (!('value' in descriptor)) refuse('MODEL_TURN_ARCHIVE_MEMORY_LIMIT');
      add(key.length * 2 + 32);
      visit(descriptor.value, depth + 1, schemaData);
    }
    seen.delete(item); // Count each serialization occurrence, not just identity.
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
    if (writer) { ledger.writers--; drainArchiveWriteQueue(); }
  } };
}

export interface ArchiveWriteAdmissionOptions {
  /** Explicit ordinary-dispatch opt-in. Protected/native callers retain fail-fast defaults. */
  wait?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}
interface ArchiveWriteWaiter { grant: () => void }
const queueRuntime = globalThis as typeof globalThis & { __flujoArchiveWriteQueue?: ArchiveWriteWaiter[] };
const writeQueue = queueRuntime.__flujoArchiveWriteQueue ??= [];
function drainArchiveWriteQueue(): void {
  while (ledger.writers < MODEL_TURN_ARCHIVE_WRITE_LIMITS.concurrentWrites && writeQueue.length) {
    writeQueue[0].grant();
  }
}

function admitArchiveWriter(bytes: number, options?: ArchiveWriteAdmissionOptions): Promise<ArchiveMemoryReservation> {
  options?.signal?.throwIfAborted();
  if (!options?.wait || (!writeQueue.length && ledger.writers < MODEL_TURN_ARCHIVE_WRITE_LIMITS.concurrentWrites)) {
    return Promise.resolve(reserve(bytes, MODEL_TURN_ARCHIVE_WRITE_LIMITS.writeBytes, true));
  }
  if (writeQueue.length >= MODEL_TURN_ARCHIVE_WRITE_LIMITS.queuedWrites) refuse('MODEL_TURN_ARCHIVE_MEMORY_BUSY');
  // Retained queued references count against the same byte ceiling before any archive clone.
  const held = reserve(bytes, MODEL_TURN_ARCHIVE_WRITE_LIMITS.writeBytes, false);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      const index = writeQueue.indexOf(waiter);
      if (index >= 0) writeQueue.splice(index, 1);
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true; cleanup(); held.release(); reject(error);
    };
    const abort = () => fail(options.signal?.reason ?? new DOMException('Archive admission cancelled.', 'AbortError'));
    const waiter: ArchiveWriteWaiter = { grant: () => {
      if (settled) return;
      settled = true; cleanup();
      // Transfer queued bytes to a writer atomically, without yielding or relaxing either bound.
      held.release();
      try { options.signal?.throwIfAborted(); resolve(reserve(bytes, MODEL_TURN_ARCHIVE_WRITE_LIMITS.writeBytes, true)); }
      catch (error) { reject(error); }
    } };
    const requested = options.timeoutMs ?? MODEL_TURN_ARCHIVE_WRITE_LIMITS.queueTimeoutMs;
    const timeout = Number.isFinite(requested) ? Math.max(0, Math.min(requested, MODEL_TURN_ARCHIVE_WRITE_LIMITS.queueTimeoutMs)) : MODEL_TURN_ARCHIVE_WRITE_LIMITS.queueTimeoutMs;
    const timer = setTimeout(() => fail(new ModelTurnArchiveMemoryError('MODEL_TURN_ARCHIVE_MEMORY_BUSY')), timeout);
    writeQueue.push(waiter);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    drainArchiveWriteQueue();
  });
}

interface WriteScope {
  reservation: ArchiveMemoryReservation;
  reservedEstimate: number;
  pendingCloses: number;
  mediaOps: number;
  settled: boolean;
  schemaProjectionPolicy: ArchiveSchemaProjectionPolicy;
}

/** Callback evaluation/cloning must occur inside this admitted boundary. */
export async function withArchiveWriteMemory<T>(payload: unknown, task: () => Promise<T>,
  schemaProjectionPolicy: ArchiveSchemaProjectionPolicy = 'legacy-unbounded', admissionOptions?: ArchiveWriteAdmissionOptions): Promise<T> {
  // Re-entrant or escaped AsyncLocalStorage work cannot borrow a spent permit.
  if (scopes.getStore()) refuse('MODEL_TURN_ARCHIVE_MEMORY_BUSY');
  // Covers copied object/string views, serialization, UTF8 and compression work.
  let legacy = false;
  const estimate = estimateArchivePayload(payload, true, () => {
    if (schemaProjectionPolicy === 'owned-only') refuse('MODEL_TURN_ARCHIVE_MEMORY_LIMIT');
    legacy = true;
  }) * 4;
  const reservedEstimate = legacy ? Math.max(estimate, MODEL_TURN_ARCHIVE_WRITE_LIMITS.writeBytes) : estimate;
  const reservation = await admitArchiveWriter(reservedEstimate, admissionOptions);
  const scope: WriteScope = { reservation, reservedEstimate, pendingCloses: 0, mediaOps: 0, settled: false, schemaProjectionPolicy };
  try {
    admissionOptions?.signal?.throwIfAborted();
    return await scopes.run(scope, async () => {
      // Queued payload references may change while waiting. Check before any clone/factory.
      recheckArchiveWriteMemory(payload);
      return task();
    });
  }
  finally {
    scope.settled = true;
    if (!scope.pendingCloses && !scope.mediaOps) reservation.release();
  }
}

/** Recheck references after an ownership await, before clones or serialization. */
export function recheckArchiveWriteMemory(payload: unknown, serializedData = false): void {
  const scope = scopes.getStore();
  if (!scope || scope.settled) refuse('MODEL_TURN_ARCHIVE_MEMORY_BUSY');
  let legacy = false;
  const estimate = estimateArchivePayload(payload, !serializedData, () => {
    if (scope.schemaProjectionPolicy === 'owned-only') refuse('MODEL_TURN_ARCHIVE_MEMORY_LIMIT');
    legacy = true;
  }) * 4;
  const required = legacy ? Math.max(estimate, MODEL_TURN_ARCHIVE_WRITE_LIMITS.writeBytes) : estimate;
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
    if (scope) {
      scope.pendingCloses++;
      ledger.quarantined++;
    }
    // FileHandle may cache a rejected close promise. Repeating close is not
    // proof of descriptor drainage; keep scoped admission until process exit.
    // Outside a scope the same typed error preserves the uncertain temp file.
    throw new ModelTurnArchiveMemoryError('MODEL_TURN_ARCHIVE_WRITE_CLEANUP',
      primary === undefined ? error : new AggregateError([primary, error], 'Archive operation and close failed'));
  }
}

export async function readArchiveLocalMedia(file: string): Promise<Buffer> {
  const scope = scopes.getStore();
  if (!scope) throw new ModelTurnArchiveMemoryError('MODEL_TURN_ARCHIVE_MEMORY_LIMIT');
  const assertActive = () => {
    if (scope.settled) refuse('MODEL_TURN_ARCHIVE_MEMORY_BUSY');
  };
  assertActive();
  scope.mediaOps++;
  let handle: FileHandle | undefined;
  let primary: unknown;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    assertActive();
    const stat = await handle.stat();
    assertActive();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size > MODEL_TURN_ARCHIVE_WRITE_LIMITS.localMediaBytes) {
      refuse('MODEL_TURN_ARCHIVE_MEMORY_LIMIT');
    }
    scope.reservation.grow((stat.size + 1) * 2);
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      assertActive();
      const read = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
      assertActive();
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    if (offset !== stat.size) refuse('MODEL_TURN_ARCHIVE_MEMORY_LIMIT');
    return bytes.subarray(0, offset);
  } catch (error) { primary = error; throw error; }
  finally {
    try { if (handle) await closeArchiveWriteHandle(handle, primary); }
    finally {
      scope.mediaOps--;
      if (scope.settled && !scope.pendingCloses && !scope.mediaOps) scope.reservation.release();
    }
  }
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
export function getArchiveSchemaProjectionPolicy(): ArchiveSchemaProjectionPolicy {
  const scope = scopes.getStore();
  if (!scope || scope.settled) refuse('MODEL_TURN_ARCHIVE_MEMORY_BUSY');
  return scope.schemaProjectionPolicy;
}
