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

import { createStreamingResponse, processChatCompletion } from '@/app/v1/chat/completions/chatCompletionService';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { executionStreamAdmission } from '@/backend/execution/flow/engine/executionStream';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { runFlow } from '@/backend/execution/flow/runFlow';
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
beforeEach(() => { (runFlow as jest.Mock).mockReset(); });

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
    const releasePin = jest.fn();
    let listener!: (event: ExecutionEvent) => void;
    const subscribe = jest.spyOn(executionEventBus, 'subscribe').mockImplementationOnce(() => releasePin)
      .mockImplementationOnce((_id, callback) => {
        listener = callback; return release;
      });
    try {
      const response = createStreamingResponse('flow-Test', 'cancel-openai-stream');
      expect(releasePin).toHaveBeenCalledTimes(1);
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

describe('completion reader admission and cleanup', () => {
  const request = { model: 'flow-Test', messages: [{ role: 'user', content: 'Current request' }], stream: true };

  it('rejects repeated capacity requests before invoking a Flow and admits once after capacity is freed', async () => {
    const id = 'completion-reader-full';
    const before = executionStreamAdmission.diagnostics();
    const held = Array.from({ length: 4 }, () => executionStreamAdmission.reserve(id)!);
    let response: Response | undefined;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const rejected = await processChatCompletion(request as any, false, false, false, id, false, true);
        expect(rejected.status).toBe(503);
        expect(rejected.headers.get('Retry-After')).toBe('3');
        await expect(rejected.json()).resolves.toMatchObject({ error: { type: 'api_error' } });
      }
      expect(runFlow).not.toHaveBeenCalled();
      expect(executionStreamAdmission.diagnostics().active).toBe(before.active + 4);
      held.forEach(release => release());
      (runFlow as jest.Mock).mockResolvedValue({ flowNotFound: { name: 'Test' } });
      response = await processChatCompletion(request as any, false, false, false, id, false, true);
      expect(response.status).toBe(200);
      expect(runFlow).toHaveBeenCalledTimes(1);
      expect(executionStreamAdmission.diagnostics().active).toBe(before.active + 1);
    } finally {
      held.forEach(release => release());
      await response?.body?.cancel();
    }
    expect(executionStreamAdmission.diagnostics()).toMatchObject({ active: before.active, workspaces: before.workspaces, conversations: before.conversations });
  });

  it('releases each partial admission when repeated projection rejection prevents dispatch', async () => {
    const before = executionStreamAdmission.diagnostics();
    const reserve = executionStreamAdmission.reserve.bind(executionStreamAdmission);
    const releaseReader = jest.fn();
    const permits = jest.spyOn(executionStreamAdmission, 'reserve').mockImplementation(id => {
      const release = reserve(id)!;
      return () => { releaseReader(); release(); };
    });
    const projection = jest.spyOn(executionEventBus, 'ensureConversationProjection').mockReturnValue(false);
    const subscribe = jest.spyOn(executionEventBus, 'subscribe');
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await processChatCompletion(request as any, false, false, false, 'completion-projection-full', false, true);
        expect(response.status).toBe(503);
        expect(response.headers.get('Retry-After')).toBe('3');
      }
      expect(runFlow).not.toHaveBeenCalled();
      expect(subscribe).not.toHaveBeenCalled();
      expect(releaseReader).toHaveBeenCalledTimes(2);
      expect(executionStreamAdmission.diagnostics()).toMatchObject({ active: before.active, workspaces: before.workspaces, conversations: before.conversations });
    } finally { subscribe.mockRestore(); projection.mockRestore(); permits.mockRestore(); }
  });

  it('releases the reader and leaves execution untouched when acquiring the inert pin throws', async () => {
    const before = executionStreamAdmission.diagnostics();
    const problem = new Error('pin setup failed');
    const subscribe = jest.spyOn(executionEventBus, 'subscribe').mockImplementationOnce(() => { throw problem; });
    try {
      await expect(processChatCompletion(request as any, false, false, false, 'completion-pin-failure', false, true)).rejects.toBe(problem);
      expect(runFlow).not.toHaveBeenCalled();
      expect(executionStreamAdmission.diagnostics()).toMatchObject({ active: before.active, workspaces: before.workspaces, conversations: before.conversations });
    } finally { subscribe.mockRestore(); }
  });

  it('releases the pin and permit when setting up the real listener fails', async () => {
    const before = executionStreamAdmission.diagnostics();
    const problem = new Error('listener setup failed');
    const releasePin = jest.fn();
    const subscribe = jest.spyOn(executionEventBus, 'subscribe').mockImplementationOnce(() => releasePin)
      .mockImplementationOnce(() => { throw problem; });
    try {
      const response = createStreamingResponse('flow-Test', 'completion-listener-failure');
      await expect(readAll(response)).rejects.toBe(problem);
      expect(releasePin).toHaveBeenCalledTimes(1);
      expect(executionStreamAdmission.diagnostics()).toMatchObject({ active: before.active, workspaces: before.workspaces, conversations: before.conversations });
    } finally { subscribe.mockRestore(); }
  });

  it('errors the body and releases ownership when serializing a live chunk fails', async () => {
    const before = executionStreamAdmission.diagnostics();
    const releasePin = jest.fn();
    const releaseListener = jest.fn();
    let listener!: (event: ExecutionEvent) => void;
    const subscribe = jest.spyOn(executionEventBus, 'subscribe').mockImplementationOnce(() => releasePin)
      .mockImplementationOnce((_id, callback) => { listener = callback; return releaseListener; });
    try {
      const response = createStreamingResponse('flow-Test', 'completion-send-failure');
      const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
      listener({ type: 'model:delta', messageId: 'answer', delta: '', mediaPart: cyclic, seq: 0, conversationId: 'completion-send-failure', timestamp: 1 } as any);
      await expect(readAll(response)).rejects.toThrow();
      expect(releasePin).toHaveBeenCalledTimes(1);
      expect(releaseListener).toHaveBeenCalledTimes(1);
      expect(executionStreamAdmission.diagnostics()).toMatchObject({ active: before.active, workspaces: before.workspaces, conversations: before.conversations });
      listener({ type: 'run:done', status: 'completed', seq: 1, conversationId: 'completion-send-failure', timestamp: 2 });
      expect(releaseListener).toHaveBeenCalledTimes(1);
    } finally { subscribe.mockRestore(); }
  });

  it('releases the reader even when the final canonical conversation cannot be serialized', async () => {
    const id = 'completion-final-send-failure';
    const before = executionStreamAdmission.diagnostics();
    const state = { conversationId: id, status: 'running', ephemeral: true, messages: [] } as any;
    state.cycle = state;
    FlowExecutor.conversationStates.set(id, state);
    const response = createStreamingResponse('flow-Test', id);
    executionEventBus.emit(id, { type: 'run:done', status: 'completed' });
    await expect(readAll(response)).rejects.toThrow();
    expect(executionStreamAdmission.diagnostics()).toMatchObject({ active: before.active, workspaces: before.workspaces, conversations: before.conversations });
  });

  it('releases ownership when constructing the response throws after listener activation', () => {
    const before = executionStreamAdmission.diagnostics();
    const problem = new Error('response construction failed');
    const response = jest.spyOn(global, 'Response').mockImplementationOnce(() => { throw problem; });
    try {
      expect(() => createStreamingResponse('flow-Test', 'completion-response-failure')).toThrow(problem);
      expect(executionStreamAdmission.diagnostics()).toMatchObject({ active: before.active, workspaces: before.workspaces, conversations: before.conversations });
    } finally { response.mockRestore(); }
  });

  it('keeps non-streaming Flow requests outside reader admission', async () => {
    const permits = jest.spyOn(executionStreamAdmission, 'reserve').mockImplementation(() => { throw new Error('must not reserve'); });
    (runFlow as jest.Mock).mockResolvedValue({ flowNotFound: { name: 'Test' } });
    try {
      const response = await processChatCompletion({ ...request, stream: false } as any, false, false, false, 'completion-nonstream');
      expect(response.status).toBe(400);
      expect(runFlow).toHaveBeenCalledTimes(1);
      expect(permits).not.toHaveBeenCalled();
    } finally { permits.mockRestore(); }
  });

  it.each(['run:done', 'run:paused', 'run:awaiting_approval'])('releases the reader once when %s terminates the stream', async type => {
    const id = 'completion-terminal-' + type;
    const before = executionStreamAdmission.diagnostics();
    const reserve = executionStreamAdmission.reserve.bind(executionStreamAdmission);
    const releaseReader = jest.fn();
    const permits = jest.spyOn(executionStreamAdmission, 'reserve').mockImplementation(conversation => {
      const release = reserve(conversation)!;
      return () => { releaseReader(); release(); };
    });
    try {
      const response = createStreamingResponse('flow-Test', id);
      if (type === 'run:done') executionEventBus.emit(id, { type: 'run:done', status: 'completed' });
      else if (type === 'run:paused') executionEventBus.emit(id, { type: 'run:paused', reason: 'debug' });
      else executionEventBus.emit(id, { type: 'run:awaiting_approval', pendingToolCalls: [] });
      expect(await readAll(response)).toContain('data: [DONE]');
      expect(permits).toHaveBeenCalledTimes(1);
      expect(releaseReader).toHaveBeenCalledTimes(1);
      expect(executionStreamAdmission.diagnostics()).toMatchObject({ active: before.active, workspaces: before.workspaces, conversations: before.conversations });
    } finally { permits.mockRestore(); }
  });
});
