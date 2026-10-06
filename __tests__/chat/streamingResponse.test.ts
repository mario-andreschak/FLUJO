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
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import type { ExecutionEvent } from '@/shared/types/execution/events';

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
afterEach(() => { FlowExecutor.conversationStates.clear(); });

const contentDeltas = (body: string): string => body.split('\n').filter(line => line.startsWith('data: {'))
  .map(line => JSON.parse(line.slice(6)).choices[0].delta.content ?? '').join('');

describe('createStreamingResponse (event-bus driven)', () => {
  it('recovers a fast oversized result from the canonical current turn without emitting FLUJO controls', async () => {
    const id = 'fast-oversized-stream';
    const answer = { id: 'answer', role: 'assistant' as const, content: 'x'.repeat(4 * 1024 * 1024 + 1), timestamp: 3 };
    FlowExecutor.conversationStates.set(id, { conversationId: id, status: 'completed', ephemeral: true, messages: [
      { id: 'earlier', role: 'assistant', content: 'Earlier answer', timestamp: 1 },
      { id: 'user', role: 'user', content: 'Current request', timestamp: 2 }, answer,
    ] } as never);
    executionEventBus.emit(id, { type: 'run:start', flowId: 'f' });
    executionEventBus.emit(id, { type: 'message', message: answer });
    executionEventBus.emit(id, { type: 'run:done', status: 'completed' });
    expect(executionEventBus.replayWindow(id).firstSeq).toBe(2);
    const body = await readAll(createStreamingResponse('flow-Test', id));
    expect(contentDeltas(body)).toBe(answer.content);
    expect(body).not.toContain('event: flujo-stream-control');
    expect(body).toContain('data: [DONE]');
  });

  it('uses a full final message after a mid-message replay gap rather than delivering a partial suffix', async () => {
    const id = 'mid-message-gap';
    executionEventBus.emit(id, { type: 'run:start', flowId: 'f' });
    for (let index = 0; index < 1005; index++) executionEventBus.emit(id, {
      type: 'model:delta', messageId: 'answer', delta: 'cached suffix',
    });
    const response = createStreamingResponse('flow-Test', id);
    executionEventBus.emit(id, { type: 'model:delta', messageId: 'answer', delta: 'live suffix' });
    executionEventBus.emit(id, { type: 'message', message: { id: 'answer', role: 'assistant', content: 'Full current answer', timestamp: 1 } });
    executionEventBus.emit(id, { type: 'run:done', status: 'completed' });
    expect(contentDeltas(await readAll(response))).toBe('Full current answer');
  });

  it('keeps native text deltas deduplicated when replay is complete', async () => {
    const id = 'complete-native-delta';
    const response = createStreamingResponse('flow-Test', id);
    executionEventBus.emit(id, { type: 'model:delta', messageId: 'answer', delta: 'Hello ' });
    executionEventBus.emit(id, { type: 'model:delta', messageId: 'answer', delta: 'world' });
    executionEventBus.emit(id, { type: 'message', message: { id: 'answer', role: 'assistant', content: 'Hello world', timestamp: 1 } });
    executionEventBus.emit(id, { type: 'run:done', status: 'completed' });
    expect(contentDeltas(await readAll(response))).toBe('Hello world');
  });

  it('does not terminate or replay earlier messages from a finished run before a resumed run', async () => {
    const id = 'continued-openai-stream';
    executionEventBus.emit(id, { type: 'run:start', flowId: 'f' });
    executionEventBus.emit(id, { type: 'message', message: { id: 'old', role: 'assistant', content: 'Old answer', timestamp: 1 } });
    executionEventBus.emit(id, { type: 'run:done', status: 'completed' });
    executionEventBus.emit(id, { type: 'run:start', flowId: 'f' });
    const response = createStreamingResponse('flow-Test', id);
    executionEventBus.emit(id, { type: 'message', message: { id: 'new', role: 'assistant', content: 'New answer', timestamp: 2 } });
    executionEventBus.emit(id, { type: 'run:done', status: 'completed' });
    expect(contentDeltas(await readAll(response))).toBe('New answer');
  });

  it('unsubscribes on body cancellation and ignores later events', async () => {
    const release = jest.fn();
    let listener!: (event: ExecutionEvent) => void;
    const subscribe = jest.spyOn(executionEventBus, 'subscribe').mockImplementationOnce((_id, callback) => {
      listener = callback; return release;
    });
    try {
      const response = createStreamingResponse('flow-Test', 'cancel-openai-stream');
      await response.body!.cancel();
      expect(release).toHaveBeenCalledTimes(1);
      expect(() => listener({ type: 'run:done', status: 'completed', seq: 0, conversationId: 'cancel-openai-stream', timestamp: 1 })).not.toThrow();
    } finally { subscribe.mockRestore(); }
  });
  it('uses the supplied resume boundary to avoid resending an earlier assistant from the same user turn', async () => {
    const id = 'resume-snapshot-boundary';
    FlowExecutor.conversationStates.set(id, { conversationId: id, status: 'completed', ephemeral: true, messages: [
      { id: 'user', role: 'user', content: 'Original request', timestamp: 1 },
      { id: 'earlier', role: 'assistant', content: 'Already streamed before pause', timestamp: 2 },
      { id: 'resumed', role: 'assistant', content: 'Resumed answer', timestamp: 3 },
    ] } as never);
    executionEventBus.emit(id, { type: 'model:delta', messageId: 'resumed', delta: 'x'.repeat(4 * 1024 * 1024 + 1) });
    executionEventBus.emit(id, { type: 'run:done', status: 'completed' });
    expect(contentDeltas(await readAll(createStreamingResponse('flow-Test', id, 2)))).toBe('Resumed answer');
  });
  it('waits for a newly dispatched run rather than replaying and closing on the prior terminal run', async () => {
    const id = 'new-request-cursor';
    executionEventBus.emit(id, { type: 'run:start', flowId: 'f' });
    executionEventBus.emit(id, { type: 'message', message: { id: 'old', role: 'assistant', content: 'Prior result', timestamp: 1 } });
    executionEventBus.emit(id, { type: 'run:done', status: 'completed' });
    FlowExecutor.conversationStates.set(id, { conversationId: id, status: 'completed', messages: [], ephemeral: true } as never);
    const fromSeq = executionEventBus.currentSeq(id);
    const response = createStreamingResponse('flow-Test', id, 0, fromSeq);
    executionEventBus.emit(id, { type: 'run:start', flowId: 'f' });
    executionEventBus.emit(id, { type: 'model:delta', messageId: 'new', delta: 'Current result' });
    executionEventBus.emit(id, { type: 'message', message: { id: 'new', role: 'assistant', content: 'Current result', timestamp: 2 } });
    executionEventBus.emit(id, { type: 'run:done', status: 'completed' });
    expect(contentDeltas(await readAll(response))).toBe('Current result');
  });
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
