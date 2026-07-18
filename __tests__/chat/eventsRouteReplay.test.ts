/**
 * Tests for GET /v1/chat/conversations/[conversationId]/events (SSE replay).
 *
 * The event bus keeps ONE buffer per conversation across runs (the channel and
 * its monotonic seq survive a run:done as long as the conversation is
 * continued). Historically a replay from an early position (?fromSeq=0, used
 * by the live-view re-attach) therefore included a FINISHED earlier run's
 * events — and its run:done closed the stream before the current run's events
 * were ever delivered, feeding the client a stale terminal transition. The
 * frontend re-attach then looped: banner up, stale run:done, banner down,
 * status still 'running', re-attach again — the reported live-view flicker.
 *
 * The route now:
 *  - clamps replay to the latest run:start in the buffer (earlier runs are
 *    history, served by the conversation GET, not the live stream), and
 *  - only closes the stream on a run:done that is the channel's LATEST event.
 */
import type { NextRequest } from 'next/server';
import type { ExecutionEvent, RawExecutionEvent } from '@/shared/types/execution/events';

const assertUnlockedMock = jest.fn(async () => undefined);
jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...a: unknown[]) => assertUnlockedMock(...(a as [])),
}));

import { GET } from '@/app/v1/chat/conversations/[conversationId]/events/route';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';

const makeRequest = (
  conversationId: string,
  fromSeq: number | undefined,
  signal: AbortSignal
): NextRequest =>
  ({
    nextUrl: new URL(
      `http://localhost/v1/chat/conversations/${conversationId}/events` +
        (fromSeq !== undefined ? `?fromSeq=${fromSeq}` : '')
    ),
    headers: new Headers(),
    signal,
  }) as unknown as NextRequest;

const openStream = async (conversationId: string, fromSeq?: number) => {
  const abort = new AbortController();
  const res = await GET(makeRequest(conversationId, fromSeq, abort.signal), {
    params: Promise.resolve({ conversationId }),
  });
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  return { reader, abort };
};

/** reader.read() with a timeout that doesn't leave a live timer behind. */
const readWithTimeout = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number
): Promise<ReadableStreamReadResult<Uint8Array> | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Read SSE frames until `count` data events arrived, the stream closed, or the
 * timeout elapsed. Returns the parsed events and whether the stream closed.
 */
const readEvents = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number,
  timeoutMs = 2000
): Promise<{ events: ExecutionEvent[]; closed: boolean }> => {
  const decoder = new TextDecoder();
  const events: ExecutionEvent[] = [];
  let buffer = '';
  let closed = false;
  const deadline = Date.now() + timeoutMs;

  while (events.length < count && Date.now() < deadline) {
    const chunk = await readWithTimeout(reader, deadline - Date.now());
    if (chunk === null) break; // timed out waiting on read()
    if (chunk.done) {
      closed = true;
      break;
    }
    buffer += decoder.decode(chunk.value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of frame.split('\n')) {
        if (line.startsWith('data: ')) {
          events.push(JSON.parse(line.slice('data: '.length)) as ExecutionEvent);
        }
      }
    }
  }
  return { events, closed };
};

/** Drain until close (used to assert a stream DID terminate). */
const readUntilClosed = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 2000
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const chunk = await readWithTimeout(reader, deadline - Date.now());
    if (chunk === null) return false;
    if (chunk.done) return true;
  }
  return false;
};

const emit = (conversationId: string, raw: Record<string, unknown>): ExecutionEvent =>
  executionEventBus.emit(conversationId, raw as unknown as RawExecutionEvent);

describe('events route SSE replay across runs', () => {
  it('clamps a fromSeq=0 replay to the latest run and stays open for the live run', async () => {
    const conv = 'conv-events-replay-clamp';
    // Run 1: started, produced a message, and FINISHED (errored/stopped).
    emit(conv, { type: 'run:start', flowId: 'f1' }); // seq 0
    emit(conv, { type: 'message', message: { id: 'm1', role: 'assistant', content: 'old' } }); // seq 1
    emit(conv, { type: 'run:done', status: 'error' }); // seq 2
    // Run 2 (the conversation was continued): live, NOT done.
    emit(conv, { type: 'run:start', flowId: 'f1' }); // seq 3
    emit(conv, { type: 'node:enter', node: { nodeId: 'n1' } }); // seq 4

    const { reader, abort } = await openStream(conv, 0);
    try {
      const replay = await readEvents(reader, 2);
      // Nothing from the finished run 1 — replay starts at run 2's run:start.
      expect(replay.events.map((e) => e.seq)).toEqual([3, 4]);
      expect(replay.events[0].type).toBe('run:start');
      expect(replay.closed).toBe(false);

      // The stream is live: a new event on the current run arrives...
      emit(conv, { type: 'usage', totalTokens: 5 }); // seq 5
      const live = await readEvents(reader, 1);
      expect(live.events.map((e) => e.seq)).toEqual([5]);

      // ...and the CURRENT run's run:done (the channel's latest event) closes it.
      emit(conv, { type: 'run:done', status: 'completed' }); // seq 6
      const done = await readEvents(reader, 1);
      expect(done.events.map((e) => e.type)).toEqual(['run:done']);
      expect(await readUntilClosed(reader)).toBe(true);
    } finally {
      abort.abort();
    }
  });

  it('still closes when the replayed run:done is the latest event (conversation truly finished)', async () => {
    const conv = 'conv-events-replay-terminal';
    emit(conv, { type: 'run:start', flowId: 'f1' }); // seq 0
    emit(conv, { type: 'message', message: { id: 'm1', role: 'assistant', content: 'x' } }); // seq 1
    emit(conv, { type: 'run:done', status: 'completed' }); // seq 2

    const { reader, abort } = await openStream(conv, 0);
    try {
      const replay = await readEvents(reader, 3);
      expect(replay.events.map((e) => e.seq)).toEqual([0, 1, 2]);
      expect(replay.events[2].type).toBe('run:done');
      expect(await readUntilClosed(reader)).toBe(true);
    } finally {
      abort.abort();
    }
  });

  it('replays from fromSeq unchanged on a mid-run reconnect (no run:start after it)', async () => {
    const conv = 'conv-events-replay-midrun';
    emit(conv, { type: 'run:start', flowId: 'f1' }); // seq 0
    emit(conv, { type: 'node:enter', node: { nodeId: 'n1' } }); // seq 1
    emit(conv, { type: 'usage', totalTokens: 1 }); // seq 2
    emit(conv, { type: 'usage', totalTokens: 2 }); // seq 3

    // Reconnect that already saw seq 0-1 (Last-Event-ID style position).
    const { reader, abort } = await openStream(conv, 2);
    try {
      const replay = await readEvents(reader, 2);
      expect(replay.events.map((e) => e.seq)).toEqual([2, 3]);
      expect(replay.closed).toBe(false);
    } finally {
      abort.abort();
    }
  });
});
