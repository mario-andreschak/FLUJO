import type { NextRequest } from 'next/server';
import type { ExecutionEvent, RawExecutionEvent } from '@/shared/types/execution/events';

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: jest.fn(async () => undefined),
}));

import { GET } from '@/app/v1/chat/events/route';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';

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
});
