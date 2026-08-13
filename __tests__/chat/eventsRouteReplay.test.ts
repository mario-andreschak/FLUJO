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
const assertLocalRequestMock = jest.fn((_request?: unknown, _options?: unknown): Response | null => null);
const loadConversationStateMock = jest.fn();
jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...a: unknown[]) => assertUnlockedMock(...(a as [])),
}));
jest.mock('@/utils/http/localRequest', () => ({
  assertLocalRequest: (...args: [unknown, unknown?]) => assertLocalRequestMock(...args),
}));
jest.mock('@/backend/execution/flow/loadConversationState', () => ({
  loadConversationState: (...args: unknown[]) => loadConversationStateMock(...args),
}));

import { GET } from '@/app/v1/chat/conversations/[conversationId]/events/route';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import {
  _setConversationLogDirForTests,
  flushConversationLog,
} from '@/backend/execution/flow/conversationLog';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

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

beforeEach(() => {
  assertLocalRequestMock.mockReset().mockReturnValue(null);
  loadConversationStateMock.mockReset().mockResolvedValue({ conversationId: 'legacy' });
});

describe('events route SSE replay across runs', () => {
  it('rejects a Persona event stream before replay or subscription', async () => {
    loadConversationStateMock.mockResolvedValueOnce({
      conversationId: 'persona-events',
      personaAttribution: {
        personaId: 'persona_1',
        activityId: 'activity_1',
        behaviorRevisionId: 'revision_1',
      },
    });
    assertLocalRequestMock.mockReturnValueOnce(new Response('forbidden', { status: 403 }));
    const abort = new AbortController();
    const request = makeRequest('persona-events', 0, abort.signal);

    const response = await GET(request, {
      params: Promise.resolve({ conversationId: 'persona-events' }),
    });

    expect(response.status).toBe(403);
    expect(assertLocalRequestMock).toHaveBeenCalledWith(request);
  });

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

/**
 * Durable JSONL fallback (issue #261): once the in-memory ring buffer is
 * evicted (channel GC 5 min after run:done, or a process restart), a reconnect
 * with a ?fromSeq cursor must still replay the persisted events from the
 * conversation log — seq is now authoritative and monotonic, so the cursor is
 * meaningful across runs/restarts and each event is delivered exactly once.
 */
describe('events route SSE replay from durable JSONL after buffer eviction', () => {
  let tmpDir: string;
  let prevDir: string;

  const registerPersistable = (conversationId: string) => {
    FlowExecutor.conversationStates.set(conversationId, {
      conversationId,
      messages: [],
      trackingInfo: { executionId: 'x', startTime: 1, nodeExecutionTracker: [] },
      flowId: 'f',
      title: 't',
      createdAt: 1,
      updatedAt: 1,
    } as never);
  };

  // Drop the in-memory channel + ring buffer for a conversation (simulates the
  // post-run:done channel GC / a process restart).
  const evictBuffer = (conversationId: string) => {
    (executionEventBus as unknown as { channels: Map<string, unknown> }).channels.delete(conversationId);
  };

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-events-replay-'));
    prevDir = _setConversationLogDirForTests(tmpDir);
  });

  afterAll(async () => {
    _setConversationLogDirForTests(prevDir);
    FlowExecutor.conversationStates.clear();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('replays a finished run from JSONL and closes on the terminal run:done', async () => {
    const conv = 'conv-events-jsonl-fallback';
    registerPersistable(conv);
    emit(conv, { type: 'run:start', flowId: 'f' }); // seq 0
    emit(conv, { type: 'message', message: { id: 'm1', role: 'assistant', content: 'hi' } }); // seq 1
    emit(conv, { type: 'run:done', status: 'completed' }); // seq 2
    await flushConversationLog(conv);

    evictBuffer(conv);

    const { reader, abort } = await openStream(conv, 0);
    try {
      const replay = await readEvents(reader, 3);
      expect(replay.events.map((e) => e.seq)).toEqual([0, 1, 2]);
      expect(replay.events.map((e) => e.type)).toEqual(['run:start', 'message', 'run:done']);
      // run:done is the latest persisted event → the stream terminates.
      expect(await readUntilClosed(reader)).toBe(true);
    } finally {
      abort.abort();
    }
  });

  it('resumes from a mid-run cursor via JSONL, skipping already-seen events', async () => {
    const conv = 'conv-events-jsonl-midcursor';
    registerPersistable(conv);
    emit(conv, { type: 'run:start', flowId: 'f' }); // seq 0
    emit(conv, { type: 'message', message: { id: 'm1', role: 'assistant', content: 'a' } }); // seq 1
    emit(conv, { type: 'message', message: { id: 'm2', role: 'assistant', content: 'b' } }); // seq 2
    emit(conv, { type: 'run:done', status: 'completed' }); // seq 3
    await flushConversationLog(conv);

    evictBuffer(conv);

    // Client already applied seq 0-1; resume at 2.
    const { reader, abort } = await openStream(conv, 2);
    try {
      const replay = await readEvents(reader, 2);
      expect(replay.events.map((e) => e.seq)).toEqual([2, 3]);
      expect(await readUntilClosed(reader)).toBe(true);
    } finally {
      abort.abort();
    }
  });

  it('serves a live run from JSONL replay + live tail with no duplicates', async () => {
    const conv = 'conv-events-jsonl-continue';
    registerPersistable(conv);
    // Run 1 finished and persisted.
    emit(conv, { type: 'run:start', flowId: 'f' }); // seq 0
    emit(conv, { type: 'message', message: { id: 'm1', role: 'assistant', content: 'old' } }); // seq 1
    emit(conv, { type: 'run:done', status: 'completed' }); // seq 2
    await flushConversationLog(conv);

    // Buffer evicted, THEN the conversation is continued with a live run 2.
    evictBuffer(conv);
    emit(conv, { type: 'run:start', flowId: 'f' }); // seq 3 (persisted + buffered live)
    emit(conv, { type: 'node:enter', node: { nodeId: 'n1' } }); // seq 4
    await flushConversationLog(conv);

    const { reader, abort } = await openStream(conv, 0);
    try {
      // JSONL fills [0,3), the live buffer covers [3,..]; clamped to the latest
      // run:start (seq 3) so the finished run 1 is not replayed.
      const replay = await readEvents(reader, 2);
      expect(replay.events.map((e) => e.seq)).toEqual([3, 4]);
      expect(replay.closed).toBe(false);

      // A live event on the current run arrives exactly once.
      emit(conv, { type: 'usage', totalTokens: 7 }); // seq 5
      const live = await readEvents(reader, 1);
      expect(live.events.map((e) => e.seq)).toEqual([5]);
    } finally {
      abort.abort();
    }
  });
});
