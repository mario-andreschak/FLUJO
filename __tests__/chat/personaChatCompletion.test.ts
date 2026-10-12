import { NextRequest } from 'next/server';

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    verbose: jest.fn(),
  }),
}));

jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { conversationStates: new Map() },
}));

jest.mock('@/backend/execution/flow/runFlow', () => ({
  runFlow: jest.fn(),
}));

jest.mock('@/backend/services/model', () => ({
  modelService: { generateChatCompletion: jest.fn() },
}));

jest.mock('@/backend/services/enduringAgents/personaDispatcher', () => {
  class PersonaFlowDispatchTimeoutError extends Error {
    readonly code = 'PERSONA_FLOW_DISPATCH_TIMEOUT';

    constructor(readonly dispatchId: string) {
      super(`Timed out waiting for ${dispatchId}`);
    }
  }
  return {
    PersonaFlowDispatchTimeoutError,
    submitPersonaFlowDispatch: jest.fn(),
    waitForPersonaFlowDispatch: jest.fn(),
    getPersonaFlowDispatch: jest.fn(),
  };
});

import {
  InvalidPersonaChatMetadataError,
  parseRequestParameters,
} from '@/app/v1/chat/completions/requestParser';
import { processChatCompletion } from '@/app/v1/chat/completions/chatCompletionService';
import { runFlow } from '@/backend/execution/flow/runFlow';
import { executionEventBus, CONVERSATION_REPLAY_LIMITS } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { executionStreamAdmission } from '@/backend/execution/flow/engine/executionStream';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import {
  getPersonaFlowDispatch,
  PersonaFlowDispatchTimeoutError,
  submitPersonaFlowDispatch,
  waitForPersonaFlowDispatch,
} from '@/backend/services/enduringAgents/personaDispatcher';
import { modelService } from '@/backend/services/model';

const submitDispatchMock = submitPersonaFlowDispatch as jest.Mock;
const waitDispatchMock = waitForPersonaFlowDispatch as jest.Mock;
const getDispatchMock = getPersonaFlowDispatch as jest.Mock;
const runFlowMock = runFlow as jest.Mock;
const modelCompletionMock = modelService.generateChatCompletion as jest.Mock;

function postRequest(metadata: Record<string, unknown>) {
  return new NextRequest('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'flow-support',
      messages: [{ role: 'user', content: 'Help me' }],
      metadata,
    }),
  });
}

function dispatchRecord(state: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'dispatch-chat-1',
    workspaceId: 'default',
    personaId: 'persona_support',
    state,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

async function readAll(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let output = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return output;
    output += decoder.decode(value, { stream: true });
  }
}

beforeEach(() => {
  submitDispatchMock.mockReset();
  waitDispatchMock.mockReset();
  getDispatchMock.mockReset();
  runFlowMock.mockReset();
  modelCompletionMock.mockReset();
});

afterEach(() => { FlowExecutor.conversationStates.clear(); });

describe('Persona chat metadata parsing', () => {
  it('extracts and validates trusted Persona routing metadata', async () => {
    const parsed = await parseRequestParameters(postRequest({
      personaId: 'persona_support',
      behaviorSlotKey: 'support_chat',
      idempotencyKey: 'client-retry-1',
    }));

    expect(parsed.personaTarget).toEqual({
      personaId: 'persona_support',
      behaviorSlotKey: 'support_chat',
      idempotencyKey: 'client-retry-1',
    });
    expect(parsed).not.toHaveProperty('metadata');
  });

  it('rejects Persona companion fields without a Persona id', async () => {
    await expect(parseRequestParameters(postRequest({
      behaviorSlotKey: 'support_chat',
    }))).rejects.toBeInstanceOf(InvalidPersonaChatMetadataError);
  });

  it('rejects unsafe Persona ids at the request boundary', async () => {
    await expect(parseRequestParameters(postRequest({
      personaId: '../another-workspace',
    }))).rejects.toMatchObject({ code: 'invalid_persona_metadata' });
  });

  it('does not accept the internal parsed Persona target as a top-level wire field', async () => {
    const request = new NextRequest('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'flow-support',
        messages: [{ role: 'user', content: 'Help me' }],
        personaTarget: { personaId: 'persona_support' },
      }),
    });

    await expect(parseRequestParameters(request)).rejects.toMatchObject({
      code: 'invalid_persona_metadata',
    });
  });
});

describe('Persona chat completion dispatch', () => {
  it('submits a non-streaming Flow to the durable Persona dispatcher and maps its outcome', async () => {
    const queued = dispatchRecord('queued');
    const completed = dispatchRecord('completed', {
      completedAt: 2,
      outcome: {
        status: 'completed',
        conversationId: 'conversation_1',
        outputText: 'Durable answer',
      },
    });
    submitDispatchMock.mockResolvedValue({ dispatch: queued, decision: 'queued' });
    waitDispatchMock.mockResolvedValue(completed);

    const response = await processChatCompletion(
      {
        model: 'flow-support',
        messages: [{ role: 'user', content: 'Help me' }],
        appendMessages: true,
      } as any,
      true,
      false,
      false,
      'conversation_1',
      false,
      true,
      {
        personaId: 'persona_support',
        behaviorSlotKey: 'support_chat',
        idempotencyKey: 'client-retry-1',
      },
    );

    expect(submitDispatchMock).toHaveBeenCalledWith({
      personaId: 'persona_support',
      idempotencyKey: 'client-retry-1',
      kind: 'interactive_chat',
      source: { kind: 'chat', sourceId: 'conversation_1' },
      behaviorSlotKey: 'support_chat',
      relationKey: 'conversation_1',
      relatedAction: 'steer',
      summary: 'Interactive chat completion',
      flowInput: {
        messages: [{ role: 'user', content: 'Help me' }],
        mcpAppContexts: undefined,
        processNodeId: undefined,
        mode: 'conversation',
        conversationId: 'conversation_1',
        flujo: true,
        requireApproval: false,
        debug: false,
        continueDebug: false,
        userTurn: true,
        resumeAsNewTurn: true,
        source: 'chat',
      },
    }, { waitForCompletion: false });
    expect(waitDispatchMock).toHaveBeenCalledWith('dispatch-chat-1', {
      timeoutMs: 30_000,
    });
    expect(runFlowMock).not.toHaveBeenCalled();
    expect(modelCompletionMock).not.toHaveBeenCalled();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      object: 'chat.completion',
      conversation_id: 'conversation_1',
      status: 'completed',
      dispatch_id: 'dispatch-chat-1',
      persona_id: 'persona_support',
      choices: [{ message: { role: 'assistant', content: 'Durable answer' } }],
    });
  });

  it('returns a durable 202 for an admitted steer instead of running the Flow directly', async () => {
    submitDispatchMock.mockResolvedValue({
      dispatch: dispatchRecord('waiting', { waitingReason: 'delivery' }),
      decision: 'steered',
    });

    const response = await processChatCompletion(
      { model: 'flow-support', messages: [{ role: 'user', content: 'One more thing' }] } as any,
      false,
      false,
      false,
      'conversation_1',
      false,
      true,
      { personaId: 'persona_support', idempotencyKey: 'client-retry-2' },
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      status: 'waiting',
      dispatch_id: 'dispatch-chat-1',
      routing_decision: 'steered',
    });
    expect(waitDispatchMock).not.toHaveBeenCalled();
    expect(runFlowMock).not.toHaveBeenCalled();
  });

  it('keeps a terminal delivery-only steer at the durable accepted boundary', async () => {
    submitDispatchMock.mockResolvedValue({
      dispatch: dispatchRecord('completed', {
        completedAt: 2,
        outcome: {
          status: 'steered',
          conversationId: 'conversation_1',
        },
      }),
      decision: 'steered',
    });

    const response = await processChatCompletion(
      { model: 'flow-support', messages: [{ role: 'user', content: 'One more thing' }] } as any,
      false,
      false,
      false,
      'conversation_1',
      false,
      true,
      { personaId: 'persona_support', idempotencyKey: 'client-retry-terminal-steer' },
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      status: 'completed',
      dispatch_id: 'dispatch-chat-1',
      routing_decision: 'steered',
    });
    expect(waitDispatchMock).not.toHaveBeenCalled();
    expect(runFlowMock).not.toHaveBeenCalled();
  });

  it('returns the latest durable queued state when the synchronous wait times out', async () => {
    const queued = dispatchRecord('queued');
    submitDispatchMock.mockResolvedValue({ dispatch: queued, decision: 'queued' });
    waitDispatchMock.mockRejectedValue(new PersonaFlowDispatchTimeoutError('dispatch-chat-1'));
    getDispatchMock.mockResolvedValue(queued);

    const response = await processChatCompletion(
      { model: 'flow-support', messages: [{ role: 'user', content: 'Queued work' }] } as any,
      false,
      false,
      false,
      'conversation_1',
      false,
      true,
      { personaId: 'persona_support', idempotencyKey: 'client-retry-queued' },
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      status: 'queued',
      dispatch_id: 'dispatch-chat-1',
    });
    expect(getDispatchMock).toHaveBeenCalledWith('dispatch-chat-1');
    expect(runFlowMock).not.toHaveBeenCalled();
  });

  it('submits streaming work and observes the dispatcher run on the existing event stream', async () => {
    submitDispatchMock.mockResolvedValue({
      dispatch: dispatchRecord('queued'),
      decision: 'queued',
    });

    const response = await processChatCompletion(
      {
        model: 'flow-support',
        messages: [{ role: 'user', content: 'Stream it' }],
        stream: true,
      } as any,
      false,
      false,
      false,
      'conversation_stream',
      false,
      true,
      { personaId: 'persona_support', idempotencyKey: 'client-retry-stream' },
    );
    await Promise.resolve();
    executionEventBus.emit('conversation_stream', {
      type: 'message',
      message: { role: 'assistant', content: 'Streamed answer', id: 'assistant_1', timestamp: 1 },
    } as any);
    executionEventBus.emit('conversation_stream', {
      type: 'run:done',
      status: 'completed',
    } as any);

    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    const body = await readAll(response as Response);
    expect(body).toContain('Streamed answer');
    expect(body).toContain('data: [DONE]');
    expect(waitDispatchMock).not.toHaveBeenCalled();
    expect(runFlowMock).not.toHaveBeenCalled();
  });

  it('finishes an idempotent streaming retry from the durable completed outcome after restart', async () => {
    submitDispatchMock.mockResolvedValue({
      dispatch: dispatchRecord('completed', {
        completedAt: 2,
        outcome: {
          status: 'completed',
          conversationId: 'conversation_stream_retry',
          outputText: 'Durable replay after restart',
        },
      }),
      decision: 'duplicate',
    });

    const response = await processChatCompletion(
      {
        model: 'flow-support',
        messages: [{ role: 'user', content: 'Retry the stream' }],
        stream: true,
      } as any,
      false,
      false,
      false,
      'conversation_stream_retry',
      false,
      true,
      { personaId: 'persona_support', idempotencyKey: 'client-retry-stream-terminal' },
    );

    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    const body = await readAll(response as Response);
    expect(body).toContain('Durable replay after restart');
    expect(body).toContain('"dispatch_id":"dispatch-chat-1"');
    expect(body).toContain('data: [DONE]');
    expect(waitDispatchMock).not.toHaveBeenCalled();
    expect(getDispatchMock).not.toHaveBeenCalled();
    expect(runFlowMock).not.toHaveBeenCalled();
  });

  it('keeps a terminal streaming steer at the durable accepted boundary', async () => {
    submitDispatchMock.mockResolvedValue({
      dispatch: dispatchRecord('completed', {
        completedAt: 2,
        outcome: {
          status: 'steered',
          conversationId: 'conversation_stream_steer',
        },
      }),
      decision: 'steered',
    });

    const response = await processChatCompletion(
      {
        model: 'flow-support',
        messages: [{ role: 'user', content: 'Add this to the active turn' }],
        stream: true,
      } as any,
      false,
      false,
      false,
      'conversation_stream_steer',
      false,
      true,
      { personaId: 'persona_support', idempotencyKey: 'client-retry-stream-steer' },
    );

    expect(response.status).toBe(202);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      status: 'completed',
      routing_decision: 'steered',
    });
    expect(waitDispatchMock).not.toHaveBeenCalled();
    expect(runFlowMock).not.toHaveBeenCalled();
  });

  it('rejects Persona targeting on model completions before either execution path', async () => {
    const response = await processChatCompletion(
      { model: 'model-test', messages: [{ role: 'user', content: 'Hi' }] } as any,
      false,
      false,
      false,
      undefined,
      false,
      false,
      { personaId: 'persona_support' },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'persona_model_not_supported' },
    });
    expect(submitDispatchMock).not.toHaveBeenCalled();
    expect(runFlowMock).not.toHaveBeenCalled();
    expect(modelCompletionMock).not.toHaveBeenCalled();
  });

  it('keeps a Persona-less Flow request on the legacy direct runFlow adapter', async () => {
    runFlowMock.mockResolvedValue({ flowNotFound: { name: 'flow-support' } });

    const response = await processChatCompletion(
      { model: 'flow-support', messages: [{ role: 'user', content: 'Legacy' }] } as any,
      false,
      false,
      false,
      'conversation_legacy',
    );

    expect(response.status).toBe(400);
    expect(runFlowMock).toHaveBeenCalledTimes(1);
    expect(submitDispatchMock).not.toHaveBeenCalled();
  });
});

describe('Persona streaming reader ownership', () => {
  const request = { model: 'flow-support', messages: [{ role: 'user', content: 'Current request' }], stream: true };
  const target = { personaId: 'persona_support', idempotencyKey: 'reader-admission-test' };

  it('rejects repeated reader-capacity requests without submitting or waiting for a Persona dispatch', async () => {
    const id = 'persona-reader-full';
    const before = executionStreamAdmission.diagnostics();
    const held = Array.from({ length: 4 }, () => executionStreamAdmission.reserve(id)!);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await processChatCompletion(request as any, false, false, false, id, false, true, target);
        expect(response.status).toBe(503);
        expect(response.headers.get('Retry-After')).toBe('3');
      }
      expect(submitDispatchMock).not.toHaveBeenCalled();
      expect(waitDispatchMock).not.toHaveBeenCalled();
      expect(runFlowMock).not.toHaveBeenCalled();
      expect(executionStreamAdmission.diagnostics().active).toBe(before.active + 4);
    } finally { held.forEach(release => release()); }
    expect(executionStreamAdmission.diagnostics()).toMatchObject({ active: before.active, workspaces: before.workspaces, conversations: before.conversations });
  });

  it('returns projection rejection before durable submission and releases the partial reader admission', async () => {
    const before = executionStreamAdmission.diagnostics();
    const projection = jest.spyOn(executionEventBus, 'ensureConversationProjection').mockReturnValue(false);
    const subscribe = jest.spyOn(executionEventBus, 'subscribe');
    try {
      const response = await processChatCompletion(request as any, false, false, false, 'persona-projection-full', false, true, target);
      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('3');
      expect(submitDispatchMock).not.toHaveBeenCalled();
      expect(waitDispatchMock).not.toHaveBeenCalled();
      expect(runFlowMock).not.toHaveBeenCalled();
      expect(subscribe).not.toHaveBeenCalled();
      expect(executionStreamAdmission.diagnostics()).toMatchObject({ active: before.active, workspaces: before.workspaces, conversations: before.conversations });
    } finally { subscribe.mockRestore(); projection.mockRestore(); }
  });

  it('pins through delayed submission and metadata churn, then attaches the reader before releasing the pin', async () => {
    const id = 'persona-delayed-admission';
    const before = executionStreamAdmission.diagnostics();
    let resolveSubmission!: (value: unknown) => void;
    const pending = new Promise(resolve => { resolveSubmission = resolve; });
    const phases: string[] = [];
    const originalSubscribe = executionEventBus.subscribe.bind(executionEventBus);
    let subscriptions = 0;
    const subscribe = jest.spyOn(executionEventBus, 'subscribe').mockImplementation((conversation, listener) => {
      const phase = subscriptions++ === 0 ? 'pin' : 'reader';
      const release = originalSubscribe(conversation, listener);
      phases.push(phase + ' attached');
      return () => { phases.push(phase + ' released'); release(); };
    });
    const reserve = jest.spyOn(executionStreamAdmission, 'reserve');
    submitDispatchMock.mockImplementationOnce(() => { phases.push('submitted'); return pending; });
    let response: Response | undefined;
    try {
      const responsePromise = processChatCompletion(request as any, false, false, false, id, false, true, target);
      expect(phases).toEqual(['pin attached', 'submitted']);
      expect(executionStreamAdmission.diagnostics().active).toBe(before.active + 1);
      executionEventBus.emit(id, { type: 'run:start', flowId: 'previous' });
      executionEventBus.emit(id, { type: 'message', message: { id: 'previous', role: 'assistant', content: 'Previous output', timestamp: 1 } });
      executionEventBus.emit(id, { type: 'run:done', status: 'completed' });
      for (let index = 0; index < CONVERSATION_REPLAY_LIMITS.maxChannels + 10; index++) {
        executionEventBus.emit('persona-admission-churn-' + index, { type: 'model:delta', messageId: 'draft', delta: 'small' });
      }
      expect(executionEventBus.getBufferedSince(id, 0).some(event => event.type === 'message' && event.message.id === 'previous')).toBe(true);
      expect(subscribe).toHaveBeenCalledTimes(1);
      executionEventBus.emit(id, { type: 'run:start', flowId: 'current' });
      resolveSubmission({ dispatch: dispatchRecord('queued'), decision: 'queued' });
      response = await responsePromise;
      expect(phases).toEqual(['pin attached', 'submitted', 'reader attached', 'pin released']);
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(executionStreamAdmission.diagnostics().active).toBe(before.active + 1);
      executionEventBus.emit(id, { type: 'message', message: { id: 'current', role: 'assistant', content: 'Current output', timestamp: 2 } });
      executionEventBus.emit(id, { type: 'run:done', status: 'completed' });
      const body = await readAll(response);
      expect(body).toContain('Current output');
      expect(body).not.toContain('Previous output');
      expect(body).toContain('data: [DONE]');
      expect(phases).toEqual(['pin attached', 'submitted', 'reader attached', 'pin released', 'reader released']);
      expect(runFlowMock).not.toHaveBeenCalled();
      expect(executionStreamAdmission.diagnostics()).toMatchObject({ active: before.active, workspaces: before.workspaces, conversations: before.conversations });
    } finally {
      resolveSubmission({ dispatch: dispatchRecord('waiting'), decision: 'steered' });
      if (response?.body && !response.body.locked) await response.body.cancel();
      reserve.mockRestore(); subscribe.mockRestore();
    }
  });

  it('releases the pin and reader exactly once when durable submission rejects', async () => {
    const before = executionStreamAdmission.diagnostics();
    const reserve = executionStreamAdmission.reserve.bind(executionStreamAdmission);
    const releaseReader = jest.fn();
    const permits = jest.spyOn(executionStreamAdmission, 'reserve').mockImplementation(conversation => {
      const release = reserve(conversation)!;
      return () => { releaseReader(); release(); };
    });
    const releasePin = jest.fn();
    const subscribe = jest.spyOn(executionEventBus, 'subscribe').mockImplementationOnce(() => releasePin);
    const problem = new Error('durable submission failed');
    submitDispatchMock.mockRejectedValueOnce(problem);
    try {
      await expect(processChatCompletion(request as any, false, false, false, 'persona-submit-failure', false, true, target)).rejects.toBe(problem);
      expect(releasePin).toHaveBeenCalledTimes(1);
      expect(releaseReader).toHaveBeenCalledTimes(1);
      expect(runFlowMock).not.toHaveBeenCalled();
      expect(executionStreamAdmission.diagnostics()).toMatchObject({ active: before.active, workspaces: before.workspaces, conversations: before.conversations });
    } finally { subscribe.mockRestore(); permits.mockRestore(); }
  });

  it('keeps non-streaming Persona completion outside reader admission', async () => {
    const permits = jest.spyOn(executionStreamAdmission, 'reserve').mockImplementation(() => { throw new Error('must not reserve'); });
    submitDispatchMock.mockResolvedValueOnce({ dispatch: dispatchRecord('completed', { outcome: { status: 'completed', outputText: 'Existing result' } }), decision: 'duplicate' });
    try {
      const response = await processChatCompletion({ ...request, stream: false } as any, false, false, false, 'persona-nonstream-admission', false, true, target);
      expect(response.status).toBe(200);
      expect(permits).not.toHaveBeenCalled();
      expect(submitDispatchMock).toHaveBeenCalledTimes(1);
      expect(runFlowMock).not.toHaveBeenCalled();
    } finally { permits.mockRestore(); }
  });

  it.each([
    { label: 'waiting', state: 'waiting', extra: {} },
    { label: 'completed without outcome', state: 'completed', extra: {} },
    { label: 'completed steer', state: 'completed', extra: { outcome: { status: 'steered' } } },
    { label: 'completed coalesce', state: 'completed', extra: { outcome: { status: 'coalesced' } } },
    { label: 'completed result', state: 'completed', extra: { outcome: { status: 'completed', outputText: 'Durable result' } } },
    { label: 'error', state: 'error', extra: {} },
    { label: 'cancelled', state: 'cancelled', extra: {} },
  ])('releases pre-dispatch reader ownership for a $label response', async fixture => {
    const before = executionStreamAdmission.diagnostics();
    const reserve = executionStreamAdmission.reserve.bind(executionStreamAdmission);
    const releaseReader = jest.fn();
    const permits = jest.spyOn(executionStreamAdmission, 'reserve').mockImplementation(conversation => {
      const release = reserve(conversation)!;
      return () => { releaseReader(); release(); };
    });
    const releasePin = jest.fn();
    const subscribe = jest.spyOn(executionEventBus, 'subscribe').mockImplementationOnce(() => releasePin);
    submitDispatchMock.mockResolvedValueOnce({ dispatch: dispatchRecord(fixture.state, fixture.extra), decision: 'duplicate' });
    try {
      const response = await processChatCompletion(request as any, false, false, false, 'persona-early-' + fixture.label, false, true, target);
      expect(response.status).not.toBe(503);
      expect(subscribe).toHaveBeenCalledTimes(1);
      expect(releasePin).toHaveBeenCalledTimes(1);
      expect(releaseReader).toHaveBeenCalledTimes(1);
      expect(runFlowMock).not.toHaveBeenCalled();
      expect(executionStreamAdmission.diagnostics()).toMatchObject({ active: before.active, workspaces: before.workspaces, conversations: before.conversations });
      await response.body?.cancel();
      expect(releaseReader).toHaveBeenCalledTimes(1);
    } finally { subscribe.mockRestore(); permits.mockRestore(); }
  });
});
