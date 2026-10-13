import { getHeapStatistics } from 'node:v8';

export class ConversationLogReadPressureError extends Error {
  constructor(readonly code: 'CONVERSATION_LOG_READ_BUSY' | 'CONVERSATION_LOG_READ_MEMORY', readonly status: 429 | 503) {
    super(status === 429 ? 'Conversation history reads are busy. Retry shortly.' : 'Insufficient memory to safely load complete conversation history. Retry after active work finishes.');
    this.name = 'ConversationLogReadPressureError';
  }
}
const runtime = globalThis as typeof globalThis & { __flujoConversationLogReadAdmission?: { active: number; bytes: number } };
const admission = runtime.__flujoConversationLogReadAdmission ??= { active: 0, bytes: 0 };
export const CONVERSATION_LOG_READ_CONCURRENCY = 4;

/** Opaque identity; only tokens registered in this module are valid. */
export interface ConversationReadReservation { readonly __conversationReadReservation: unique symbol }
type ReservationState = { open: boolean; pending: Set<Promise<unknown>> };
const reservations = new WeakMap<object, ReservationState>();

function reservationBytes(size: number): number {
  const bytes = size * 16 + 128 * 1024;
  const heap = getHeapStatistics();
  if (!Number.isSafeInteger(bytes) || size < 0 || admission.bytes + bytes > heap.heap_size_limit - heap.used_heap_size - 64 * 1024 * 1024) {
    throw new ConversationLogReadPressureError('CONVERSATION_LOG_READ_MEMORY', 503);
  }
  return bytes;
}

/** Conservative UTF-16, parsed object, array and projection reservation; not a measured heap guarantee.
 * Nested reads explicitly share a root slot, but add their own byte reservations.
 * Root release waits for all nested work, even if its callback returns or throws early.
 */
export async function withConversationLogReadAdmission<T>(size: number,
  task: (reservation: ConversationReadReservation) => Promise<T>, token?: ConversationReadReservation): Promise<T> {
  if (token !== undefined) {
    const state = token && reservations.get(token);
    if (!state?.open) throw new Error('Conversation read reservation is invalid or has expired.');
    const bytes = reservationBytes(size);
    admission.bytes += bytes;
    const pending = Promise.resolve().then(() => task(token)).finally(() => { admission.bytes -= bytes; });
    state.pending.add(pending);
    void pending.then(() => state.pending.delete(pending), () => state.pending.delete(pending));
    return pending;
  }
  if (admission.active >= CONVERSATION_LOG_READ_CONCURRENCY) throw new ConversationLogReadPressureError('CONVERSATION_LOG_READ_BUSY', 429);
  const bytes = reservationBytes(size);
  const reservation = Object.freeze({}) as ConversationReadReservation;
  const state: ReservationState = { open: true, pending: new Set() };
  reservations.set(reservation, state);
  admission.active++; admission.bytes += bytes;
  try { return await task(reservation); }
  finally {
    state.open = false;
    await Promise.allSettled([...state.pending]);
    reservations.delete(reservation);
    admission.active--; admission.bytes -= bytes;
  }
}

export function getConversationLogReadAdmission() { return { active: admission.active, bytes: admission.bytes }; }
