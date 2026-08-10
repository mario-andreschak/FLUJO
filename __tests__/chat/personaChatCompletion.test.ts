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
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
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
      kind: 'assignment',
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
