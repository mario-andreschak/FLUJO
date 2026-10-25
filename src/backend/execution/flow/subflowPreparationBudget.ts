import { types } from 'node:util';
import { getHeapStatistics } from 'node:v8';
import { getCurrentWorkspace } from '@/utils/workspace';
import { getFlowRunAdmissionDiagnostics } from './runAdmission';

const MiB = 1024 * 1024;
export const SUBFLOW_PREPARATION_LIMITS = Object.freeze({
  sourceBytes: 8 * MiB, lanes: 4096, depth: 64, values: 100_000,
  resolvedTextBytes: 16 * MiB, workers: 16, resolutionWorkers: 4,
  planBytes: 128 * MiB, processBytes: 256 * MiB,
  externalReadBytes: 28 * MiB,
});
type PressureCode = 'SUBFLOW_PREPARATION_TOO_LARGE' | 'SUBFLOW_PREPARATION_MEMORY';
export class SubflowPreparationPressureError extends Error {
  readonly status: 413 | 503;
  readonly details: { code: PressureCode; status: number; type: string; retryAfter?: string };
  constructor(readonly code: PressureCode, reason: string) {
    super(`Subflow preparation refused: ${reason}. No queued jobs were discarded. ${code === 'SUBFLOW_PREPARATION_MEMORY'
      ? 'Retry after active work finishes.' : 'Use a smaller task batch, shorter input, or fewer requested workers.'}`);
    this.name = 'SubflowPreparationPressureError';
    this.status = code === 'SUBFLOW_PREPARATION_MEMORY' ? 503 : 413;
    if (code === 'SUBFLOW_PREPARATION_MEMORY') ledger.rejectedMemory++;
    else ledger.rejectedTooLarge++;
    this.details = { code, status: this.status, type: 'subflow_preparation_error',
      ...(this.status === 503 ? { retryAfter: '5' } : {}) };
  }
}
export function isSubflowPreparationPressureError(error: unknown): error is SubflowPreparationPressureError {
  return error instanceof Error && error.name === 'SubflowPreparationPressureError';
}
const tooLarge = (reason: string): never => {
  throw new SubflowPreparationPressureError('SUBFLOW_PREPARATION_TOO_LARGE', reason);
};
const globalBudget = globalThis as typeof globalThis & { __flujoSubflowPreparation?: { bytes: number; active: number; rejectedTooLarge: number; rejectedMemory: number } };
const ledger = globalBudget.__flujoSubflowPreparation ??= { bytes: 0, active: 0, rejectedTooLarge: 0, rejectedMemory: 0 };
ledger.rejectedTooLarge ??= 0;
ledger.rejectedMemory ??= 0;

export class SubflowPreparationBudget {
  private bytes = 0;
  private baseBytes = 0;
  private scratchBytes = 0;
  private closed = false;
  private textBytes = 0;
  readonly workspace = getCurrentWorkspace();
  reserve(bytes: number): void {
    this.update(Math.max(this.baseBytes, bytes), this.scratchBytes);
  }
  private update(base: number, scratch: number, releasing = false): void {
    if (this.closed) throw new Error('Subflow preparation reservation has expired.');
    const bytes = base + scratch;
    if (!Number.isSafeInteger(bytes) || bytes > SUBFLOW_PREPARATION_LIMITS.planBytes) tooLarge('projected plan exceeds 128 MiB');
    const requested = Math.max(bytes, MiB);
    const total = ledger.bytes - this.bytes + requested;
    const heap = getHeapStatistics();
    const flow = getFlowRunAdmissionDiagnostics();
    const pending = total + flow.reservedBytes;
    const available = heap.heap_size_limit * 0.8 - heap.used_heap_size - 64 * MiB;
    const rss = process.memoryUsage().rss;
    if (!releasing && (total > SUBFLOW_PREPARATION_LIMITS.processBytes || !Number.isFinite(available)
      || pending > available || !Number.isFinite(rss) || rss + pending > flow.maxRssBytes)) {
      throw new SubflowPreparationPressureError('SUBFLOW_PREPARATION_MEMORY', 'aggregate preparation allocation capacity is busy');
    }
    ledger.bytes = total;
    this.bytes = requested;
    this.baseBytes = base;
    this.scratchBytes = scratch;
  }
  scratch(): { reserve: (bytes: number) => void; release: () => void } {
    let held = 0, open = true;
    return { reserve: bytes => {
      if (!open) throw new Error('Subflow resolver reservation has expired.');
      const next = Math.max(held, bytes);
      this.update(this.baseBytes, this.scratchBytes - held + next);
      held = next;
    }, release: () => {
      if (!open) return;
      open = false;
      this.update(this.baseBytes, this.scratchBytes - held, true);
    } };
  }
  resolved(text: string): void {
    assertSubflowSource(text);
    this.textBytes += text.length * 2;
    if (this.textBytes > SUBFLOW_PREPARATION_LIMITS.resolvedTextBytes) tooLarge('resolved task text exceeds 16 MiB');
    this.reserve(this.textBytes * 4);
  }
  release(): void {
    if (this.closed) return;
    this.closed = true;
    ledger.bytes -= this.bytes;
  }
}
export async function withSubflowPreparationBudget<T>(task: (budget: SubflowPreparationBudget) => Promise<T>): Promise<T> {
  const budget = new SubflowPreparationBudget();
  budget.reserve(MiB);
  ledger.active++;
  try { return await task(budget); }
  finally { budget.release(); ledger.active--; }
}
export function getSubflowPreparationDiagnostics() {
  return { active: ledger.active, reservedBytes: ledger.bytes,
    rejectedTooLarge: ledger.rejectedTooLarge, rejectedMemory: ledger.rejectedMemory, ...SUBFLOW_PREPARATION_LIMITS };
}

export function assertSubflowSource(text: string): void {
  if (typeof text !== 'string' || text.length * 2 > SUBFLOW_PREPARATION_LIMITS.sourceBytes) tooLarge('source text exceeds 8 MiB');
}
export function assertSubflowLaneCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > SUBFLOW_PREPARATION_LIMITS.lanes) tooLarge('job count exceeds 4096');
}
export function subflowWorkerLimit(value: number | undefined): number {
  const workers = value ?? 4;
  if (!Number.isSafeInteger(workers) || workers < 1 || workers > SUBFLOW_PREPARATION_LIMITS.workers) tooLarge('worker count must be an integer from 1 through 16');
  return workers;
}

/** A lexical allocation preflight, not a replacement JSON parser. Syntax errors
 * within budget retain the caller's existing JSON.parse error/empty behavior.
 * Strings/escapes are scanned without slices, token arrays or decoded copies.
 */
export function preflightSubflowJson(text: string, topLevelArray = false): void {
  assertSubflowSource(text);
  let depth = 0, tokens = 0, items = 0;
  let inString = false, escaped = false, primitive = false, rootArray = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (/\s/.test(char)) { primitive = false; continue; }
    if (char === ',' || char === ':') { primitive = false; continue; }
    if (char === ']' || char === '}') { depth--; primitive = false; continue; }
    const start = char === '"' || char === '[' || char === '{' || !primitive;
    if (start) {
      if (++tokens > SUBFLOW_PREPARATION_LIMITS.values) tooLarge('JSON work exceeds 100000 values');
      if (topLevelArray && rootArray && depth === 1) assertSubflowLaneCount(++items);
    }
    if (char === '"') { inString = true; primitive = false; }
    else if (char === '[' || char === '{') {
      if (tokens === 1) rootArray = char === '[';
      if (++depth > SUBFLOW_PREPARATION_LIMITS.depth) tooLarge('JSON depth exceeds 64');
      primitive = false;
    } else primitive = true;
  }
}

export function preflightSubflowItems(text: string, mode: 'lines' | 'json-array', budget?: SubflowPreparationBudget): void {
  assertSubflowSource(text);
  if (mode === 'json-array') preflightSubflowJson(text, true);
  else {
    let count = 0, lines = 0, nonblank = false;
    for (let index = 0; index <= text.length; index++) {
      const char = text[index];
      if (char === '\n' || index === text.length) {
        if (++lines > SUBFLOW_PREPARATION_LIMITS.values) tooLarge('line splitting exceeds 100000 source lines');
        if (nonblank) assertSubflowLaneCount(++count);
        nonblank = false;
      } else if (!/\s/.test(char)) nonblank = true;
    }
  }
  budget?.reserve(text.length * 16 + SUBFLOW_PREPARATION_LIMITS.values * 128);
}

interface Footprint { heap: number; json: number; values: number }
function intrinsicPrototype(prototype: object, constructor: ObjectConstructor | ArrayConstructor): boolean {
  if (types.isProxy(prototype)) return false;
  const own = Object.getOwnPropertyDescriptor(prototype, 'constructor');
  return !!own && 'value' in own && typeof own.value === 'function' && !types.isProxy(own.value)
    && Object.getOwnPropertyDescriptor(own.value, 'prototype')?.value === prototype
    && Function.prototype.toString.call(own.value) === Function.prototype.toString.call(constructor);
}
function quotedBytes(text: string): number {
  let bytes = 2;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 32) bytes += [8, 9, 10, 12, 13].includes(code) ? 2 : 6;
    else if (code === 34 || code === 92) bytes += 2;
    else if (code < 128) bytes++;
    else if (code < 2048) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++; }
    else bytes += code >= 0xd800 && code <= 0xdfff ? 6 : 3;
  }
  return bytes;
}
/** Counts representation per occurrence even when JS shares string/object backing.
 * Durable JSON does not preserve aliases. No accessors, hooks or clones run here.
 */
export function estimateSubflowData(value: unknown, mode: 'new' | 'owned' | 'clone' = 'new'): Footprint {
  const memo = new WeakMap<object, Footprint>();
  const ancestors = new Set<object>();
  let work = 0;
  const walk = (item: unknown, depth: number): Footprint => {
    if (++work > SUBFLOW_PREPARATION_LIMITS.values || depth > SUBFLOW_PREPARATION_LIMITS.depth) tooLarge('data traversal exceeds the work budget');
    if (typeof item === 'string') {
      if (mode === 'new') assertSubflowSource(item);
      // Existing lane input stays owned elsewhere: scheduling references it,
      // while child runFlow independently admits any materialization. Recovery
      // copies only sharedInput, so charge its clone without serializing lanes.
      if (mode === 'owned') return { heap: 8, json: 0, values: 1 };
      return { heap: 24 + item.length * 2, json: mode === 'new' ? quotedBytes(item) : 0, values: 1 };
    }
    if (item === undefined || item === null || typeof item === 'boolean' || typeof item === 'number') return { heap: 8, json: 32, values: 1 };
    if (typeof item !== 'object' || types.isProxy(item) || ancestors.has(item)) tooLarge('input is not bounded plain data');
    const cached = memo.get(item);
    if (cached) return cached;
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    if (prototype !== null) {
      if (types.isProxy(prototype) || !intrinsicPrototype(prototype, array ? Array : Object)) tooLarge('input has an unsupported prototype');
      const parent = Object.getPrototypeOf(prototype);
      if (array ? !parent || types.isProxy(parent) || Object.getPrototypeOf(parent) !== null || !intrinsicPrototype(parent, Object) : parent !== null) tooLarge('input has an unsupported prototype chain');
    }
    const total = { heap: 64, json: 2, values: 1 };
    if (array) {
      if (item.length > SUBFLOW_PREPARATION_LIMITS.values) tooLarge('array exceeds the work budget');
      total.heap += item.length * 8;
      total.json += item.length * 5;
    }
    ancestors.add(item);
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!('value' in descriptor)) tooLarge('input contains an accessor');
      const child = walk(descriptor.value, depth + 1);
      total.heap += child.heap + key.length * 2 + 16;
      total.json += child.json + quotedBytes(key) + 2;
      total.values += child.values;
      if (total.values > SUBFLOW_PREPARATION_LIMITS.values || projectedBytes(total) > SUBFLOW_PREPARATION_LIMITS.planBytes) tooLarge('projected data exceeds the plan budget');
    }
    ancestors.delete(item); memo.set(item, total); return total;
  };
  return walk(value, 0);
}
function projectedBytes(value: Footprint): number { return value.heap * 2 + value.json * 3; }

export function reserveSubflowData(budget: SubflowPreparationBudget, value: unknown): void {
  budget.reserve(projectedBytes(estimateSubflowData(value)));
}

export function reserveExistingSubflowPlan(budget: SubflowPreparationBudget, sharedInput: unknown,
  lanes: readonly { input?: unknown }[], workers?: number, cloneSharedInput = false): void {
  assertSubflowLaneCount(lanes.length); subflowWorkerLimit(workers);
  const metadata = estimateSubflowData({ sharedInput, lanes }, 'owned');
  const clone = cloneSharedInput ? estimateSubflowData(sharedInput, 'clone').heap * 2 : 0;
  budget.reserve(metadata.heap * 2 + clone + lanes.length * 2048);
}

export function reserveSubflowPlan(budget: SubflowPreparationBudget, sharedInput: unknown,
  lanes: readonly { input?: unknown }[], workers?: number): void {
  assertSubflowLaneCount(lanes.length); subflowWorkerLimit(workers);
  const bytes = projectedBytes(estimateSubflowData({ sharedInput, lanes })) + lanes.length * 2048;
  budget.reserve(bytes);
}
export function reserveSubflowSpawn(budget: SubflowPreparationBudget, sharedInput: unknown, taskCount: number, historyMode: boolean): void {
  assertSubflowLaneCount(taskCount);
  const shared = projectedBytes(estimateSubflowData(sharedInput));
  budget.reserve(shared * (historyMode ? taskCount + 1 : 1) + taskCount * 2048);
}

/** No unbounded Promise.all, and failure drains every already-started resolver. */
export async function mapSubflowPreparation<T, R>(items: readonly T[], task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  assertSubflowLaneCount(items.length);
  const results: R[] = new Array(items.length);
  let cursor = 0;
  let failed = false, failure: unknown;
  const worker = async () => {
    while (!failed) {
      const index = cursor++;
      if (index >= items.length) return;
      try { results[index] = await task(items[index], index); }
      catch (error) { failed = true; failure ??= error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(items.length, SUBFLOW_PREPARATION_LIMITS.resolutionWorkers) }, worker));
  if (failed) throw failure;
  return results;
}

/** Resolve individual tokens before joining; repeated substitutions cannot build
 * an oversized string before its size is known. External resolution additionally
 * reserves room before awaiting for one admitted 8 MiB UTF-16 value, its worst
 * case 12 MiB UTF-8 buffer, and an 8 MiB replacement copy. This bounds this
 * consumer's transients, not legacy upstream index/global metadata reads.
 */
export function preflightSubflowReferences(text: string): void {
  assertSubflowSource(text);
  let potential = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '@' || (text[index] === '$' && text[index + 1] === '{')) {
      if (++potential > SUBFLOW_PREPARATION_LIMITS.lanes) tooLarge('template reference work exceeds 4096 markers');
    }
  }
}

type TokenPositions = readonly { fullMatch: string; index: number }[];
function* subflowTokens(text: string, pattern: RegExp | TokenPositions) {
  if (!(pattern instanceof RegExp)) { yield* pattern; return; }
  const scan = new RegExp(pattern.source, 'g');
  for (let match = scan.exec(text); match; match = scan.exec(text)) {
    yield { fullMatch: match[0], index: match.index };
  }
}
export async function resolveBoundedSubflowTokens(text: string, pattern: RegExp | TokenPositions, resolve: (token: string) => Promise<string>, budget: SubflowPreparationBudget, externalRead = false): Promise<string> {
  assertSubflowSource(text);
  const scratch = budget.scratch();
  try {
  const chunks: string[] = [], cache = new Map<string, string>();
  let cursor = 0, size = 0, matches = 0;
  const append = (part: string) => {
    size += part.length * 2;
    if (size > SUBFLOW_PREPARATION_LIMITS.sourceBytes) tooLarge('template expansion exceeds 8 MiB');
    scratch.reserve(text.length * 2 + size * 4);
    chunks.push(part);
  };
  for (const match of subflowTokens(text, pattern)) {
    if (++matches > SUBFLOW_PREPARATION_LIMITS.lanes) tooLarge('template reference count exceeds 4096');
    append(text.slice(cursor, match.index));
    let value = cache.get(match.fullMatch);
    if (value === undefined) {
      if (externalRead) scratch.reserve(text.length * 2 + size * 4 + SUBFLOW_PREPARATION_LIMITS.externalReadBytes);
      value = await resolve(match.fullMatch); assertSubflowSource(value); cache.set(match.fullMatch, value);
    }
    append(value); cursor = match.index + match.fullMatch.length;
  }
  if (!matches) return text;
  append(text.slice(cursor));
  return chunks.join('');
  } finally { scratch.release(); }
}

export function preflightSubflowHandoffArguments(calls: readonly { function: { arguments: string } }[], budget?: SubflowPreparationBudget): void {
  assertSubflowLaneCount(calls.length);
  let bytes = 0;
  for (const call of calls) {
    const text = call.function.arguments || '{}';
    bytes += text.length * 2;
    if (bytes > SUBFLOW_PREPARATION_LIMITS.resolvedTextBytes) tooLarge('handoff arguments exceed 16 MiB');
    preflightSubflowJson(text);
  }
  if (budget) {
    reserveSubflowData(budget, calls);
    budget.reserve(bytes * 8 + SUBFLOW_PREPARATION_LIMITS.values * 128);
  }
}
