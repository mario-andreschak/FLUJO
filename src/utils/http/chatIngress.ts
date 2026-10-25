import { getHeapStatistics } from 'node:v8';
import { pendingAllocationBytes, setAllocationReservation } from '@/backend/execution/flow/allocationReservations';

const MiB = 1024 * 1024;
export const CHAT_INGRESS_LIMITS = Object.freeze({
  bodyBytes: 8 * MiB, urlCharacters: 8 * MiB, queryParameters: 128,
  depth: 64, values: 100_000, chunks: 100_000, bodyTimeoutMs: 30_000,
  owners: 16, parsingBytes: 96 * MiB, processBytes: 256 * MiB, maxRssBytes: 2 * 1024 * MiB,
});
type Code = 'CHAT_INPUT_TOO_LARGE' | 'CHAT_INPUT_BUSY' | 'CHAT_INPUT_MEMORY' | 'CHAT_INPUT_INVALID' | 'CHAT_INPUT_ABORTED';
export class ChatIngressError extends Error {
  readonly status: 400 | 413 | 429 | 503;
  constructor(readonly code: Code) {
    super(code === 'CHAT_INPUT_TOO_LARGE' ? 'Chat input exceeds safe byte, depth or value limits. Reduce the input before retrying.'
      : code === 'CHAT_INPUT_BUSY' ? 'Chat input capacity is busy. Retry after active requests finish.'
        : code === 'CHAT_INPUT_MEMORY' ? 'Insufficient memory for another chat input. Retry after active work finishes.'
          : code === 'CHAT_INPUT_ABORTED' ? 'Chat input reading was cancelled or timed out. Retry with a complete request.'
            : 'Chat input must contain a valid JSON object and supported request fields.');
    this.name = 'ChatIngressError';
    this.status = code === 'CHAT_INPUT_TOO_LARGE' ? 413 : code === 'CHAT_INPUT_BUSY' ? 429 : code === 'CHAT_INPUT_MEMORY' ? 503 : 400;
  }
}
export function isChatIngressError(error: unknown): error is ChatIngressError {
  return error instanceof Error && error.name === 'ChatIngressError'
    && ['CHAT_INPUT_TOO_LARGE', 'CHAT_INPUT_BUSY', 'CHAT_INPUT_MEMORY', 'CHAT_INPUT_INVALID', 'CHAT_INPUT_ABORTED'].includes((error as ChatIngressError).code);
}
export interface ChatIngressPermit { readonly release: () => void }
interface Reservation { bytes: number; owners: number; claimed: boolean; parsed: boolean }
interface Runtime {
  active: number; bytes: number; parsing: number; rejectedSize: number; rejectedBusy: number; rejectedMemory: number;
  reservations: WeakMap<ChatIngressPermit, Reservation>;
}
const host = globalThis as typeof globalThis & { __flujoChatIngressV1?: Runtime };
const runtime = host.__flujoChatIngressV1 ??= {
  active: 0, bytes: 0, parsing: 0, rejectedSize: 0, rejectedBusy: 0, rejectedMemory: 0, reservations: new WeakMap(),
};
setAllocationReservation('ingress', runtime.bytes);
export function refuseChatInput(code: Code): never {
  if (code === 'CHAT_INPUT_TOO_LARGE') runtime.rejectedSize++;
  if (code === 'CHAT_INPUT_BUSY') runtime.rejectedBusy++;
  if (code === 'CHAT_INPUT_MEMORY') runtime.rejectedMemory++;
  throw new ChatIngressError(code);
}
function releaseOwner(record: Reservation): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--record.owners) return;
    runtime.active--; runtime.bytes -= record.bytes;
    setAllocationReservation('ingress', runtime.bytes);
    if (!record.parsed) runtime.parsing--;
  };
}
/** Before reader acquisition, URL decoding, buffers, or JSON parsing. No wait queue. */
export function acquireChatIngress(request: Pick<Request, 'method' | 'url' | 'headers'>): ChatIngressPermit {
  if (request.url.length > CHAT_INGRESS_LIMITS.urlCharacters) refuseChatInput('CHAT_INPUT_TOO_LARGE');
  // The workspace wrapper decodes query parameters for every HTTP method.
  // Bound raw parameter work here as well as GET parsing, before that wrapper.
  const queryStart = request.url.indexOf('?');
  if (queryStart >= 0) {
    let parameters = 1;
    for (let index = queryStart + 1; index < request.url.length && request.url[index] !== '#'; index++) {
      if (request.url[index] === '&' && ++parameters > CHAT_INGRESS_LIMITS.queryParameters) refuseChatInput('CHAT_INPUT_TOO_LARGE');
    }
  }
  const length = request.headers.get('content-length');
  if (length !== null && (length.length > 16 || !/^\d+$/.test(length) || Number(length) > CHAT_INGRESS_LIMITS.bodyBytes)) {
    refuseChatInput('CHAT_INPUT_TOO_LARGE');
  }
  if (runtime.active >= CHAT_INGRESS_LIMITS.owners || runtime.bytes + CHAT_INGRESS_LIMITS.parsingBytes > CHAT_INGRESS_LIMITS.processBytes) {
    refuseChatInput('CHAT_INPUT_BUSY');
  }
  const heap = getHeapStatistics();
  const rss = process.memoryUsage().rss;
  const pending = pendingAllocationBytes('ingress', runtime.bytes + CHAT_INGRESS_LIMITS.parsingBytes);
  const available = heap.heap_size_limit * 0.8 - heap.used_heap_size - 64 * MiB;
  if (!Number.isFinite(rss) || rss + pending > CHAT_INGRESS_LIMITS.maxRssBytes
    || !Number.isFinite(available) || pending > available) refuseChatInput('CHAT_INPUT_MEMORY');
  const record: Reservation = { bytes: CHAT_INGRESS_LIMITS.parsingBytes, owners: 1, claimed: false, parsed: false };
  const permit = Object.freeze({ release: releaseOwner(record) });
  runtime.reservations.set(permit, record);
  runtime.active++; runtime.parsing++; runtime.bytes += record.bytes;
  setAllocationReservation('ingress', runtime.bytes);
  return permit;
}
function reservation(permit: ChatIngressPermit): Reservation {
  const record = runtime.reservations.get(permit);
  if (!record?.owners) throw new Error('Chat ingress permit is invalid or expired.');
  return record;
}
function recheckChatIngressMemory(): void {
  const heap = getHeapStatistics();
  const rss = process.memoryUsage().rss;
  const pending = pendingAllocationBytes('ingress', runtime.bytes);
  const available = heap.heap_size_limit * 0.8 - heap.used_heap_size - 64 * MiB;
  if (!Number.isFinite(rss) || rss + pending > CHAT_INGRESS_LIMITS.maxRssBytes
    || !Number.isFinite(available) || pending > available) refuseChatInput('CHAT_INPUT_MEMORY');
}
/** One service claim; the route keeps its independent construction lifetime. */
export function claimChatIngress(permit: ChatIngressPermit): { release: () => void; retain: () => () => void } {
  const record = reservation(permit);
  if (record.claimed || !record.parsed) throw new Error('Chat ingress permit cannot be claimed twice or before parsing.');
  record.claimed = true; record.owners++;
  const release = releaseOwner(record);
  let closed = false;
  return { release: () => { closed = true; release(); }, retain: () => {
    if (closed || !record.owners) throw new Error('Chat ingress producer has expired.');
    record.owners++;
    return releaseOwner(record);
  } };
}
export function finishChatInputParsing(permit: ChatIngressPermit, characters: number, values: number, rawBytes = characters): void {
  const record = reservation(permit);
  if (record.parsed) throw new Error('Chat ingress input was already parsed.');
  if (![characters, values, rawBytes].every(value => Number.isSafeInteger(value) && value >= 0)
    || values > CHAT_INGRESS_LIMITS.values) refuseChatInput('CHAT_INPUT_TOO_LARGE');
  // A small unescaped string can pin the entire decoded source while escaped
  // fields allocate independent strings. Retain both charges, plus metadata.
  const bytes = Math.max(characters * 2, rawBytes * 2) + characters * 2 + values * 192 + MiB;
  if (!Number.isSafeInteger(bytes) || bytes > record.bytes) refuseChatInput('CHAT_INPUT_TOO_LARGE');
  runtime.bytes -= record.bytes - bytes; record.bytes = bytes; record.parsed = true; runtime.parsing--;
  setAllocationReservation('ingress', runtime.bytes);
}
export function getChatIngressDiagnostics() {
  return Object.freeze({ active: runtime.active, parsing: runtime.parsing, reservedBytes: runtime.bytes,
    rejectedSize: runtime.rejectedSize, rejectedBusy: runtime.rejectedBusy, rejectedMemory: runtime.rejectedMemory,
    ...CHAT_INGRESS_LIMITS });
}

/** Allocation preflight over bytes: no decoded strings, token arrays, or recursion.
 * JSON.parse remains the syntax authority; a malformed in-budget body is 400.
 */
export function preflightChatJson(bytes: Uint8Array): number {
  let depth = 0, values = 0, string = false, escape = false, primitive = false;
  for (let index = 0; index < bytes.length; index++) {
    const char = bytes[index];
    if (string) {
      if (escape) escape = false;
      else if (char === 92) escape = true;
      else if (char === 34) string = false;
      continue;
    }
    if (char === 32 || char === 10 || char === 13 || char === 9 || char === 44 || char === 58) { primitive = false; continue; }
    if (char === 93 || char === 125) { depth--; primitive = false; continue; }
    if (char === 34 || char === 91 || char === 123 || !primitive) {
      if (++values > CHAT_INGRESS_LIMITS.values) refuseChatInput('CHAT_INPUT_TOO_LARGE');
    }
    if (char === 34) { string = true; primitive = false; }
    else if (char === 91 || char === 123) {
      if (++depth > CHAT_INGRESS_LIMITS.depth) refuseChatInput('CHAT_INPUT_TOO_LARGE');
      primitive = false;
    } else primitive = true;
  }
  return values;
}
export async function readChatJson(request: Request, permit: ChatIngressPermit): Promise<{ data: unknown; characters: number; values: number; rawBytes: number }> {
  if (reservation(permit).parsed) throw new Error('Chat ingress input was already parsed.');
  if (!request.body || typeof request.body.getReader !== 'function') refuseChatInput('CHAT_INPUT_INVALID');
  recheckChatIngressMemory();
  // One backing store bounds metadata even for arbitrarily small chunks.
  const storage = Buffer.allocUnsafe(CHAT_INGRESS_LIMITS.bodyBytes);
  const reader = request.body.getReader();
  let total = 0, chunks = 0, aborted = false;
  let cancellation: Promise<void> | undefined;
  // A second cancel on an already-closed stream resolves immediately even if
  // its first underlying cancellation is still pending. Retain that first task.
  const cancel = () => cancellation ??= reader.cancel().then(() => undefined, () => undefined);
  const abort = () => { aborted = true; void cancel(); };
  const timer = setTimeout(abort, CHAT_INGRESS_LIMITS.bodyTimeoutMs);
  timer.unref?.();
  request.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (request.signal?.aborted) abort();
    for (;;) {
      const { value, done } = await reader.read();
      if (aborted) refuseChatInput('CHAT_INPUT_ABORTED');
      if (done) break;
      if (++chunks > CHAT_INGRESS_LIMITS.chunks || value.byteLength > storage.length - total) refuseChatInput('CHAT_INPUT_TOO_LARGE');
      storage.set(value, total); total += value.byteLength;
    }
    const bytes = storage.subarray(0, total);
    const values = preflightChatJson(bytes);
    recheckChatIngressMemory();
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { refuseChatInput('CHAT_INPUT_INVALID'); }
    let data: unknown;
    try { data = JSON.parse(text); } catch { refuseChatInput('CHAT_INPUT_INVALID'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) refuseChatInput('CHAT_INPUT_INVALID');
    return { data, characters: text.length, values, rawBytes: total };
  } catch (error) {
    // Cancellation may await transport cleanup. Keep the caller's permit until it settles.
    await cancel();
    throw error;
  } finally {
    clearTimeout(timer); request.signal?.removeEventListener('abort', abort);
    storage.fill(0, 0, total); reader.releaseLock();
  }
}
