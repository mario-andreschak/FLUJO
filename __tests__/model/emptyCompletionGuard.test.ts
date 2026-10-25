/**
 * Regression tests for issue #288 — a provider must not successfully complete
 * with finish_reason "stop" while returning no assistant content or tool calls.
 */
import type { SharedState } from '@/backend/execution/flow/types';
import OpenAI from 'openai';
import type { CompletionInput } from '@/backend/services/model/adapters/types';

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
import { registerExecutionExtension, type ExecutionExtensionContext } from '@/backend/execution/extensions';
import { fixtureAdapter, fixtureRun, mintFixture } from '../executionExtensions/fixtureAdapter';
import { ConversationPublicationError } from '@/backend/execution/flow/conversationPublicationError';
import { FlowExecutionAuthorityError } from '@/backend/execution/flow/executionAuthority';

const conversationStates = FlowExecutor.conversationStates as Map<string, SharedState>;
const emitMock = jest.fn();
jest.mock('@/backend/execution/flow/engine/ExecutionEventBus', () => ({
  executionEventBus: { emitterFor: () => emitMock },
}));

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

const callModel = (conversationId: string, executionExtensionContext?: ExecutionExtensionContext) =>
  ModelHandler.callModel({
    modelId: 'model-1',
    prompt: 'Respond.',
    messages: [{ role: 'user', content: 'Respond.', id: 'u1', timestamp: 1 }],
    iteration: 1,
    maxIterations: 1,
    nodeName: 'Node',
    nodeId: 'node-1',
    conversationId,
    executionExtensionContext,
  } as Parameters<typeof ModelHandler.callModel>[0]);

beforeEach(() => {
  emitMock.mockReset();
  conversationStates.clear();
  createCompletionMock.mockReset();
  getModelMock.mockReset().mockResolvedValue({
    id: 'model-1',
    name: 'test-model',
    provider: 'openai',
  });
  resolveKeyMock.mockReset().mockResolvedValue('sk-test');
});

const rateLimited = () => new OpenAI.APIError(429, {
  message: 'Rate limit reached', code: 'rate_limit_exceeded', type: 'rate_limit_error',
  metadata: { retry_after_seconds: 0.01 },
}, undefined, new Headers({ 'retry-after': '0.01' }));

it('retains the ordinary eligible session-limit retry path', async () => {
  createCompletionMock.mockRejectedValueOnce(rateLimited()).mockResolvedValueOnce(completion('Recovered'));
  seedState('ordinary-session-limit');
  expect((await callModel('ordinary-session-limit')).success).toBe(true);
  expect(createCompletionMock).toHaveBeenCalledTimes(2);
});
it('recovers an empty length-limited response instead of completing the chat with nothing', async () => {
  const empty = completion('');
  empty.completion.choices[0].finish_reason = 'length';
  createCompletionMock.mockResolvedValueOnce(empty).mockResolvedValueOnce(completion('Recovered exact code'));
  seedState('empty-length');
  const result = await callModel('empty-length');
  expect(result.success).toBe(true);
  expect(result.success && result.value.content).toBe('Recovered exact code');
  expect(createCompletionMock).toHaveBeenCalledTimes(2);
});

it.each(['openai', 'openai-responses'])('recovers an exhausted Free reasoning budget on %s without raising the cap or changing model', async adapter => {
  const model = { id: 'model-1', name: 'openrouter/free', provider: 'openrouter', adapter,
    reasoningEffort: 'high', contextWindow: 2048, maxTokens: 256 };
  getModelMock.mockResolvedValue(model);
  const empty = completion(''); empty.completion.choices[0].finish_reason = 'length';
  createCompletionMock.mockResolvedValueOnce(empty).mockResolvedValueOnce(completion('Visible answer'));
  seedState('reasoning-recovery');
  expect((await callModel('reasoning-recovery')).success).toBe(true);
  const first = createCompletionMock.mock.calls[0][0], retry = createCompletionMock.mock.calls[1][0];
  expect(first.disableReasoningForRecovery).toBeUndefined();
  expect(retry).toMatchObject({ disableReasoningForRecovery: true, maxTokens: 256,
    model: { name: 'openrouter/free', provider: 'openrouter', reasoningEffort: 'high' } });
  expect(retry.messages).toEqual(first.messages);
  expect(model.reasoningEffort).toBe('high');
});

it('retries a whitespace-only stream without emitting a blank draft', async () => {
  getModelMock.mockResolvedValue({ id: 'model-1', name: 'openrouter/free', provider: 'openrouter',
    contextWindow: 2048, maxTokens: 256 });
  const emit = emitMock;
  createCompletionMock.mockImplementationOnce(async (input: CompletionInput) => {
    input.onModelDelta?.({ messageId: 'empty-attempt', contentDelta: '\n\n' });
    input.onModelDelta?.({ messageId: 'empty-attempt', contentDelta: '\n' });
    const empty = completion('\n\n\n'); empty.completion.choices[0].finish_reason = 'length';
    return empty;
  }).mockImplementationOnce(async (input: CompletionInput) => {
    input.onModelDelta?.({ messageId: 'answer', contentDelta: 'Recovered' });
    return completion('Recovered');
  });
  seedState('blank-stream');
  expect((await callModel('blank-stream')).success).toBe(true);
  expect(createCompletionMock).toHaveBeenCalledTimes(2);
  expect(createCompletionMock.mock.calls[1][0].disableReasoningForRecovery).toBe(true);
  expect(emit.mock.calls.map(([event]) => event).filter(event => event.type === 'model:delta'))
    .toEqual([expect.objectContaining({ messageId: 'answer', delta: 'Recovered' })]);
});

it('preserves indentation once visible text arrives and does not replay a partial answer', async () => {
  const emit = emitMock;
  createCompletionMock.mockImplementationOnce(async (input: CompletionInput) => {
    input.onModelDelta?.({ messageId: 'partial', contentDelta: '\n  ' });
    input.onModelDelta?.({ messageId: 'partial', contentDelta: 'Visible' });
    throw rateLimited();
  });
  seedState('partial-stream');
  expect((await callModel('partial-stream')).success).toBe(false);
  expect(createCompletionMock).toHaveBeenCalledTimes(1);
  expect(emit.mock.calls.map(([event]) => event).filter(event => event.type === 'model:delta')
    .map(event => event.delta).join('')).toBe('\n  Visible');
});

it.each(['provider', 'tool', 'authority'] as const)('keeps the primary %s failure while draining a refused Claude transcript projection', async kind => {
  getModelMock.mockResolvedValue({ id: 'model-1', name: 'test-model', provider: 'claude-subscription', adapter: 'claude-cli' });
  const primary = kind === 'authority' ? new FlowExecutionAuthorityError('Primary authority failure') : new Error(`Primary ${kind} failure`);
  const secondary = new ConversationPublicationError('CONVERSATION_PUBLICATION_BUSY', 'live projection refused');
  let late!: CompletionInput['onTranscriptMessage'];
  emitMock.mockImplementation(event => { if (event.type === 'message' || event.type === 'model:end') throw secondary; });
  createCompletionMock.mockImplementationOnce(async (input: CompletionInput) => {
    late = input.onTranscriptMessage;
    input.onModelDelta?.({ messageId: 'live-draft', contentDelta: 'Partial provider output' });
    input.onTranscriptMessage?.({ id: 'partial', role: 'assistant', content: 'Partial provider output', timestamp: 1 });
    throw primary;
  });
  seedState(`failed-projection-${kind}`);
  const outcome = await callModel(`failed-projection-${kind}`);
  expect(outcome).toMatchObject({ success: false, error: { message: primary.message } });
  expect(createCompletionMock).toHaveBeenCalledTimes(1);
  const emitted = emitMock.mock.calls.length;
  late?.({ id: 'late', role: 'assistant', content: 'Late callback', timestamp: 2 });
  await new Promise(resolve => setImmediate(resolve));
  expect(emitMock).toHaveBeenCalledTimes(emitted);
});

it('surfaces projection refusal after an otherwise successful provider result without retrying', async () => {
  const failure = new ConversationPublicationError('CONVERSATION_PUBLICATION_MEMORY', 'live result refused');
  emitMock.mockImplementation(event => { if (event.type === 'message') throw failure; });
  createCompletionMock.mockImplementationOnce(async (input: CompletionInput) => {
    input.onTranscriptMessage?.({ id: 'result', role: 'assistant', content: 'Completed result', timestamp: 1 });
    return completion('Completed result');
  });
  seedState('successful-projection-refused');
  await expect(callModel('successful-projection-refused')).rejects.toBe(failure);
  expect(createCompletionMock).toHaveBeenCalledTimes(1);
});

it('does not treat normalized required publication refusal as an automatic provider retry', async () => {
  const failure = new ConversationPublicationError('CONVERSATION_PUBLICATION_BUSY', 'required result failed');
  Object.assign(failure.details, { retryAfterMs: 0 });
  createCompletionMock.mockRejectedValueOnce(failure).mockResolvedValue(completion('Must not redispatch'));
  seedState('publication-not-retryable');
  expect(await callModel('publication-not-retryable')).toMatchObject({ success: false, error: { code: failure.code } });
  expect(createCompletionMock).toHaveBeenCalledTimes(1);
});

it('does not replay a tool stream following leading whitespace', async () => {
  createCompletionMock.mockImplementationOnce(async (input: CompletionInput) => {
    input.onModelDelta?.({ messageId: 'tool', contentDelta: '\n' });
    input.onModelDelta?.({ messageId: 'tool', toolCallDelta: { index: 0, nameDelta: 'write_file' } });
    throw rateLimited();
  });
  seedState('tool-stream');
  expect((await callModel('tool-stream')).success).toBe(false);
  expect(createCompletionMock).toHaveBeenCalledTimes(1);
});

it.each(['empty', 'rate-limit'] as const)('does not restart an authenticated single-attempt call after %s', async mode => {
  const run = fixtureRun();
  const adapter = fixtureAdapter({ modelAttemptPolicy: () => ({ version: 1, maxPhysicalAttempts: 1 }) });
  const restore = registerExecutionExtension(adapter);
  try {
    if (mode === 'empty') createCompletionMock.mockResolvedValue(completion(''));
    else createCompletionMock.mockRejectedValue(rateLimited());
    seedState(run.conversation);
    const result = await callModel(run.conversation, mintFixture(adapter, run));
    expect(result.success).toBe(false);
    expect(createCompletionMock).toHaveBeenCalledTimes(1);
    expect(createCompletionMock.mock.calls[0][0].messages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ content: expect.stringContaining('previous response was empty') }),
    ]));
  } finally { restore(); }
});

it('does not restart a policy through the outer session-limit retry loop', async () => {
  getModelMock.mockResolvedValue({
    id: 'model-1', name: 'policy/production', ApiKey: '', provider: 'openai',
    fallbackPolicy: { modelIds: ['primary', 'backup'], triggers: ['unavailable'] },
  });
  createCompletionMock.mockRejectedValue(Object.assign(new Error('Rate limit reached'), {
    status: 429, code: 'rate_limit_exceeded', headers: { 'retry-after': '0.01' },
  }));
  seedState('policy-retry-boundary');
  const result = await callModel('policy-retry-boundary');
  expect(result.success).toBe(false);
  expect(createCompletionMock).toHaveBeenCalledTimes(1);
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
