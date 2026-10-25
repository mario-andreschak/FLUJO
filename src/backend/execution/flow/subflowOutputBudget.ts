import { types } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getHeapStatistics } from 'node:v8';
import { getFlowRunAdmissionDiagnostics } from './runAdmission';
import { pendingAllocationBytes, setAllocationReservation } from './allocationReservations';

const MiB = 1024 * 1024;
export const SUBFLOW_OUTPUT_LIMITS = Object.freeze({
  textBytes: 64 * MiB, invocationBytes: 128 * MiB, processBytes: 256 * MiB,
  values: 100_000, media: 4096, promotionWorkers: 4,
});
type Code = 'SUBFLOW_OUTPUT_TOO_LARGE' | 'SUBFLOW_OUTPUT_MEMORY';
const globals = globalThis as typeof globalThis & { __flujoSubflowOutput?: {
  bytes: number; active: number; rejectedTooLarge: number; rejectedMemory: number;
}; __flujoSubflowOutputReservations?: WeakMap<object, SubflowOutputBudget>;
  __flujoSubflowOutputConsumption?: AsyncLocalStorage<{ results: Set<object>; closed: boolean }>;
  __flujoSubflowFolds?: WeakMap<object, Promise<void>>;
};
const ledger = globals.__flujoSubflowOutput ??= { bytes: 0, active: 0, rejectedTooLarge: 0, rejectedMemory: 0 };
setAllocationReservation('output', ledger.bytes);
export class SubflowOutputPressureError extends Error {
  readonly status: 413 | 503;
  readonly details: { code: Code; status: number; type: string; retryAfter?: string };
  constructor(readonly code: Code, reason: string) {
    super(`Subflow output refused: ${reason}. Completed child histories and the pending join are retained. ${code === 'SUBFLOW_OUTPUT_MEMORY'
      ? 'Retry the join after active work finishes.' : 'Use a shorter join separator or capture fewer derived output bytes, then retry the join.'}`);
    this.name = 'SubflowOutputPressureError';
    this.status = code === 'SUBFLOW_OUTPUT_MEMORY' ? 503 : 413;
    if (this.status === 503) ledger.rejectedMemory++; else ledger.rejectedTooLarge++;
    this.details = { code, status: this.status, type: 'subflow_output_error', ...(this.status === 503 ? { retryAfter: '5' } : {}) };
  }
}
export const isSubflowOutputPressureError = (error: unknown): error is SubflowOutputPressureError =>
  error instanceof Error && error.name === 'SubflowOutputPressureError';
export function refuseSubflowOutput(reason: string): never { throw new SubflowOutputPressureError('SUBFLOW_OUTPUT_TOO_LARGE', reason); }

/** No getters, proxies, toJSON, iterators, or child transcript clones during admission. */
export function outputProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return refuseSubflowOutput('output must contain plain data');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) return refuseSubflowOutput('output must contain plain data');
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !('value' in descriptor)) return refuseSubflowOutput('output accessors are not supported');
  return descriptor?.value;
}
export function outputArrayLength(value: unknown, limit: number = SUBFLOW_OUTPUT_LIMITS.values): number {
  if (!Array.isArray(value) || types.isProxy(value)) return refuseSubflowOutput('output must contain plain arrays');
  for (const key of [Symbol.iterator, 'map', 'filter', 'flatMap', 'join', 'some', 'forEach', 'slice', 'values', 'entries']) {
    if (Object.getOwnPropertyDescriptor(value, key)) refuseSubflowOutput('output array hooks are not supported');
  }
  const length = outputProperty(value, 'length') as number;
  if (!Number.isSafeInteger(length) || length > limit) return refuseSubflowOutput(`output count exceeds ${limit}`);
  return length;
}
export function outputText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return refuseSubflowOutput('output text must be a string');
  assertOutputChars(value.length);
  return value;
}
export function assertOutputChars(chars: number): void {
  if (!Number.isSafeInteger(chars) || chars < 0 || chars * 2 > SUBFLOW_OUTPUT_LIMITS.textBytes) refuseSubflowOutput('derived text exceeds 64 MiB');
}
/** Exact JSON string byte count, including escapes and lone surrogate replacement.
 * This scans owned strings without materializing their UTF-8/JSON representation. */
export function outputJsonStringBytes(text: string): number {
  assertOutputChars(text.length);
  let bytes = 2;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) bytes += 2;
    else if (code < 32) bytes += 6;
    else if (code < 128) bytes++;
    else if (code < 2048) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += code >= 0xd800 && code <= 0xdfff ? 6 : 3;
  }
  return bytes;
}
export function measureOutputData(value: unknown): { heap: number; json: number; values: number } {
  let values = 0, heap = 0, json = 0;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (++values > SUBFLOW_OUTPUT_LIMITS.values || depth > 64) refuseSubflowOutput('output descriptor work exceeds its limit');
    if (typeof item === 'string') { heap += item.length * 2; json += outputJsonStringBytes(item); }
    else if (item === null || item === undefined || typeof item === 'boolean' || typeof item === 'number') json += 24;
    else if (typeof item === 'object') {
      if (types.isProxy(item) || ancestors.has(item)) refuseSubflowOutput('output contains a proxy or cycle');
      outputProperty(item, 'toJSON');
      if (Object.getOwnPropertyDescriptor(item, 'toJSON')) refuseSubflowOutput('output serialization hooks are not supported');
      ancestors.add(item);
      try {
        if (Array.isArray(item)) {
          const length = outputArrayLength(item);
          heap += 32 + length * 8; json += 2 + length;
          for (let i = 0; i < length; i++) visit(outputProperty(item, String(i)), depth + 1);
        } else {
          // Keys are bounded before collecting descriptors/values. The object
          // itself is ordinary data, so own-key enumeration cannot execute code.
          for (const key in item) {
            if (!Object.hasOwn(item, key)) continue;
            heap += key.length * 2 + 48; json += outputJsonStringBytes(key) + 2;
            visit(outputProperty(item, key), depth + 1);
          }
        }
      } finally { ancestors.delete(item); }
    } else refuseSubflowOutput('output must contain serializable data');
    if (heap + json > SUBFLOW_OUTPUT_LIMITS.invocationBytes) refuseSubflowOutput('output descriptors exceed 128 MiB');
  };
  visit(value, 0);
  return { heap, json, values };
}

export class SubflowOutputBudget {
  private bytes = 0;
  private closed = false;
  private fallbackBytes = 0;
  private laneBytes = 0;
  private laneValues = 0;
  private fallbackValues = 0;
  private readonly lanes = new Map<string, { bytes: number; values: number }>();
  constructor() { ledger.active++; }
  reserve(bytes: number): void {
    if (this.closed) throw new Error('Subflow output reservation has expired');
    const next = Math.max(this.bytes, Math.ceil(bytes), 4096);
    if (!Number.isSafeInteger(next) || next > SUBFLOW_OUTPUT_LIMITS.invocationBytes) refuseSubflowOutput('transient output allocation exceeds 128 MiB');
    if (next === this.bytes) return;
    const total = ledger.bytes - this.bytes + next;
    const flow = getFlowRunAdmissionDiagnostics();
    const pending = pendingAllocationBytes('output', total);
    const heap = getHeapStatistics();
    const rss = process.memoryUsage().rss;
    if (total > SUBFLOW_OUTPUT_LIMITS.processBytes || pending > heap.heap_size_limit * 0.8 - heap.used_heap_size - 64 * MiB
      || !Number.isFinite(rss) || rss + pending > flow.maxRssBytes) {
      throw new SubflowOutputPressureError('SUBFLOW_OUTPUT_MEMORY', 'aggregate output allocation capacity is busy');
    }
    ledger.bytes = total; this.bytes = next;
    setAllocationReservation('output', ledger.bytes);
  }
  fallback(chars: number, parts = 0): void {
    assertOutputChars(chars);
    this.fallbackValues += parts + 1;
    if (this.fallbackValues + this.laneValues > SUBFLOW_OUTPUT_LIMITS.values) refuseSubflowOutput('output descriptor work exceeds 100000 values');
    this.fallbackBytes += chars * 2 + parts * 16;
    this.reserve(this.laneBytes + this.fallbackBytes * 4 + 4096);
  }
  lane(id: string, value: unknown): void {
    const media = outputProperty(value, 'outputMedia');
    if (media) outputArrayLength(media, SUBFLOW_OUTPUT_LIMITS.media);
    const measured = measureOutputData(value);
    const bytes = measured.heap + measured.json * 3;
    const previous = this.lanes.get(id);
    const values = this.laneValues - (previous?.values ?? 0) + measured.values;
    if (values + this.fallbackValues > SUBFLOW_OUTPUT_LIMITS.values) refuseSubflowOutput('output descriptor work exceeds 100000 values');
    const next = this.laneBytes - (previous?.bytes ?? 0) + bytes;
    this.reserve(next + this.fallbackBytes * 4 + 4096);
    this.laneBytes = next; this.laneValues = values; this.lanes.set(id, { bytes, values: measured.values });
  }
  release(): void {
    if (this.closed) return;
    this.closed = true; ledger.bytes -= this.bytes; ledger.active--;
    setAllocationReservation('output', ledger.bytes);
  }
}

/** Same admitted fallback for live returns and persisted completed children. */
export function latestSubflowAssistantText(messages: unknown, budget: SubflowOutputBudget): string {
  if (!messages) return '';
  for (let index = outputArrayLength(messages) - 1; index >= 0; index--) {
    const message = outputProperty(messages, String(index));
    if (outputProperty(message, 'role') !== 'assistant') continue;
    const calls = outputProperty(message, 'tool_calls');
    if (calls && outputArrayLength(calls)) continue;
    const content = outputProperty(message, 'content');
    let text: string;
    if (typeof content === 'string') { budget.fallback(content.length); text = content; }
    else if (Array.isArray(content)) {
      const count = outputArrayLength(content);
      let chars = 0;
      for (let i = 0; i < count; i++) {
        const part = outputProperty(content, String(i));
        chars += outputText(typeof part === 'string' ? part : part ? outputProperty(part, 'text') : '').length;
        assertOutputChars(chars);
      }
      budget.fallback(chars, count);
      const chunks: string[] = [];
      for (let i = 0; i < count; i++) {
        const part = outputProperty(content, String(i));
        chunks.push(outputText(typeof part === 'string' ? part : part ? outputProperty(part, 'text') : ''));
      }
      text = chunks.join('');
    } else text = '';
    text = text.trim();
    if (text) return text;
  }
  return '';
}
const reservations = globals.__flujoSubflowOutputReservations ??= new WeakMap<object, SubflowOutputBudget>();
export function holdSubflowOutput(result: object, budget: SubflowOutputBudget): void { reservations.set(result, budget); }
export function subflowOutputBudget(result: object): SubflowOutputBudget {
  let budget = reservations.get(result);
  if (!budget) { budget = new SubflowOutputBudget(); reservations.set(result, budget); }
  return budget;
}
export function releaseSubflowOutput(result: object): void { reservations.get(result)?.release(); reservations.delete(result); }
const consumption = globals.__flujoSubflowOutputConsumption ??= new AsyncLocalStorage<{ results: Set<object>; closed: boolean }>();
/** Provider adapters consume native tool objects inside this scope; ordinary
 * tool calls consume them through serialization/transcript projection here too.
 * Arbitrary callers retaining returned JS objects beyond this scope own them. */
export async function withSubflowOutputConsumption<T>(task: () => Promise<T>): Promise<T> {
  const existing = consumption.getStore();
  if (existing && !existing.closed) return task();
  const scope = { results: new Set<object>(), closed: false };
  return consumption.run(scope, async () => {
    try { return await task(); }
    finally { scope.closed = true; for (const result of scope.results) releaseSubflowOutput(result); scope.results.clear(); }
  });
}
export function retainConsumedSubflowOutput(result: object): void {
  const scope = consumption.getStore();
  if (scope && !scope.closed) scope.results.add(result);
  else releaseSubflowOutput(result);
}
const folds = globals.__flujoSubflowFolds ??= new WeakMap<object, Promise<void>>();
/** Serialize folds on the live parent, including same-visit stale retries. */
export async function withSubflowFold<T>(parent: object, task: () => Promise<T>): Promise<T> {
  const previous = folds.get(parent) ?? Promise.resolve();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => pending);
  folds.set(parent, tail);
  await previous;
  try { return await task(); }
  finally { release(); if (folds.get(parent) === tail) folds.delete(parent); }
}
export function getSubflowOutputDiagnostics() { return { active: ledger.active, reservedBytes: ledger.bytes,
  rejectedTooLarge: ledger.rejectedTooLarge, rejectedMemory: ledger.rejectedMemory, ...SUBFLOW_OUTPUT_LIMITS }; }

/** Bounded fan-out which never returns/rejects while a started worker survives. */
export async function mapSubflowOutput<T, R>(items: readonly T[], task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const length = outputArrayLength(items, SUBFLOW_OUTPUT_LIMITS.media);
  const results = new Array<R>(length);
  let cursor = 0, failed = false, failure: unknown;
  await Promise.all(Array.from({ length: Math.min(length, SUBFLOW_OUTPUT_LIMITS.promotionWorkers) }, async () => {
    while (!failed) {
      const index = cursor++;
      if (index >= length) return;
      try { results[index] = await task(items[index], index); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
    }
  }));
  if (failed) throw failure;
  return results;
}
