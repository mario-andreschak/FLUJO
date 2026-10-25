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

jest.mock('@/backend/execution/flow/persistConversationState', () => ({
  persistConversationState: jest.fn(async () => undefined),
}));

import { createStreamingResponse, processChatCompletion } from '@/app/v1/chat/completions/chatCompletionService';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { executionStreamAdmission } from '@/backend/execution/flow/engine/executionStream';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { runFlow } from '@/backend/execution/flow/runFlow';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import { acquireFlowRunAdmission, FlowRunPressureError, getFlowRunAdmissionDiagnostics } from '@/backend/execution/flow/runAdmission';
import type { ExecutionEvent } from '@/shared/types/execution/events';
import { promises as sequenceFs } from 'node:fs';
import sequencePath from 'node:path';
import sequenceOs from 'node:os';
import { _setConversationLogDirForTests } from '@/backend/execution/flow/conversationLog';
import { ConversationSequenceSafetyError } from '@/backend/execution/flow/conversationLogSequence';

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

describe('Conversation sequence refusal in completion responses', () => {
  let directory: string, previous: string;
  const request = { model: 'flow-Test', messages: [{ role: 'user', content: 'New request' }], stream: true };
  beforeEach(async () => {
    directory = await sequenceFs.mkdtemp(sequencePath.join(sequenceOs.tmpdir(), 'flujo-stream-sequence-'));
    previous = _setConversationLogDirForTests(directory);
    (persistConversationState as jest.Mock).mockClear();
  });
  afterEach(async () => {
    _setConversationLogDirForTests(previous);
    await sequenceFs.rm(directory, { recursive: true, force: true });
  });

  it('returns typed503 before opening a stream or submitting execution and preserves the paused owner', async () => {
    const id = 'stream-sequence-refused';
    const owner = { conversationId: id, status: 'paused_debug', logicalRunId: 'original-run', messages: [] } as any;
    FlowExecutor.conversationStates.set(id, owner);
    await sequenceFs.writeFile(sequencePath.join(directory, `${id}.jsonl`), '{"seq":1e309}\n');
    const subscribe = jest.spyOn(executionEventBus, 'subscribe');
    try {
      const response = await processChatCompletion(request as any, false, false, false, id);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: 'CONVERSATION_SEQUENCE_EXHAUSTED' } });
      expect(runFlow).not.toHaveBeenCalled();
      expect(subscribe).not.toHaveBeenCalled();
      expect(persistConversationState).not.toHaveBeenCalled();
      expect(FlowExecutor.conversationStates.get(id)).toBe(owner);
      expect(owner.status).toBe('paused_debug');
    } finally { subscribe.mockRestore(); }
  });

  it('reports late typed submission refusal in SSE without ending the existing owner', async () => {
    const id = 'stream-sequence-late';
    const owner = { conversationId: id, status: 'running', logicalRunId: 'original-run', messages: [] } as any;
    FlowExecutor.conversationStates.set(id, owner);
    (runFlow as jest.Mock).mockRejectedValue(new ConversationSequenceSafetyError('CONVERSATION_SEQUENCE_CHANGED', 'fixture snapshot race'));
    const response = await processChatCompletion(request as any, false, false, false, id);
    const body = await readAll(response);
    expect(body).toContain('CONVERSATION_SEQUENCE_CHANGED');
    expect(body).toContain('[DONE]');
    expect(FlowExecutor.conversationStates.get(id)).toBe(owner);
    expect(owner.status).toBe('running');
    expect(persistConversationState).not.toHaveBeenCalled();
    expect(getFlowRunAdmissionDiagnostics()).toMatchObject({ activeRuns: 0, reservedBytes: 0 });
  });

  it('maps nonstreaming typed refusal to its actionable status without a false short retry hint', async () => {
    (runFlow as jest.Mock).mockRejectedValue(new ConversationSequenceSafetyError('CONVERSATION_SEQUENCE_REGISTRY_FULL', 'fixture registry capacity'));
    const response = await processChatCompletion({ ...request, stream: false } as any, false, false, false, 'sequence-nonstream');
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBeNull();
    expect(await response.json()).toMatchObject({ error: { code: 'CONVERSATION_SEQUENCE_REGISTRY_FULL' } });
  });
});

describe('Flow submission pressure in completion responses', () => {
  const request = { model: 'flow-Test', messages: [{ role: 'user', content: 'New request' }], stream: true };
  const admissionVariables = [
    'FLUJO_RUN_ADMISSION_MAX_CONVERSATION_RUNS', 'FLUJO_RUN_ADMISSION_MAX_PROCESS_BYTES',
    'FLUJO_RUN_ADMISSION_MAX_RSS_BYTES',
  ];
  let previousEnvironment: Array<string | undefined>;
  const drained = () => expect(getFlowRunAdmissionDiagnostics()).toMatchObject({
    activeRuns: 0, reservedBytes: 0, activeWorkspaces: 0, workspaceConversations: 0,
  });

  beforeEach(() => {
    previousEnvironment = admissionVariables.map(name => process.env[name]);
    process.env.FLUJO_RUN_ADMISSION_MAX_CONVERSATION_RUNS = '1';
    process.env.FLUJO_RUN_ADMISSION_MAX_PROCESS_BYTES = String(128 * 1024 * 1024);
    process.env.FLUJO_RUN_ADMISSION_MAX_RSS_BYTES = String(Number.MAX_SAFE_INTEGER);
    (persistConversationState as jest.Mock).mockClear();
    drained();
  });
  afterEach(() => {
    admissionVariables.forEach((name, index) => {
      const value = previousEnvironment[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
    drained();
  });

  it.each([
    ['running', 'running'], ['paused', 'paused_debug'], ['approval', 'awaiting_tool_approval'], ['recovery', 'error'],
  ])('refuses overloaded %s submissions before reader setup and preserves the current owner', async (label, status) => {
    const conversationId = `completion-admission-${label}`;
    const state = { conversationId, status, messages: [{ id: 'original', role: 'user', content: 'Original history', timestamp: 1 }],
      pendingToolCalls: [{ id: 'owned-tool' }], recovery: { runId: 'original-run', effect: 'uncertain' } };
    const original = structuredClone(state);
    FlowExecutor.conversationStates.set(conversationId, state as never);
    const held = acquireFlowRunAdmission({ conversationId });
    const reserveReader = jest.spyOn(executionStreamAdmission, 'reserve');
    const subscribe = jest.spyOn(executionEventBus, 'subscribe');
    const emit = jest.spyOn(executionEventBus, 'emit');
    const before = executionStreamAdmission.diagnostics();
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await processChatCompletion(request as any, false, false, false, conversationId, false, true);
        expect(response.status).toBe(429);
        expect(response.headers.get('Retry-After')).toBe('5');
        await expect(response.json()).resolves.toMatchObject({ error: { code: 'FLOW_RUN_BUSY', retry_after: 5 } });
      }
      expect(runFlow).not.toHaveBeenCalled();
      expect(reserveReader).not.toHaveBeenCalled();
      expect(subscribe).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
      expect(persistConversationState).not.toHaveBeenCalled();
      expect(FlowExecutor.conversationStates.get(conversationId)).toBe(state);
      expect(state).toEqual(original);
      expect(executionStreamAdmission.diagnostics()).toEqual(before);
      expect(getFlowRunAdmissionDiagnostics().activeRuns).toBe(1);
    } finally { held.release(); reserveReader.mockRestore(); subscribe.mockRestore(); emit.mockRestore(); }
  });

  it('returns retryable memory pressure before reader reservation or background execution', async () => {
    process.env.FLUJO_RUN_ADMISSION_MAX_PROCESS_BYTES = '1';
    const reserveReader = jest.spyOn(executionStreamAdmission, 'reserve');
    try {
      const response = await processChatCompletion(request as any, false, false, false, 'completion-memory-pressure');
      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('5');
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'FLOW_RUN_MEMORY', retry_after: 5 } });
      expect(runFlow).not.toHaveBeenCalled();
      expect(reserveReader).not.toHaveBeenCalled();
      expect(persistConversationState).not.toHaveBeenCalled();
      drained();
    } finally { reserveReader.mockRestore(); }
  });

  it('keeps submitted execution charged when constructing its response throws', async () => {
    const conversationId = 'completion-submitted-response-failure';
    const before = executionStreamAdmission.diagnostics();
    const problem = new Error('response constructor failed after submission');
    let rejectRun!: (error: Error) => void;
    (runFlow as jest.Mock).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRun = reject; }));
    const responseConstructor = jest.spyOn(global, 'Response').mockImplementationOnce(() => { throw problem; });
    try {
      await expect(processChatCompletion(request as any, false, false, false, conversationId, false, true)).rejects.toBe(problem);
      responseConstructor.mockRestore();
      expect(runFlow).toHaveBeenCalledTimes(1);
      expect(executionStreamAdmission.diagnostics()).toMatchObject({ active: before.active, workspaces: before.workspaces, conversations: before.conversations });
      expect(getFlowRunAdmissionDiagnostics()).toMatchObject({ activeRuns: 1, workspaceConversations: 1 });
      expect(() => acquireFlowRunAdmission({ conversationId })).toThrow(expect.objectContaining({ code: 'FLOW_RUN_BUSY' }));
      rejectRun(new FlowRunPressureError('FLOW_RUN_MEMORY'));
      await new Promise<void>(resolve => setImmediate(resolve));
      drained();
      expect(persistConversationState).not.toHaveBeenCalled();
    } finally {
      responseConstructor.mockRestore();
      rejectRun?.(new FlowRunPressureError('FLOW_RUN_MEMORY'));
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  });

  it.each(['FLOW_RUN_BUSY', 'FLOW_RUN_MEMORY'] as const)('maps nonstreaming %s refusal without changing conversation ownership', async code => {
    const conversationId = `completion-nonstream-${code}`;
    const state = { conversationId, status: 'awaiting_tool_approval', messages: [], recovery: { runId: 'original-run' } };
    FlowExecutor.conversationStates.set(conversationId, state as never);
    (runFlow as jest.Mock).mockRejectedValueOnce(new FlowRunPressureError(code));
    const reserveReader = jest.spyOn(executionStreamAdmission, 'reserve');
    const emit = jest.spyOn(executionEventBus, 'emit');
    try {
      const response = await processChatCompletion({ ...request, stream: false } as any, false, false, false, conversationId);
      expect(response.status).toBe(code === 'FLOW_RUN_BUSY' ? 429 : 503);
      expect(response.headers.get('Retry-After')).toBe('5');
      await expect(response.json()).resolves.toMatchObject({ error: { code, retry_after: 5 } });
      expect(runFlow).toHaveBeenCalledTimes(1);
      expect(reserveReader).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
      expect(persistConversationState).not.toHaveBeenCalled();
      expect(FlowExecutor.conversationStates.get(conversationId)).toBe(state);
      expect(state.status).toBe('awaiting_tool_approval');
    } finally { reserveReader.mockRestore(); emit.mockRestore(); }
  });

  it.each(['FLOW_RUN_BUSY', 'FLOW_RUN_MEMORY'] as const)('settles a post-200 %s race only on the submitting stream', async code => {
    const conversationId = `completion-submission-race-${code}`;
    const state = { conversationId, status: 'paused_debug', messages: [{ id: 'retained', role: 'assistant', content: 'Original answer', timestamp: 1 }],
      recovery: { runId: 'original-run', effect: 'uncertain' } };
    const original = structuredClone(state);
    FlowExecutor.conversationStates.set(conversationId, state as never);
    const ownerListener = jest.fn();
    const stopOwnerListener = executionEventBus.subscribe(conversationId, ownerListener);
    const before = executionStreamAdmission.diagnostics();
    const sequence = executionEventBus.currentSeq(conversationId);
    let rejectSubmission!: (error: Error) => void;
    (runFlow as jest.Mock).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSubmission = reject; }));
    const emit = jest.spyOn(executionEventBus, 'emit');
    let response: Response | undefined;
    try {
      response = await processChatCompletion(request as any, false, false, false, conversationId, false, true);
      expect(response.status).toBe(200);
      expect(getFlowRunAdmissionDiagnostics().activeRuns).toBe(1);
      expect(executionStreamAdmission.diagnostics().active).toBe(before.active + 1);
      rejectSubmission(new FlowRunPressureError(code));
      const body = await readAll(response);
      expect(body).toContain(`"code":"${code}"`);
      expect(body).toContain('data: [DONE]');
      expect(body).not.toContain('"finish_reason":"error"');
      expect(FlowExecutor.conversationStates.get(conversationId)).toBe(state);
      expect(state).toEqual(original);
      expect(persistConversationState).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
      expect(ownerListener).not.toHaveBeenCalled();
      expect(executionEventBus.currentSeq(conversationId)).toBe(sequence);
      expect(executionStreamAdmission.diagnostics()).toMatchObject({ active: before.active, workspaces: before.workspaces, conversations: before.conversations });
      drained();
      const continuingEvent = executionEventBus.emit(conversationId, { type: 'model:delta', messageId: 'owner-answer', delta: 'Owner continues' });
      expect(ownerListener).toHaveBeenCalledWith(continuingEvent);
    } finally {
      rejectSubmission?.(new FlowRunPressureError(code));
      await response?.body?.cancel().catch(() => undefined);
      stopOwnerListener();
      emit.mockRestore();
    }
  });
});

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
