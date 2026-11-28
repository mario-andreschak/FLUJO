/**
 * Issue #1227: a reply that reached the model's output length limit is a
 * finished turn with a soft "cut off" notice, never a run error. This holds for
 * every adapter, because ModelHandler marks the notice from the shared
 * `finish_reason: 'length'` and each adapter reports its own limit that way.
 */
import type { Interactions } from '@google/genai';
import type OpenAI from 'openai';
import type { SharedState } from '@/backend/execution/flow/types';
import type { FlujoChatMessage } from '@/shared/types/chat';

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({ verbose: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { conversationStates: new Map() },
}));

const getModelMock = jest.fn();
jest.mock('@/backend/services/model', () => ({
  modelService: {
    getModel: (...args: unknown[]) => getModelMock(...(args as [])),
    resolveAndDecryptApiKey: async () => 'sk-test',
  },
}));

const createCompletionMock = jest.fn();
jest.mock('@/backend/services/model/adapters', () => ({
  getCompletionAdapter: () => ({ createCompletion: createCompletionMock }),
}));

jest.mock('@/backend/execution/flow/engine/ExecutionEventBus', () => ({
  executionEventBus: { emitterFor: () => jest.fn() },
}));

import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { toApiMessages } from '@/backend/execution/flow/buildNodeContext';
import { interactionResult } from '@/backend/services/model/adapters/geminiInteractions';
import { fromResponse } from '@/backend/services/model/adapters/openaiResponsesAdapter';

const conversationStates = FlowExecutor.conversationStates as Map<string, SharedState>;

const completion = (content: string, finishReason: 'stop' | 'length') => ({
  completion: {
    id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: 'test-model',
    choices: [{ index: 0, finish_reason: finishReason, logprobs: null,
      message: { role: 'assistant', content, refusal: null } }],
  },
});

async function callModel(conversationId: string) {
  conversationStates.set(conversationId, {
    trackingInfo: { executionId: 'e1', startTime: 1, nodeExecutionTracker: [] },
    messages: [], flowId: 'flow-1', conversationId, status: 'running', title: 'Test', createdAt: 1, updatedAt: 1,
  } as unknown as SharedState);
  return ModelHandler.callModel({
    modelId: 'model-1', prompt: 'Reply to Astra.',
    messages: [{ role: 'user', content: 'Reply to Astra.', id: 'u1', timestamp: 1 }],
    nodeName: 'Argon', nodeId: 'node-1', conversationId,
  } as Parameters<typeof ModelHandler.callModel>[0]);
}

beforeEach(() => {
  conversationStates.clear();
  createCompletionMock.mockReset();
  getModelMock.mockReset().mockResolvedValue({ id: 'model-1', name: 'test-model', provider: 'openai' });
});

it('keeps a reply cut off by the length limit and marks it with a soft notice', async () => {
  createCompletionMock.mockResolvedValueOnce(completion('Here is the first part of a long answer', 'length'));
  const result = await callModel('cut-off');
  expect(result.success).toBe(true);
  if (!result.success) return;
  expect(result.value.content).toBe('Here is the first part of a long answer');
  expect(result.value.messages.at(-1)).toMatchObject({ role: 'assistant', cutOff: 'length' });
  expect(createCompletionMock).toHaveBeenCalledTimes(1);
});

it('does not mark a reply that finished normally', async () => {
  createCompletionMock.mockResolvedValueOnce(completion('All done.', 'stop'));
  const result = await callModel('finished');
  expect(result.success && result.value.messages.at(-1)).not.toHaveProperty('cutOff');
});

it('explains in plain words when the limit left no answer at all', async () => {
  createCompletionMock.mockResolvedValue(completion('', 'length'));
  const result = await callModel('nothing-written');
  expect(result.success).toBe(false);
  expect(!result.success && result.error.message).toMatch(/reached its length limit before it wrote any answer.*Max output tokens/);
});

it('never sends the notice to a model', () => {
  const history: FlujoChatMessage[] = [
    { role: 'user', content: 'Hi', id: 'u', timestamp: 1 },
    { role: 'assistant', content: 'Partial', id: 'a', timestamp: 2, cutOff: 'length' },
  ];
  expect(toApiMessages(history)[1]).toEqual({ role: 'assistant', content: 'Partial' });
});

describe('every adapter reports a length-limited reply as a finished reply', () => {
  it('Gemini: an incomplete interaction', () => {
    const response = { id: 'g', status: 'incomplete', steps: [
      { type: 'model_output', content: [{ type: 'text', text: 'Partial' }] },
    ] } as Interactions.Interaction;
    const result = interactionResult({ id: 'm', name: 'gemini-test', provider: 'gemini', ApiKey: '' }, response);
    expect(result.completion.choices[0]).toMatchObject({ finish_reason: 'length', message: { content: 'Partial' } });
  });

  it('OpenAI Responses: an incomplete response that hit max_output_tokens', () => {
    const response = { id: 'r', object: 'response', created_at: 1, model: 'gpt-test', status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', id: 'msg', role: 'assistant', status: 'incomplete',
        content: [{ type: 'output_text', text: 'Partial', annotations: [] }] }],
    } as unknown as OpenAI.Responses.Response;
    expect(fromResponse(response, 'gpt-test').completion.choices[0])
      .toMatchObject({ finish_reason: 'length', message: { content: 'Partial' } });
  });
});
