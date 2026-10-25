import { AsyncLocalStorage } from 'node:async_hooks';
import { types } from 'node:util';
import { getHeapStatistics } from 'node:v8';
import { pendingAllocationBytes, setAllocationReservation } from './allocationReservations';

import { getCurrentWorkspace } from '@/utils/workspace';

const MiB = 1024 * 1024;
const MIN_RESERVATION_BYTES = MiB;
const INPUT_EXPANSION = 4;
const MAX_VALUES = 100_000;
const MAX_DEPTH = 64;
const CAPABILITY_FIELDS = new Set(['emit', 'abortSignal', 'executionAuthority', 'executionExtensionContext', 'behaviorToolRegistry']);

/** Structural subset: all enumerable data fields are estimated, not just these examples. */
export interface FlowRunAdmissionInput {
  conversationId?: string;
  messages?: unknown;
  prompt?: unknown;
  flowDefinition?: unknown;
  variables?: unknown;
}

export type FlowRunPressureCode = 'FLOW_RUN_BUSY' | 'FLOW_RUN_MEMORY' | 'FLOW_RUN_INPUT_TOO_LARGE';

export class FlowRunPressureError extends Error {
  readonly retryAfterSeconds = 5;
  readonly status: 413 | 429 | 503;
  constructor(readonly code: FlowRunPressureCode) {
    super(code === 'FLOW_RUN_BUSY'
      ? 'Flow execution capacity is busy. Retry after active work finishes.'
      : code === 'FLOW_RUN_INPUT_TOO_LARGE'
        ? 'Flow input exceeds safe admission limits. Reduce the input before retrying.'
        : 'Insufficient memory to admit another Flow execution. Retry after active work finishes.');
    this.name = 'FlowRunPressureError';
    this.status = code === 'FLOW_RUN_BUSY' ? 429 : code === 'FLOW_RUN_INPUT_TOO_LARGE' ? 413 : 503;
  }
}

export function isFlowRunPressureError(error: unknown): error is FlowRunPressureError {
  return error instanceof Error && error.name === 'FlowRunPressureError'
    && ['FLOW_RUN_BUSY', 'FLOW_RUN_MEMORY', 'FLOW_RUN_INPUT_TOO_LARGE'].includes((error as FlowRunPressureError).code);
}

/** Opaque runtime identity. Fabricated objects cannot be scoped or claimed. */
export interface FlowRunAdmissionPermit {
  readonly release: () => void;
}

interface WorkspaceUsage { active: number; bytes: number; conversations: Map<string, number> }
interface Reservation {
  workspace: string;
  conversationId?: string;
  bytes: number;
  open: boolean;
  scoped: boolean;
  claimed: boolean;
}
interface AdmissionRuntime {
  active: number;
  bytes: number;
  workspaces: Map<string, WorkspaceUsage>;
  reservations: WeakMap<FlowRunAdmissionPermit, Reservation>;
  scope: AsyncLocalStorage<FlowRunAdmissionPermit>;
  rejectedBusy: number;
  rejectedMemory: number;
  rejectedInput: number;
}
const globalRuntime = globalThis as typeof globalThis & { __flujoFlowRunAdmission?: AdmissionRuntime };
const runtime = globalRuntime.__flujoFlowRunAdmission ??= {
  active: 0, bytes: 0, workspaces: new Map(), reservations: new WeakMap(), scope: new AsyncLocalStorage(),
  rejectedBusy: 0, rejectedMemory: 0, rejectedInput: 0,
};
setAllocationReservation('run', runtime.bytes);

function configured(name: string, fallback: number): number {
  const value = Number(process.env[`FLUJO_RUN_ADMISSION_${name}`]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function limits() {
  return {
    maxProcessRuns: configured('MAX_PROCESS_RUNS', 64),
    maxWorkspaceRuns: configured('MAX_WORKSPACE_RUNS', 32),
    maxConversationRuns: configured('MAX_CONVERSATION_RUNS', 4),
    maxProcessBytes: configured('MAX_PROCESS_BYTES', 512 * MiB),
    maxWorkspaceBytes: configured('MAX_WORKSPACE_BYTES', 256 * MiB),
    maxInputBytes: configured('MAX_INPUT_BYTES', 64 * MiB),
    maxRssBytes: configured('MAX_RSS_BYTES', 2048 * MiB),
  };
}

function refuse(code: FlowRunPressureCode): never {
  if (code === 'FLOW_RUN_BUSY') runtime.rejectedBusy++;
  else if (code === 'FLOW_RUN_MEMORY') runtime.rejectedMemory++;
  else runtime.rejectedInput++;
  throw new FlowRunPressureError(code);
}

const arrayBufferSize = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const sharedBufferSize = typeof SharedArrayBuffer === 'undefined' ? undefined
  : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')!.get!;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'buffer')!.get!;
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer')!.get!;

function isIntrinsicConstructorPrototype(prototype: object, intrinsic: ObjectConstructor | ArrayConstructor): boolean {
  if (types.isProxy(prototype)) return false;
  const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
  if (!constructor || !('value' in constructor) || typeof constructor.value !== 'function'
    || types.isProxy(constructor.value)) return false;
  return Object.getOwnPropertyDescriptor(constructor.value, 'prototype')?.value === prototype
    && Function.prototype.toString.call(constructor.value) === Function.prototype.toString.call(intrinsic);
}

function isIntrinsicObjectPrototype(prototype: object | null): boolean {
  return prototype !== null && !types.isProxy(prototype) && Object.getPrototypeOf(prototype) === null
    && isIntrinsicConstructorPrototype(prototype, Object);
}

/** structuredClone/VM data can have another realm's genuine Object/Array prototypes.
 * Match intrinsic constructor ownership, not a local prototype identity or a
 * caller-controlled constructor name. Unknown classes and prototype proxies
 * still refuse admission without evaluating accessors or proxy traps.
 */
function hasDataPrototype(value: object, array: boolean): boolean {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) return true;
  if (types.isProxy(prototype)) return false;
  return array
    ? Array.isArray(prototype) && isIntrinsicConstructorPrototype(prototype, Array)
      && isIntrinsicObjectPrototype(Object.getPrototypeOf(prototype))
    : isIntrinsicObjectPrototype(prototype);
}

/** No cloning, JSON serialization, accessors or publisher callbacks. Reject uncertainty. */
function estimateInputBytes(input: FlowRunAdmissionInput, ceiling: number): number {
  let bytes = 0;
  let values = 0;
  const seen = new Set<object>();
  const add = (amount: number) => {
    bytes += amount;
    if (!Number.isSafeInteger(bytes) || bytes > ceiling) refuse('FLOW_RUN_INPUT_TOO_LARGE');
  };
  const visit = (value: unknown, depth: number): void => {
    if (++values > MAX_VALUES || depth > MAX_DEPTH) refuse('FLOW_RUN_INPUT_TOO_LARGE');
    if (typeof value === 'string') { add(24 + value.length * 2); return; }
    if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') { add(8); return; }
    if (typeof value !== 'object' || types.isProxy(value)) refuse('FLOW_RUN_INPUT_TOO_LARGE');
    if (seen.has(value)) return;
    seen.add(value);
    add(64);
    if (types.isArrayBuffer(value)) { add(arrayBufferSize.call(value)); return; }
    if (types.isSharedArrayBuffer(value)) { add(sharedBufferSize!.call(value)); return; }
    if (ArrayBuffer.isView(value)) {
      visit((types.isDataView(value) ? dataViewBuffer : typedArrayBuffer).call(value), depth + 1);
      return;
    }
    const array = Array.isArray(value);
    if (!hasDataPrototype(value, array)) refuse('FLOW_RUN_INPUT_TOO_LARGE');
    if (array) {
      if (value.length > MAX_VALUES) refuse('FLOW_RUN_INPUT_TOO_LARGE');
      add(value.length * 8); // Sparse arrays retain their slot capacity too.
    }
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (depth === 0 && CAPABILITY_FIELDS.has(key)) continue;
      add(16 + key.length * 2);
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor)) refuse('FLOW_RUN_INPUT_TOO_LARGE');
      visit(descriptor.value, depth + 1);
    }
  };
  visit(input, 0);
  return bytes;
}

function conversationIdentity(input: FlowRunAdmissionInput): string | undefined {
  if (!input || typeof input !== 'object' || types.isProxy(input)) refuse('FLOW_RUN_INPUT_TOO_LARGE');
  const descriptor = Object.getOwnPropertyDescriptor(input, 'conversationId');
  if (descriptor && (!('value' in descriptor) || (descriptor.value !== undefined && typeof descriptor.value !== 'string'))) {
    refuse('FLOW_RUN_INPUT_TOO_LARGE');
  }
  return descriptor?.value;
}

function reservationBytes(input: FlowRunAdmissionInput, config: ReturnType<typeof limits>): number {
  const bytes = Math.max(MIN_RESERVATION_BYTES, estimateInputBytes(input, config.maxInputBytes) * INPUT_EXPANSION);
  if (!Number.isSafeInteger(bytes)) refuse('FLOW_RUN_INPUT_TOO_LARGE');
  return bytes;
}

function checkMemory(bytes: number, workspace: WorkspaceUsage | undefined, replacingBytes: number, config: ReturnType<typeof limits>): void {
  const processBytes = runtime.bytes - replacingBytes + bytes;
  const workspaceBytes = (workspace?.bytes ?? 0) - replacingBytes + bytes;
  const heap = getHeapStatistics();
  const rss = process.memoryUsage().rss;
  // Reservations deliberately overlap already materialized input. This is a
  // conservative admission estimate, not a claim of exact RSS/heap accounting.
  const availableHeap = heap.heap_size_limit - heap.used_heap_size - Math.ceil(heap.heap_size_limit * 0.2) - 64 * MiB;
  const pending = pendingAllocationBytes('run', processBytes);
  if (processBytes > config.maxProcessBytes || workspaceBytes > config.maxWorkspaceBytes
    || !Number.isFinite(availableHeap) || pending > availableHeap
    || !Number.isFinite(rss) || rss + pending > config.maxRssBytes) refuse('FLOW_RUN_MEMORY');
}

/** Immediate admission; reservations include time spent waiting for conversation locks. */
export function acquireFlowRunAdmission<T extends FlowRunAdmissionInput>(input: T): FlowRunAdmissionPermit {
  const workspace = getCurrentWorkspace();
  const conversationId = conversationIdentity(input);
  const config = limits();
  let usage = runtime.workspaces.get(workspace);
  if (runtime.active >= config.maxProcessRuns || (usage?.active ?? 0) >= config.maxWorkspaceRuns
    || (conversationId !== undefined && (usage?.conversations.get(conversationId) ?? 0) >= config.maxConversationRuns)) {
    refuse('FLOW_RUN_BUSY');
  }
  const bytes = reservationBytes(input, config);
  checkMemory(bytes, usage, 0, config);
  if (!usage) {
    usage = { active: 0, bytes: 0, conversations: new Map() };
    runtime.workspaces.set(workspace, usage);
  }
  const owner = usage;
  const reservation: Reservation = { workspace, conversationId, bytes, open: true, scoped: false, claimed: false };
  const permit = Object.freeze({ release: () => {
    if (!reservation.open) return;
    reservation.open = false;
    runtime.active--; runtime.bytes -= reservation.bytes;
    setAllocationReservation('run', runtime.bytes);
    owner.active--; owner.bytes -= reservation.bytes;
    if (conversationId !== undefined) {
      const count = owner.conversations.get(conversationId)! - 1;
      if (count) owner.conversations.set(conversationId, count);
      else owner.conversations.delete(conversationId);
    }
    if (!owner.active) runtime.workspaces.delete(workspace);
  } });
  runtime.reservations.set(permit, reservation);
  runtime.active++; runtime.bytes += bytes;
  setAllocationReservation('run', runtime.bytes);
  owner.active++; owner.bytes += bytes;
  if (conversationId !== undefined) owner.conversations.set(conversationId, (owner.conversations.get(conversationId) ?? 0) + 1);
  return permit;
}

/** A preflight authorizes exactly one run. Nested/parallel descendants need fresh capacity. */
export function claimFlowRunAdmission<T extends FlowRunAdmissionInput>(input: T): FlowRunAdmissionPermit {
  const inherited = runtime.scope.getStore();
  const reservation = inherited && runtime.reservations.get(inherited);
  if (!inherited || reservation?.claimed) {
    const permit = acquireFlowRunAdmission(input);
    runtime.reservations.get(permit)!.claimed = true;
    return permit;
  }
  if (!reservation?.open) throw new Error('Flow run admission scope has expired.');
  recheckFlowRunAdmission(inherited, input);
  reservation.claimed = true;
  return inherited;
}

/** Recheck owner-transformed payload before any execution mutation or dispatch. */
export function recheckFlowRunAdmission<T extends FlowRunAdmissionInput>(permit: FlowRunAdmissionPermit, input: T): void {
  const reservation = permit && runtime.reservations.get(permit);
  if (!reservation?.open) throw new Error('Flow run admission permit has expired.');
  if (reservation.workspace !== getCurrentWorkspace() || reservation.conversationId !== conversationIdentity(input)) {
    throw new Error('Flow run admission does not match the current workspace and conversation.');
  }
  const config = limits();
  const bytes = Math.max(reservation.bytes, reservationBytes(input, config));
  const usage = runtime.workspaces.get(reservation.workspace)!;
  checkMemory(bytes, usage, reservation.bytes, config);
  const growth = bytes - reservation.bytes;
  runtime.bytes += growth; usage.bytes += growth; reservation.bytes = bytes;
  setAllocationReservation('run', runtime.bytes);
}

/** Scope owns preflight cleanup even when setup fails before runFlow claims it. */
export async function withFlowRunAdmission<T>(permit: FlowRunAdmissionPermit, task: () => Promise<T>): Promise<T> {
  const reservation = permit && runtime.reservations.get(permit);
  if (!reservation?.open || reservation.scoped || reservation.claimed) throw new Error('Flow run admission permit is invalid or already used.');
  if (reservation.workspace !== getCurrentWorkspace()) throw new Error('Flow run admission workspace mismatch.');
  reservation.scoped = true;
  try { return await runtime.scope.run(permit, task); }
  finally { permit.release(); }
}

/** Numeric diagnostics only: no workspace/conversation IDs, prompts or credentials. */
export function getFlowRunAdmissionDiagnostics() {
  const workspace = runtime.workspaces.get(getCurrentWorkspace());
  return {
    activeRuns: runtime.active, reservedBytes: runtime.bytes, activeWorkspaces: runtime.workspaces.size,
    workspaceActiveRuns: workspace?.active ?? 0, workspaceReservedBytes: workspace?.bytes ?? 0,
    workspaceConversations: workspace?.conversations.size ?? 0,
    rejectedBusy: runtime.rejectedBusy, rejectedMemory: runtime.rejectedMemory, rejectedInput: runtime.rejectedInput,
    ...limits(), minReservationBytes: MIN_RESERVATION_BYTES, inputExpansion: INPUT_EXPANSION,
  };
}
