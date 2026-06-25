/**
 * Tests for the event-bus-driven OpenAI streaming response.
 *
 * createStreamingResponse used to poll http://localhost:4200/v1/chat/... once a
 * second and diff the assistant content. It now subscribes to the in-process
 * ExecutionEventBus instead. These tests drive the real bus and read the SSE
 * body to confirm:
 *   - an initial role chunk is emitted,
 *   - each assistant `message` event becomes one content chunk,
 *   - `run:done` terminates the stream with a finish chunk + [DONE],
 *   - and (importantly) no HTTP fetch is performed.
 *
 * FlowExecutor and runFlow are mocked so importing the service doesn't pull the
 * whole engine; the ExecutionEventBus is the real singleton.
 */
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { conversationStates: new Map() },
}));

jest.mock('@/backend/execution/flow/runFlow', () => ({
  runFlow: jest.fn(),
}));

import { createStreamingResponse } from '@/app/v1/chat/completions/chatCompletionService';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';

// Fail loudly if the implementation ever reaches back out over HTTP.
const fetchSpy = jest.spyOn(global, 'fetch' as any).mockImplementation(() => {
  throw new Error('fetch must not be called by the streaming response');
});

async function readAll(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

afterAll(() => {
  fetchSpy.mockRestore();
});

describe('createStreamingResponse (event-bus driven)', () => {
  it('streams the assistant content then [DONE], without polling HTTP', async () => {
    const convId = 'stream-conv-1';
    const res = createStreamingResponse('flow-Test', convId);

    // start() ran synchronously and subscribed; let any microtasks settle.
    await Promise.resolve();

    executionEventBus.emit(convId, { type: 'run:start', flowId: 'f1' } as any);
    executionEventBus.emit(convId, {
      type: 'message',
      message: { role: 'assistant', content: 'Hello world', id: 'a1', timestamp: 1 },
    } as any);
    executionEventBus.emit(convId, { type: 'run:done', status: 'completed' } as any);

    const body = await readAll(res);

    // Initial role chunk.
    expect(body).toContain('"role":"assistant"');
    // The assistant content arrived as a chunk.
    expect(body).toContain('Hello world');
    // Terminated correctly.
    expect(body).toContain('"finish_reason":"stop"');
    expect(body).toContain('data: [DONE]');
    // Never polled itself over HTTP.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('emits an error finish_reason when the run ends in error', async () => {
    const convId = 'stream-conv-2';
    const res = createStreamingResponse('flow-Test', convId);
    await Promise.resolve();

    executionEventBus.emit(convId, { type: 'run:done', status: 'error' } as any);

    const body = await readAll(res);
    expect(body).toContain('"finish_reason":"error"');
    expect(body).toContain('data: [DONE]');
  });
});
