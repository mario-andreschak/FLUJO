import { getHeapStatistics } from 'node:v8';

export class ConversationLogReadPressureError extends Error {
  constructor(readonly code: 'CONVERSATION_LOG_READ_BUSY' | 'CONVERSATION_LOG_READ_MEMORY', readonly status: 429 | 503) {
    super(status === 429 ? 'Conversation history reads are busy. Retry shortly.' : 'Insufficient memory to safely load complete conversation history. Retry after active work finishes.');
    this.name = 'ConversationLogReadPressureError';
  }
}
const runtime = globalThis as typeof globalThis & { __flujoConversationLogReadAdmission?: { active: number; bytes: number; waiters?: Array<() => void> } };
const admission = runtime.__flujoConversationLogReadAdmission ??= { active: 0, bytes: 0 };
const waiters = admission.waiters ??= [];
export const CONVERSATION_LOG_READ_CONCURRENCY = 4;
/** A read waits this long for a slot or memory before it is refused. */
export const CONVERSATION_LOG_READ_WAIT_MS = 30_000;
/** UTF-16 text (2x) plus parsed objects and projection; measured well below this. */
const RESERVATION_FACTOR = 6;

/** Opaque identity; only tokens registered in this module are valid. */
export interface ConversationReadReservation { readonly __conversationReadReservation: unique symbol }
type ReservationState = { open: boolean; pending: Set<Promise<unknown>> };
const reservations = new WeakMap<object, ReservationState>();

function reservationBytes(size: number): number {
  const bytes = size * RESERVATION_FACTOR + 128 * 1024;
  if (!Number.isSafeInteger(bytes) || size < 0) throw new ConversationLogReadPressureError('CONVERSATION_LOG_READ_MEMORY', 503);
  return bytes;
}
function fits(bytes: number): boolean {
  const heap = getHeapStatistics();
  return admission.bytes + bytes <= heap.heap_size_limit - heap.used_heap_size - 64 * 1024 * 1024;
}
function wake(): void { for (const resolve of waiters.splice(0)) resolve(); }

/** Wait (FIFO wake-ups, bounded) for a root slot and heap headroom. Memory is
 * refused only when the read cannot fit even with no other read running. */
async function admitRoot(bytes: number): Promise<void> {
  const deadline = Date.now() + CONVERSATION_LOG_READ_WAIT_MS;
  for (;;) {
    const slot = admission.active < CONVERSATION_LOG_READ_CONCURRENCY;
    if (slot && fits(bytes)) return;
    if (slot && admission.active === 0) throw new ConversationLogReadPressureError('CONVERSATION_LOG_READ_MEMORY', 503);
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw slot ? new ConversationLogReadPressureError('CONVERSATION_LOG_READ_MEMORY', 503)
        : new ConversationLogReadPressureError('CONVERSATION_LOG_READ_BUSY', 429);
    }
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, Math.min(remaining, 1000));
      waiters.push(() => { clearTimeout(timer); resolve(); });
    });
  }
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
    // A nested read already owns its root slot; waiting here could deadlock.
    if (!fits(bytes)) throw new ConversationLogReadPressureError('CONVERSATION_LOG_READ_MEMORY', 503);
    admission.bytes += bytes;
    const pending = Promise.resolve().then(() => task(token)).finally(() => { admission.bytes -= bytes; wake(); });
    state.pending.add(pending);
    void pending.then(() => state.pending.delete(pending), () => state.pending.delete(pending));
    return pending;
  }
  const bytes = reservationBytes(size);
  await admitRoot(bytes);
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
    wake();
  }
}

export function getConversationLogReadAdmission() { return { active: admission.active, bytes: admission.bytes }; }
