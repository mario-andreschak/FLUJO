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
});

describe('global execution stream recovery and compatibility', () => {
  const request = (query = '', lastEventId?: string) => ({
    nextUrl: new URL('http://localhost/v1/chat/events' + query),
    headers: new Headers(lastEventId === undefined ? {} : { 'last-event-id': lastEventId }),
    signal: new AbortController().signal,
  }) as unknown as NextRequest;

  it('keeps default IDs numeric and uses the browser cursor ahead of the original query', async () => {
    const firstSeq = executionEventBus.currentGlobalSeq();
    executionEventBus.emit('numeric-cursor', { type: 'run:start', flowId: 'f' });
    executionEventBus.emit('numeric-cursor', { type: 'run:done', status: 'completed' });
    const response = await GET(request('?fromSeq=' + firstSeq, String(firstSeq)));
    const reader = response.body!.getReader();
    try {
      await reader.read(); // connected comment
      const frame = new TextDecoder().decode((await reader.read()).value);
      expect(frame).toContain('id: ' + (firstSeq + 1) + '\n');
      expect(frame).toContain('"type":"run:done"');
      expect(frame).not.toContain('flujo-stream-control');
    } finally { await reader.cancel(); }
  });

  it('uses epoch-bound IDs only when the caller opts in', async () => {
    const window = executionEventBus.globalReplayWindow();
    executionEventBus.emit('epoch-cursor', { type: 'run:start', flowId: 'f' });
    const response = await GET(request('?cursorVersion=1&fromSeq=' + window.epoch + ':' + window.nextSeq));
    const reader = response.body!.getReader();
    try {
      await reader.read();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('id: ' + window.epoch + ':' + window.nextSeq);
    } finally { await reader.cancel(); }
  });

  it.each(['bad:0', 'old-epoch:0', '-1', '9007199254740992'])('recovers an invalid versioned cursor %s without replaying execution events', async cursor => {
    const response = await GET(request('?cursorVersion=1&fromSeq=' + cursor));
    const body = await response.text();
    expect(body).toContain('event: flujo-stream-control');
    expect(body).toContain('"reason":"cursor-reset"');
    expect(body).not.toContain('"type":"run:');
  });

  it('recovers a byte-evicted prefix without trying to replay a partial suffix', async () => {
    const fromSeq = executionEventBus.currentGlobalSeq();
    for (let index = 0; index < 8; index++) executionEventBus.emit('evicted-global', {
      type: 'model:delta', messageId: 'draft', delta: 'x'.repeat(700 * 1024),
    });
    const response = await GET(request('?fromSeq=' + fromSeq));
    const body = await response.text();
    expect(body).toContain('"reason":"replay-gap"');
    expect(body).not.toContain('"messageId":"draft"');
  });

  it('rejects admission before constructing a stream and preserves exposure checks', async () => {
    const releases: Array<() => void> = [];
    while (true) { const release = executionStreamAdmission.reserve(); if (!release) break; releases.push(release); }
    try {
      const response = await GET(request());
      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('3');
      assertLocalRequestMock.mockReturnValueOnce(new Response('forbidden', { status: 403 }));
      expect((await GET(request())).status).toBe(403);
    } finally { releases.forEach(release => release()); }
  });
});
