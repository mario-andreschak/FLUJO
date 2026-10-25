import { AsyncLocalStorage } from 'node:async_hooks';
import { types } from 'node:util';
import { getHeapStatistics } from 'node:v8';
import { pendingAllocationBytes, setAllocationReservation } from './allocationReservations';
import { getFlowRunAdmissionDiagnostics } from './runAdmission';
import { ConversationPublicationError } from './conversationPublicationError';
export { ConversationPublicationError, isConversationPublicationError } from './conversationPublicationError';

const MiB = 1024 * 1024;
export const CONVERSATION_PUBLICATION_LIMITS = Object.freeze({
  owners: 64, writers: 4, retainedBytes: 256 * MiB, ownerBytes: 128 * MiB,
  slots: 262_144, depth: 128, bufferBytes: 64 * 1024, stringChars: 8192,
});
type PublicationCode = ConversationPublicationError['code'];
type Owner = { key: string; live: boolean; bytes: number; quarantined: boolean; descriptorUncertain?: boolean;
  snapshotCommits: number };
type Frame = { owner: Owner; live: boolean; tail: Promise<unknown>; pending: Set<Promise<unknown>>; failure?: unknown };
type Ledger = { bytes: number; retained: number; owners: number; writers: number; quarantined: number;
  rejected: number; chains: Map<string, Promise<unknown>>; fences: Map<string, ConversationPublicationError>;
  receipts: Map<string, Readonly<Record<string, string>>>; waiters: Array<() => void>; context: AsyncLocalStorage<Frame>;
  captures: WeakMap<object, Frame>; immutableSnapshots: WeakSet<object> };
const host = globalThis as typeof globalThis & { __flujoConversationPublicationV1?: Ledger };
const ledger: Ledger = host.__flujoConversationPublicationV1 ??= { bytes: 0, retained: 0, owners: 0, writers: 0,
  quarantined: 0, rejected: 0, chains: new Map(), fences: new Map(), receipts: new Map(), waiters: [], context: new AsyncLocalStorage(),
  captures: new WeakMap(), immutableSnapshots: new WeakSet() };
// Keep a live development process compatible when an earlier module instance
// initialized the shared ledger before immutable snapshot reuse was loaded.
ledger.captures ??= new WeakMap();
ledger.immutableSnapshots ??= new WeakSet();
setAllocationReservation('publication', ledger.bytes);
function refuse(code: PublicationCode, reason: string): never {
  ledger.rejected++;
  throw new ConversationPublicationError(code, reason);
}

/** Accept genuine plain objects/arrays from another VM without executing its code. */
function plainPrototype(prototype: object | null, array: boolean): boolean {
  if (prototype === null) return !array;
  if (types.isProxy(prototype)) return false;
  const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
  if (!constructor || !('value' in constructor) || typeof constructor.value !== 'function'
    || types.isProxy(constructor.value)) return false;
  const expected = array ? Array : Object;
  if (Function.prototype.toString.call(constructor.value) !== Function.prototype.toString.call(expected)) return false;
  if (Object.getOwnPropertyDescriptor(constructor.value, 'prototype')?.value !== prototype) return false;
  return array ? plainPrototype(Object.getPrototypeOf(prototype), false) : Object.getPrototypeOf(prototype) === null;
}
function noHooks(value: object): void {
  let depth = 0;
  for (let current: object | null = value; current; current = Object.getPrototypeOf(current)) {
    if (++depth > 128 || types.isProxy(current)) {
      refuse('CONVERSATION_PUBLICATION_DATA', 'serialization hooks and proxies are unsupported');
    }
    const serializer = Object.getOwnPropertyDescriptor(current, 'toJSON');
    if (serializer && (!('value' in serializer) || typeof serializer.value === 'function')) {
      refuse('CONVERSATION_PUBLICATION_DATA', 'serialization hooks and proxies are unsupported');
    }
  }
}
function dataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !('value' in descriptor)) refuse('CONVERSATION_PUBLICATION_DATA', 'accessors are unsupported');
  return descriptor?.value;
}
const omitted = (value: unknown) => value === undefined || typeof value === 'function' || typeof value === 'symbol';

/** Two synchronous descriptor passes: validate/reserve first, then copy only
 * containers. String primitives are shared; a 37.6M-character history is never
 * cloned or encoded just to measure admission. Aliases count at every JSON use,
 * bounding serialization amplification as well as the capture itself. */
function capture<T>(key: string, value: T, omitRootKeys?: ReadonlySet<string>): { value: T; retained: number; bytes: number; borrowed: boolean } {
  let slots = 0, retained = 0, metadata = 0;
  const source = value !== null && typeof value === 'object' ? ledger.captures.get(value) : undefined;
  const borrowed = !!source?.live && source.owner.live && source.owner.key === key && source.owner === ledger.context.getStore()?.owner
    && ledger.immutableSnapshots.has(value as object) && !omitRootKeys;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number, copying: boolean): unknown => {
    if (!copying && (++slots > CONVERSATION_PUBLICATION_LIMITS.slots || depth > CONVERSATION_PUBLICATION_LIMITS.depth)) {
      refuse('CONVERSATION_PUBLICATION_DATA', 'JSON descriptor work exceeds the bounded publication policy');
    }
    if (!copying) metadata += 64;
    if (typeof item === 'string') {
      if (!copying) retained += item.length * 2;
    } else if (item !== null && typeof item === 'object') {
      if (types.isProxy(item) || ancestors.has(item)) refuse('CONVERSATION_PUBLICATION_DATA', 'a proxy or cycle cannot be captured');
      const array = Array.isArray(item);
      if (!plainPrototype(Object.getPrototypeOf(item), array)) refuse('CONVERSATION_PUBLICATION_DATA', 'only plain JSON containers can be captured');
      noHooks(item);
      ancestors.add(item);
      const result: unknown[] | Record<string, unknown> | undefined = copying ? array ? [] : Object.create(null) : undefined;
      try {
        if (array) {
          const length = dataProperty(item, 'length') as number;
          if (length > CONVERSATION_PUBLICATION_LIMITS.slots) refuse('CONVERSATION_PUBLICATION_DATA', 'array length exceeds publication policy');
          for (let index = 0; index < length; index++) {
            const key = String(index);
            if (!Object.hasOwn(item, key) && key in item) refuse('CONVERSATION_PUBLICATION_DATA', 'inherited array values are unsupported');
            const child = dataProperty(item, key);
            const copied = visit(child, depth + 1, copying);
            if (copying) (result as unknown[]).push(omitted(child) ? null : copied);
          }
        } else {
          for (const key in item) {
            if (!Object.hasOwn(item, key)) continue;
            if (depth === 0 && omitRootKeys?.has(key)) continue;
            if (!copying) { metadata += 48 + key.length * 2; retained += key.length * 2; }
            const child = dataProperty(item, key);
            const copied = visit(child, depth + 1, copying);
            if (copying && !omitted(child)) (result as Record<string, unknown>)[key] = copied;
          }
        }
      } finally { ancestors.delete(item); }
      if (copying) return result;
    } else if (typeof item === 'bigint') refuse('CONVERSATION_PUBLICATION_DATA', 'BigInt is not JSON data');
    else if (typeof item === 'function') noHooks(item);
    if (!copying && retained + metadata > CONVERSATION_PUBLICATION_LIMITS.ownerBytes) {
      refuse('CONVERSATION_PUBLICATION_MEMORY', 'retained data exceeds the per-publication bound');
    }
    return item;
  };
  if (omitted(value)) refuse('CONVERSATION_PUBLICATION_DATA', 'publication has no JSON value');
  if (!borrowed) visit(value, 0, false);
  // Fixed allowance also covers each owner's bounded encoder/receipt/queue.
  const bytes = metadata * 2 + 512 * 1024;
  const heap = getHeapStatistics();
  const pending = pendingAllocationBytes('publication', ledger.bytes + bytes);
  const rss = process.memoryUsage().rss;
  if (ledger.retained + retained + metadata > CONVERSATION_PUBLICATION_LIMITS.retainedBytes
    || pending > heap.heap_size_limit * 0.8 - heap.used_heap_size - 64 * MiB
    || !Number.isFinite(rss) || rss + pending > getFlowRunAdmissionDiagnostics().maxRssBytes) {
    refuse('CONVERSATION_PUBLICATION_MEMORY', 'publication allocation capacity is occupied');
  }
  ledger.bytes += bytes; ledger.retained += retained + metadata;
  setAllocationReservation('publication', ledger.bytes);
  try { return { value: borrowed ? value : visit(value, 0, true) as T, retained: retained + metadata, bytes, borrowed }; }
  catch (error) {
    ledger.bytes -= bytes; ledger.retained -= retained + metadata;
    setAllocationReservation('publication', ledger.bytes);
    throw error;
  }
}

async function writer<T>(task: () => Promise<T>): Promise<T> {
  while (ledger.writers + ledger.quarantined >= CONVERSATION_PUBLICATION_LIMITS.writers) {
    if (ledger.quarantined >= CONVERSATION_PUBLICATION_LIMITS.writers) {
      refuse('CONVERSATION_PUBLICATION_UNCERTAIN', 'descriptor capacity requires reconciliation and a controlled restart');
    }
    await new Promise<void>(resolve => ledger.waiters.push(resolve));
  }
  ledger.writers++;
  try { return await task(); }
  finally { ledger.writers--; ledger.waiters.shift()?.(); }
}

/** Synchronously capture and reserve order before any authority or workspace
 * wait. A nested snapshot borrows its live transaction's writer, never queues
 * behind itself. Its own capture remains charged until the nested write ends. */
export function publishConversation<T, R>(key: string, value: T, task: (owned: T) => Promise<R>, omitRootKeys?: ReadonlySet<string>, prepare?: (owned: T) => void): Promise<R> {
  const fence = ledger.fences.get(key);
  if (fence) throw fence;
  if (key.length > 4096) refuse('CONVERSATION_PUBLICATION_DATA', 'publication key is too long');
  const inherited = ledger.context.getStore();
  const nested = inherited?.live && inherited.owner.live && inherited.owner.key === key;
  if (ledger.owners >= CONVERSATION_PUBLICATION_LIMITS.owners) refuse('CONVERSATION_PUBLICATION_BUSY', 'publication owner capacity is occupied');
  const owned = capture(key, value, omitRootKeys);
  try { prepare?.(owned.value); } catch (error) {
    ledger.bytes -= owned.bytes; ledger.retained -= owned.retained;
    setAllocationReservation('publication', ledger.bytes);
    throw error;
  }
  const owner: Owner = nested ? inherited.owner : { key, live: true, bytes: 0, quarantined: false, snapshotCommits: 0 };
  const frame: Frame = { owner, live: true, tail: Promise.resolve(), pending: new Set() };
  if (!owned.borrowed && owned.value !== null && typeof owned.value === 'object') ledger.captures.set(owned.value, frame);
  ledger.owners++;
  const invoke = async () => {
    const fence = ledger.fences.get(key);
    if (fence) throw fence;
    let primary: unknown;
    try { return await task(owned.value); }
    catch (error) {
      primary = error;
      throw primary;
    }
    finally {
      frame.live = false;
      const children = await Promise.allSettled([...frame.pending]);
      const failed = children.find(result => result.status === 'rejected');
      if (primary === undefined && frame.failure !== undefined) throw frame.failure;
      if (primary === undefined && failed?.status === 'rejected') throw failed.reason;
    }
  };
  const previous = nested ? inherited.tail : ledger.chains.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => nested
    ? ledger.context.run(frame, invoke) : writer(() => ledger.context.run(frame, invoke)));
  const settled = run.finally(() => {
    if (nested) ledger.owners--;
    else {
      owner.live = false;
      if (!owner.quarantined) ledger.owners--;
      ledger.bytes -= owner.bytes;
      if (ledger.chains.get(key) === settled) ledger.chains.delete(key);
    }
    // Release even on unknown commit: the finite fence retains only a receipt.
    owned.value = undefined as T;
    ledger.bytes -= owned.bytes; ledger.retained -= owned.retained;
    setAllocationReservation('publication', ledger.bytes);
  });
  if (!nested) ledger.chains.set(key, settled);
  else {
    inherited.tail = settled; inherited.pending.add(settled);
    // Observe detached child rejection immediately; the parent also drains and
    // surfaces it before releasing its writer and conversation order.
    void settled.then(() => inherited.pending.delete(settled), error => {
      inherited.pending.delete(settled); inherited.failure ??= error;
    });
  }
  return settled;
}

/** Only a privately captured snapshot may opt into immutable nested reuse.
 * The owning frame drains nested work before releasing its original charge. */
export function freezeConversationSnapshot<T extends object>(value: T): T {
  const frame = ledger.captures.get(value);
  if (!frame?.live || frame.owner !== ledger.context.getStore()?.owner) throw new Error('Snapshot is not owned by this live publication');
  const freeze = (item: unknown): void => {
    if (item === null || typeof item !== 'object') return;
    for (const key in item) if (Object.hasOwn(item, key)) freeze((item as Record<string, unknown>)[key]);
    if (!Object.isFrozen(item)) Object.freeze(item);
  };
  freeze(value); ledger.immutableSnapshots.add(value);
  return value;
}

export function conversationPublicationSnapshotCommits(): number { return ledger.context.getStore()?.owner.snapshotCommits ?? 0; }
export async function drainConversationPublicationChildren(): Promise<void> {
  const frame = ledger.context.getStore();
  if (!frame) throw new Error('No conversation publication frame');
  frame.live = false;
  const children = await Promise.allSettled([...frame.pending]);
  const failed = children.find(result => result.status === 'rejected');
  if (frame.failure !== undefined) throw frame.failure;
  if (failed?.status === 'rejected') throw failed.reason;
}
export function conversationPublicationIsFenced(): boolean {
  const owner = ledger.context.getStore()?.owner;
  return !!owner && ledger.fences.has(owner.key);
}
export function reserveConversationPublicationScratch(bytes: number): void {
  const owner = ledger.context.getStore()?.owner;
  if (!owner?.live || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > 32 * MiB) throw new Error('Invalid publication scratch reservation');
  const additional = Math.max(0, bytes - owner.bytes);
  const heap = getHeapStatistics();
  const pending = pendingAllocationBytes('publication', ledger.bytes + additional);
  const rss = process.memoryUsage().rss;
  if (pending > heap.heap_size_limit * 0.8 - heap.used_heap_size - 64 * MiB
    || !Number.isFinite(rss) || rss + pending > getFlowRunAdmissionDiagnostics().maxRssBytes) {
    refuse('CONVERSATION_PUBLICATION_MEMORY', 'rewrite metadata allocation capacity is occupied');
  }
  owner.bytes += additional; ledger.bytes += additional;
  setAllocationReservation('publication', ledger.bytes);
}
export function recordConversationSnapshotCommit(): void {
  const owner = ledger.context.getStore()?.owner;
  if (!owner?.live) throw new Error('No live conversation publication owner');
  owner.snapshotCommits++;
}
/** Retains a finite owner/descriptor slot, never a transcript. Recovery must
 * resolve the on-disk receipt before a controlled restart admits more writes. */
export function fenceConversationPublication(reason: string, cause?: unknown, descriptorUncertain = false,
  receipt?: Readonly<Record<string, string>>): ConversationPublicationError {
  const owner = ledger.context.getStore()?.owner;
  if (!owner?.live) throw new Error('No live conversation publication owner');
  // Do not retain an arbitrary thrown payload (which can itself own a history).
  const error = new ConversationPublicationError('CONVERSATION_PUBLICATION_UNCERTAIN', reason,
    cause instanceof Error ? { cause: new Error('Publication operation failed') } : undefined);
  if (!owner.quarantined) { owner.quarantined = true; }
  if (descriptorUncertain && !owner.descriptorUncertain) { owner.descriptorUncertain = true; ledger.quarantined++; }
  if (ledger.quarantined >= CONVERSATION_PUBLICATION_LIMITS.writers) {
    for (const wake of ledger.waiters.splice(0)) wake();
  }
  if (receipt) {
    const entries = Object.entries(receipt);
    if (entries.length > 8 || entries.some(([key, value]) => key.length > 64 || value.length > 4096)) throw new Error('Publication receipt exceeded its bound');
    ledger.receipts.set(owner.key, Object.freeze({ ...receipt }));
  }
  ledger.fences.set(owner.key, error);
  return error;
}
export async function flushConversationPublication(key: string): Promise<void> {
  await ledger.chains.get(key);
  const fence = ledger.fences.get(key);
  if (fence) throw fence;
}
export function getConversationPublicationDiagnostics() {
  return { owners: ledger.owners, writers: ledger.writers, allocationBytes: ledger.bytes,
    retainedBytes: ledger.retained, queuedWriters: ledger.waiters.length, chains: ledger.chains.size,
    fences: ledger.fences.size, receipts: ledger.receipts.size, quarantinedWriterSlots: ledger.quarantined, rejected: ledger.rejected };
}

function* stringParts(value: string): Generator<string> {
  yield '"';
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + CONVERSATION_PUBLICATION_LIMITS.stringChars, value.length);
    const last = value.charCodeAt(end - 1), next = value.charCodeAt(end);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    yield JSON.stringify(value.slice(start, end)).slice(1, -1);
    start = end;
  }
  yield '"';
}
function* jsonParts(value: unknown): Generator<string> {
  if (typeof value === 'string') { yield* stringParts(value); return; }
  if (value === null || typeof value !== 'object') { yield JSON.stringify(value); return; }
  const array = Array.isArray(value);
  yield array ? '[' : '{';
  let count = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (count++) yield ',';
    if (!array) { yield* stringParts(key); yield ':'; }
    yield* jsonParts((value as Record<string, unknown>)[key]);
  }
  yield array ? ']' : '}';
}
/** The consumer must finish writing a chunk before advancing this generator. */
export function* conversationJsonChunks(values: Iterable<unknown>, jsonl: boolean): Generator<Buffer> {
  const buffer = Buffer.allocUnsafe(CONVERSATION_PUBLICATION_LIMITS.bufferBytes);
  let used = 0;
  for (const value of values) {
    const parts = function* () { yield* jsonParts(value); if (jsonl) yield '\n'; };
    for (const part of parts()) {
      const size = Buffer.byteLength(part);
      if (size > buffer.length) throw new Error('Conversation JSON encoder chunk exceeded its bound');
      if (used + size > buffer.length) { yield buffer.subarray(0, used); used = 0; }
      used += buffer.write(part, used, 'utf8');
    }
  }
  if (used) yield buffer.subarray(0, used);
}
