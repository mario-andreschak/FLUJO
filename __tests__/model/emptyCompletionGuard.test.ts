/**
 * Regression tests for issue #288 — a provider must not successfully complete
 * with finish_reason "stop" while returning no assistant content or tool calls.
 */
import type { SharedState } from '@/backend/execution/flow/types';
import type OpenAI from 'openai';

jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { conversationStates: new Map() },
}));

const getModelMock = jest.fn();
const resolveKeyMock = jest.fn();
jest.mock('@/backend/services/model', () => ({
  modelService: {
    getModel: (...args: unknown[]) => getModelMock(...(args as [])),
    resolveAndDecryptApiKey: (...args: unknown[]) => resolveKeyMock(...(args as [])),
  },
}));

const createCompletionMock = jest.fn();
jest.mock('@/backend/services/model/adapters', () => ({
  getCompletionAdapter: () => ({ createCompletion: createCompletionMock }),
}));

import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';

const conversationStates = FlowExecutor.conversationStates as Map<string, SharedState>;

const completion = (
  content: string | null,
  toolCalls?: OpenAI.ChatCompletionMessageFunctionToolCall[],
  images?: Array<{ type: 'image_url'; image_url: { url: string } }>,
) => ({
  completion: {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1,
    model: 'test-model',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      logprobs: null,
      message: {
        role: 'assistant',
        content,
        refusal: null,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
        ...(images ? { images } : {}),
      },
    }],
  },
});

const seedState = (conversationId: string) => {
  conversationStates.set(conversationId, {
    trackingInfo: { executionId: 'e1', startTime: 1, nodeExecutionTracker: [] },
    messages: [],
    flowId: 'flow-1',
    conversationId,
    status: 'running',
    title: 'Test',
    createdAt: 1,
    updatedAt: 1,
  } as unknown as SharedState);
};

const callModel = (conversationId: string) =>
  ModelHandler.callModel({
    modelId: 'model-1',
    prompt: 'Respond.',
    messages: [{ role: 'user', content: 'Respond.', id: 'u1', timestamp: 1 }],
    iteration: 1,
    maxIterations: 1,
    nodeName: 'Node',
    nodeId: 'node-1',
    conversationId,
  } as Parameters<typeof ModelHandler.callModel>[0]);

beforeEach(() => {
  conversationStates.clear();
  createCompletionMock.mockReset();
  getModelMock.mockReset().mockResolvedValue({
    id: 'model-1',
    name: 'test-model',
    provider: 'openai',
  });
  resolveKeyMock.mockReset().mockResolvedValue('sk-test');
});

describe('empty stopped completion guard (#288)', () => {
  it.each([null, '', '   \t\n'])(
    'rejects stop completion with %p content and no tool calls',
    async (content) => {
      createCompletionMock.mockResolvedValue(completion(content));
      seedState('conv-empty');

      const result = await callModel('conv-empty');

      expect(result.success).toBe(false);
      expect(createCompletionMock).toHaveBeenCalledTimes(7);
      expect(createCompletionMock.mock.calls[0][0].messages).toEqual(
        createCompletionMock.mock.calls[1][0].messages,
      );
      expect(createCompletionMock.mock.calls[1][0].messages).toEqual(
        createCompletionMock.mock.calls[2][0].messages,
      );
      expect(createCompletionMock.mock.calls.map(([input]) => input.temperature)).toEqual([
        0, 0, 0, 1, 0, 0, 0,
      ]);
      expect(createCompletionMock.mock.calls[5][0].messages).toEqual(
        createCompletionMock.mock.calls[0][0].messages,
      );
      expect(createCompletionMock.mock.calls[6][0].messages.at(-1)).toEqual({
        role: 'user',
        content: 'Your previous response was empty. Please provide a complete response or make the appropriate tool call.',
      });
      if (!result.success) {
        expect(result.error.type).toBe('model');
        expect(result.error.code).toBe('api_error');
        expect(result.error.message).toContain('empty message');
      }
    }
  );

  it('returns a successful identical retry without adding the synthetic user message', async () => {
    createCompletionMock
      .mockResolvedValueOnce(completion(''))
      .mockResolvedValueOnce(completion('Recovered.'));
    seedState('conv-recovered-direct');

    const result = await callModel('conv-recovered-direct');

    expect(result.success).toBe(true);
    expect(createCompletionMock).toHaveBeenCalledTimes(2);
    expect(createCompletionMock.mock.calls[1][0].messages).toEqual(
      createCompletionMock.mock.calls[0][0].messages,
    );
    if (result.success) expect(result.value.content).toBe('Recovered.');
  });

  it('can recover on the final retry with a synthetic user message', async () => {
    createCompletionMock
      .mockResolvedValueOnce(completion(''))
      .mockResolvedValueOnce(completion(''))
      .mockResolvedValueOnce(completion(''))
      .mockResolvedValueOnce(completion(''))
      .mockResolvedValueOnce(completion(''))
      .mockResolvedValueOnce(completion(''))
      .mockResolvedValueOnce(completion('Recovered after nudge.'));
    seedState('conv-recovered-synthetic');

    const result = await callModel('conv-recovered-synthetic');

    expect(result.success).toBe(true);
    expect(createCompletionMock).toHaveBeenCalledTimes(7);
    expect(createCompletionMock.mock.calls[6][0].messages.at(-1)).toEqual(expect.objectContaining({
      role: 'user',
      content: expect.stringContaining('previous response was empty'),
    }));
    if (result.success) expect(result.value.content).toBe('Recovered after nudge.');
  });

  it('allows an empty stopped completion that requests a tool call', async () => {
    const toolCalls = [{
      id: 'call-1',
      type: 'function' as const,
      function: { name: 'lookup', arguments: '{}' },
    }];
    createCompletionMock.mockResolvedValue(completion('', toolCalls));
    seedState('conv-tool');

    const result = await callModel('conv-tool');

    expect(result.success).toBe(true);
    if (result.success) expect(result.value.toolCalls).toHaveLength(1);
  });

  it('allows a stopped completion with meaningful text', async () => {
    createCompletionMock.mockResolvedValue(completion('Done.'));
    seedState('conv-text');

    const result = await callModel('conv-text');

    expect(result.success).toBe(true);
    if (result.success) expect(result.value.content).toBe('Done.');
  });

  it('allows and materializes an OpenRouter image-only completion', async () => {
    const url = 'data:image/jpeg;base64,/9j/test';
    createCompletionMock.mockResolvedValue(completion(null, undefined, [{
      type: 'image_url',
      image_url: { url },
    }]));
    seedState('conv-image');

    const result = await callModel('conv-image');

    expect(result.success).toBe(true);
    if (result.success) {
      const assistant = result.value.messages[result.value.messages.length - 1];
      expect(assistant.role).toBe('assistant');
      expect(assistant.media).toEqual([
        expect.objectContaining({
          type: 'image',
          mimeType: 'image/jpeg',
          resourceUri: expect.stringMatching(/^flujo:\/\/run\/conv-image\//),
          localPath: expect.stringMatching(/[\\/]conv-image[\\/].+\.jpg$/),
          url: expect.stringContaining('/v1/chat/conversations/conv-image/resources/'),
        }),
      ]);
      expect(assistant.content).toEqual([{
        type: 'image_url',
        image_url: { url: assistant.media?.[0].url },
      }]);
    }
  });
});
