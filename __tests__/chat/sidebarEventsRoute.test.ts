import type { NextRequest } from 'next/server';
import type { ExecutionEvent, RawExecutionEvent } from '@/shared/types/execution/events';

const assertLocalRequestMock = jest.fn((_request?: unknown, _options?: unknown): Response | null => null);
jest.mock('@/utils/http/localRequest', () => ({
  assertLocalRequest: (...args: [unknown, unknown?]) => assertLocalRequestMock(...args),
}));

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: jest.fn(async () => undefined),
}));

import { GET } from '@/app/v1/chat/events/route';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { executionStreamAdmission } from '@/backend/execution/flow/engine/executionStream';

const readDataEvent = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ExecutionEvent> => {
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + 2_000;

  while (Date.now() < deadline) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 100);
      }),
    ]);
    clearTimeout(timer);
    if (!chunk) continue;
    if (chunk.done) throw new Error('Sidebar event stream closed unexpectedly');
    buffer += decoder.decode(chunk.value, { stream: true });
    const match = buffer.match(/(?:^|\n)data: (.+)\n/);
    if (match) return JSON.parse(match[1]) as ExecutionEvent;
  }

  throw new Error('Timed out waiting for a sidebar lifecycle event');
};

describe('global sidebar lifecycle event stream', () => {
  beforeEach(() => {
    assertLocalRequestMock.mockReset().mockReturnValue(null);
  });

  it('filters high-volume execution events before sending lifecycle changes', async () => {
    const abort = new AbortController();
    const request = {
      nextUrl: new URL('http://localhost/v1/chat/events?scope=sidebar'),
      headers: new Headers(),
      signal: abort.signal,
    } as unknown as NextRequest;
    const response = await GET(request);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const conversationId = 'sidebar-events-filter';

    try {
      executionEventBus.emit(conversationId, {
        type: 'model:delta',
        delta: 'token',
      } as RawExecutionEvent);
      executionEventBus.emit(conversationId, {
        type: 'run:done',
        status: 'completed',
      } as RawExecutionEvent);

      const event = await readDataEvent(reader);
      expect(event).toMatchObject({
        type: 'run:done',
        conversationId,
        status: 'completed',
      });
    } finally {
      abort.abort();
      await reader.cancel();
    }
  });

  it('rejects callers outside the selected exposure policy', async () => {
    assertLocalRequestMock.mockReturnValueOnce(new Response('forbidden', { status: 403 }));
    const request = {
      nextUrl: new URL('https://flujo.example.com/v1/chat/events?scope=sidebar'),
      headers: new Headers(),
      signal: new AbortController().signal,
    } as unknown as NextRequest;

    const response = await GET(request);

    expect(response.status).toBe(403);
    expect(assertLocalRequestMock).toHaveBeenCalledWith(request);
  });

  it('rejects a legacy or stale global cursor with snapshot recovery', async () => {
    // Keep the numeric cursor within the current window: epoch validation,
    // rather than a coincidental future/gap check, must reject these readers.
    executionEventBus.emit('epoch-fixture', { type: 'usage', totalTokens: 1 } as RawExecutionEvent);
    executionEventBus.emit('epoch-fixture', { type: 'usage', totalTokens: 2 } as RawExecutionEvent);
    for (const cursor of ['0', 'old-epoch:0']) {
      const abort = new AbortController();
      const request = { nextUrl: new URL('http://localhost/v1/chat/events?fromSeq=0'), headers: new Headers({ 'last-event-id': cursor }), signal: abort.signal } as unknown as NextRequest;
      const response = await GET(request);
      const reader = response.body!.getReader();
      try {
        expect(await readDataEvent(reader)).toMatchObject({ reason: 'cursor-reset', recovery: 'reload-snapshot', epoch: executionEventBus.globalReplayWindow().epoch });
        expect((await reader.read()).done).toBe(true);
      } finally { abort.abort(); await reader.cancel(); }
    }
  });

  it('prefers the epoch-bound Last-Event-ID over an earlier explicit cursor', async () => {
    const conversationId = 'global-cursor-precedence';
    executionEventBus.emit(conversationId, { type: 'usage', totalTokens: 1 } as RawExecutionEvent);
    const window = executionEventBus.globalReplayWindow();
    executionEventBus.emit(conversationId, { type: 'usage', totalTokens: 2 } as RawExecutionEvent);
    const abort = new AbortController();
    const request = { nextUrl: new URL(`http://localhost/v1/chat/events?fromSeq=0&epoch=${window.epoch}`), headers: new Headers({ 'last-event-id': `${window.epoch}:${window.nextSeq - 1}` }), signal: abort.signal } as unknown as NextRequest;
    const response = await GET(request); const reader = response.body!.getReader();
    try { expect(await readDataEvent(reader)).toMatchObject({ type: 'usage', totalTokens: 2 }); }
    finally { abort.abort(); await reader.cancel(); }
  });

  it('reports a retained global gap instead of silently skipping oversized activity', async () => {
    const window = executionEventBus.globalReplayWindow();
    executionEventBus.emit('global-gap', { type: 'model:delta', messageId: 'large', delta: 'x'.repeat(300000) });
    const abort = new AbortController();
    const request = { nextUrl: new URL(`http://localhost/v1/chat/events?fromSeq=${window.nextSeq}&epoch=${window.epoch}`), headers: new Headers(), signal: abort.signal } as unknown as NextRequest;
    const response = await GET(request); const reader = response.body!.getReader();
    try { expect(await readDataEvent(reader)).toMatchObject({ reason: 'replay-gap' }); }
    finally { abort.abort(); await reader.cancel(); }
  });

  it('bounds a non-reading live HTTP consumer and releases the subscription', async () => {
    const before = executionStreamAdmission.diagnostics().active;
    const abort = new AbortController();
    const request = { nextUrl: new URL('http://localhost/v1/chat/events'), headers: new Headers(), signal: abort.signal } as unknown as NextRequest;
    const response = await GET(request);
    for (let seq = 0; seq < 12; seq++) executionEventBus.emit('http-slow-reader', { type: 'model:delta', messageId: 'draft', delta: 'x'.repeat(200000) });
    expect(executionStreamAdmission.diagnostics().active).toBe(before);
    const reader = response.body!.getReader();
    let text = ''; let bytes = 0;
    try {
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; text += new TextDecoder().decode(chunk.value); }
      expect(bytes).toBeLessThanOrEqual(1024 * 1024);
      expect(text).toContain('"reason":"slow-consumer"');
    } finally { abort.abort(); await reader.cancel(); }
  });

  it('returns retryable overload before adding a seventeenth workspace subscription', async () => {
    const aborts: AbortController[] = [];
    const responses: Response[] = [];
    try {
      for (let index = 0; index < 16; index++) {
        const abort = new AbortController(); aborts.push(abort);
        responses.push(await GET({ nextUrl: new URL('http://localhost/v1/chat/events'), headers: new Headers(), signal: abort.signal } as unknown as NextRequest));
      }
      const rejected = await GET({ nextUrl: new URL('http://localhost/v1/chat/events'), headers: new Headers(), signal: new AbortController().signal } as unknown as NextRequest);
      expect(rejected.status).toBe(503);
      expect(rejected.headers.get('retry-after')).toBe('3');
      expect(executionStreamAdmission.diagnostics().active).toBe(16);
    } finally {
      for (const abort of aborts) abort.abort();
      for (const response of responses) await response.body?.cancel();
    }
    expect(executionStreamAdmission.diagnostics().active).toBe(0);
  });
});
