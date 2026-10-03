import type { ExecutionEvent } from '@/shared/types/execution/events';
import { EXECUTION_STREAM_CONTROL_EVENT, type ExecutionStreamControl } from '@/shared/types/execution/streamControl';
import { getCurrentWorkspace, workspaceCacheKey } from '@/utils/workspace';
import { MAX_EXECUTION_EVENT_WIRE_BYTES, snapshotEventPayload, type EventPayload } from './eventPayload';

export const EXECUTION_STREAM_LIMITS = Object.freeze({ maxProcess: 64, maxWorkspace: 16, maxConversation: 4, maxReplayReads: 4, maxQueueBytes: 1024 * 1024 });
const CONTROL_RESERVE_BYTES = 1024;

/** Active SSE admission only. It never admits or cancels an execution run. */
export class ExecutionStreamAdmission {
  private active = 0;
  private workspaces = new Map<string, number>();
  private conversations = new Map<string, number>();
  private rejected = 0;
  private replayReads = 0;
  constructor(private limits: { [K in keyof typeof EXECUTION_STREAM_LIMITS]: number } = EXECUTION_STREAM_LIMITS) {}
  reserve(conversationId?: string): (() => void) | undefined {
    const workspace = getCurrentWorkspace();
    const key = conversationId === undefined ? undefined : workspaceCacheKey(conversationId);
    if (this.active >= this.limits.maxProcess || (this.workspaces.get(workspace) ?? 0) >= this.limits.maxWorkspace ||
        (key !== undefined && (this.conversations.get(key) ?? 0) >= this.limits.maxConversation)) { this.rejected++; return undefined; }
    this.active++;
    this.workspaces.set(workspace, (this.workspaces.get(workspace) ?? 0) + 1);
    if (key !== undefined) this.conversations.set(key, (this.conversations.get(key) ?? 0) + 1);
    let released = false;
    const decrement = (map: Map<string, number>, entry: string) => { const count = (map.get(entry) ?? 1) - 1; if (count) map.set(entry, count); else map.delete(entry); };
    return () => { if (released) return; released = true; this.active--; decrement(this.workspaces, workspace); if (key !== undefined) decrement(this.conversations, key); };
  }
  reserveReplay(): (() => void) | undefined {
    if (this.replayReads >= this.limits.maxReplayReads) return undefined;
    this.replayReads++;
    let released = false;
    return () => { if (!released) { released = true; this.replayReads--; } };
  }
  diagnostics() { return { active: this.active, replayReads: this.replayReads, workspaces: this.workspaces.size, conversations: this.conversations.size, rejected: this.rejected, limits: { ...this.limits } }; }
}
const globalAdmission = globalThis as typeof globalThis & { __flujoExecutionStreamAdmission?: ExecutionStreamAdmission };
export const executionStreamAdmission = globalAdmission.__flujoExecutionStreamAdmission ??= new ExecutionStreamAdmission();

export interface ExecutionStreamSession {
  readonly closed: boolean;
  send(event: ExecutionEvent, id: string | number, payload?: EventPayload): boolean;
  reset(reason: ExecutionStreamControl['reason']): void;
  close(): void;
  onCleanup(callback: () => void): void;
}

/** Byte queuing strategy, reserved control space and synchronous overflow teardown. */
export function createExecutionStream(
  signal: AbortSignal,
  release: () => void,
  control: () => Omit<ExecutionStreamControl, 'version' | 'reason' | 'recovery'>,
  setup: (session: ExecutionStreamSession) => void | Promise<void>,
  maxQueueBytes = EXECUTION_STREAM_LIMITS.maxQueueBytes,
): ReadableStream<Uint8Array> {
  if (maxQueueBytes <= CONTROL_RESERVE_BYTES) throw new Error('Invalid execution stream queue limit');
  const encoder = new TextEncoder();
  let closed = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const callbacks = new Set<() => void>();
  const cleanup = (cancelled = false) => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    signal.removeEventListener('abort', abort);
    for (const callback of callbacks) { try { callback(); } catch { /* still release other resources */ } }
    callbacks.clear();
    release();
    if (!cancelled) { try { controller.close(); } catch { /* reader already cancelled */ } }
  };
  const abort = () => cleanup();
  const reset = (reason: ExecutionStreamControl['reason']) => {
    if (closed) return;
    const frame = `event: ${EXECUTION_STREAM_CONTROL_EVENT}\ndata: ${JSON.stringify({ version: 1, reason, recovery: 'reload-snapshot', ...control() })}\n\n`;
    try {
      const bytes = encoder.encode(frame);
      if (bytes.byteLength <= CONTROL_RESERVE_BYTES && (controller.desiredSize ?? 0) >= bytes.byteLength) controller.enqueue(bytes);
    } finally { cleanup(); }
  };
  const enqueue = (frame: string, estimatedBytes: number): boolean => {
    if (closed) return false;
    if ((controller.desiredSize ?? 0) < estimatedBytes + CONTROL_RESERVE_BYTES) { reset('slow-consumer'); return false; }
    try { controller.enqueue(encoder.encode(frame)); return true; } catch { cleanup(); return false; }
  };
  const session: ExecutionStreamSession = {
    get closed() { return closed; },
    send(event, id, supplied) {
      if (closed) return false;
      const payload = supplied ?? snapshotEventPayload(event, MAX_EXECUTION_EVENT_WIRE_BYTES);
      if (!payload || payload.wireBytes > MAX_EXECUTION_EVENT_WIRE_BYTES) { reset('event-too-large'); return false; }
      const prefix = `id: ${id}\ndata: `;
      return enqueue(prefix + payload.json + '\n\n', Buffer.byteLength(prefix) + payload.wireBytes + 2);
    },
    reset, close: () => cleanup(),
    onCleanup(callback) { if (closed) callback(); else callbacks.add(callback); },
  };
  return new ReadableStream<Uint8Array>({
    async start(target) {
      controller = target;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { cleanup(); return; }
      enqueue('retry: 3000\n\n: connected\n\n', 32);
      try { await setup(session); } catch { cleanup(); }
      if (!closed) heartbeat = setInterval(() => enqueue(': ping\n\n', 8), 15000);
    },
    cancel() { cleanup(true); },
  }, { highWaterMark: maxQueueBytes, size: chunk => chunk.byteLength });
}

export const EXECUTION_SSE_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' };
export const executionStreamCapacityResponse = () => new Response('Execution stream capacity exhausted', { status: 503, headers: { 'Retry-After': '3' } });
