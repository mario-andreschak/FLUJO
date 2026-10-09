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

/** Conservative UTF-16, parsed object, array and projection reservation; not a measured heap guarantee. */
export async function withConversationLogReadAdmission<T>(size: number, task: () => Promise<T>): Promise<T> {
  if (admission.active >= CONVERSATION_LOG_READ_CONCURRENCY) throw new ConversationLogReadPressureError('CONVERSATION_LOG_READ_BUSY', 429);
  const bytes = size * 16 + 128 * 1024;
  const heap = getHeapStatistics();
  if (!Number.isSafeInteger(bytes) || size < 0 || admission.bytes + bytes > heap.heap_size_limit - heap.used_heap_size - 64 * 1024 * 1024) {
    throw new ConversationLogReadPressureError('CONVERSATION_LOG_READ_MEMORY', 503);
  }
  admission.active++; admission.bytes += bytes;
  try { return await task(); }
  finally { admission.active--; admission.bytes -= bytes; }
}

export function getConversationLogReadAdmission() { return { active: admission.active, bytes: admission.bytes }; }
