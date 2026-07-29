/**
 * Tests for the context-length overflow recovery in ModelHandler.
 *
 * compactForWire already shrinks OLD oversized tool results on the wire, but it
 * keeps the RECENT tail verbatim for prefix-cache stability. A single
 * unexpectedly-large NEW tool result (a big search dump, a large file read) can
 * therefore still overflow the model's context window on the very turn it is
 * produced — the provider rejects the whole request for length.
 *
 * ModelHandler.generateCompletion now catches that specific error and retries
 * ONCE, this time shrinking every oversized tool result on the wire (recent
 * included) to a head excerpt + a dereferenceable flujo://run/... URI that names
 * the full size, capturing any not-yet-captured result on the fly so the model
 * can read the whole thing back via read_resource.
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
    getModel: (...a: unknown[]) => getModelMock(...(a as [])),
    resolveAndDecryptApiKey: (...a: unknown[]) => resolveKeyMock(...(a as [])),
  },
}));

const listRunResourcesMock = jest.fn();
const writeRunResourceMock = jest.fn();
const getRunResourceSettingsMock = jest.fn();
jest.mock('@/backend/services/runResources', () => ({
  listRunResources: (...a: unknown[]) => listRunResourcesMock(...(a as [])),
  writeRunResource: (...a: unknown[]) => writeRunResourceMock(...(a as [])),
  getRunResourceSettings: (...a: unknown[]) => getRunResourceSettingsMock(...(a as [])),
}));

const OVERFLOW_MESSAGE =
  "This endpoint's maximum context length is 262144 tokens. However, you requested about " +
  '351213 tokens (347939 of text input, 3274 of tool input). Please reduce the length of ' +
  'either one, or use the context-compression plugin to compress your prompt automatically.';

// The programmable adapter rejects only an oversized wire payload. This lets
// the tests distinguish the proactive first-call refit from the reactive retry.
let calls: OpenAI.ChatCompletionMessageParam[][] = [];
const createCompletionMock = jest.fn((input: { messages: OpenAI.ChatCompletionMessageParam[] }) => {
  calls.push(input.messages);
  if (toolContentOf(input.messages).length > 3000) {
    return Promise.resolve({ completion: { error: { message: OVERFLOW_MESSAGE } } });
  }
  return Promise.resolve({
    completion: {
      id: 'cmpl-2',
      object: 'chat.completion',
      created: 2,
      model: 'test-model',
      choices: [
        { index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content: 'ok', refusal: null } },
      ],
    },
  });
});
jest.mock('@/backend/services/model/adapters', () => ({
  getCompletionAdapter: () => ({ createCompletion: createCompletionMock }),
}));

import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';

const conversationStates = FlowExecutor.conversationStates as Map<string, SharedState>;

const HUGE = 'x'.repeat(400_000);

const seedState = (conversationId: string): SharedState => {
  const state = {
    trackingInfo: { executionId: 'e1', startTime: 1, nodeExecutionTracker: [] },
    messages: [],
    flowId: 'flow-1',
    conversationId,
    status: 'running',
    title: 'T',
    createdAt: 1,
    updatedAt: 1,
  } as unknown as SharedState;
  conversationStates.set(conversationId, state);
  return state;
};

const callModel = (conversationId: string) =>
  ModelHandler.callModel({
    modelId: 'model-1',
    prompt: 'search',
    messages: [
      { role: 'user', content: 'search everything', id: 'u1', timestamp: 1 },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'search', arguments: '{}' } }],
        id: 'a1',
        timestamp: 2,
      },
      { role: 'tool', tool_call_id: 'call-1', content: HUGE, id: 't1', timestamp: 3 },
    ],
    iteration: 1,
    maxIterations: 1,
    nodeName: 'Node',
    nodeId: 'node-1',
    conversationId,
  } as Parameters<typeof ModelHandler.callModel>[0]);

const toolContentOf = (msgs: OpenAI.ChatCompletionMessageParam[]): string => {
  const tool = msgs.find((m) => m.role === 'tool') as OpenAI.ChatCompletionToolMessageParam | undefined;
  return typeof tool?.content === 'string' ? tool.content : '';
};

beforeEach(() => {
  conversationStates.clear();
  calls = [];
  createCompletionMock.mockClear();
  getModelMock.mockReset().mockResolvedValue({ id: 'model-1', name: 'test-model', provider: 'openai' });
  resolveKeyMock.mockReset().mockResolvedValue('sk-test');
  listRunResourcesMock.mockReset().mockResolvedValue([]); // no prior captures → no markers
  getRunResourceSettingsMock.mockReset().mockResolvedValue({
    autoCaptureEnabled: true,
    textThresholdChars: 8192,
    maxResourceBytes: 50 * 1024 * 1024,
    maxConversationBytes: 256 * 1024 * 1024,
    replaceLargeTextWithStub: false,
  });
  writeRunResourceMock.mockReset().mockResolvedValue({
    uri: 'flujo://run/conv-of/res-1',
    size: HUGE.length,
    kind: 'text',
    mimeType: 'text/plain',
  });
});

describe('context-length overflow refit', () => {
  it('retries once, shrinking the oversized recent tool result to a size-naming URI marker', async () => {
    seedState('conv-of');
    const result = await callModel('conv-of');

    // Retried exactly once (two provider calls total).
    expect(createCompletionMock).toHaveBeenCalledTimes(2);

    // First attempt carried the full result verbatim; the refit shrank it.
    expect(toolContentOf(calls[0]).length).toBe(400_000);
    const refit = toolContentOf(calls[1]);
    expect(refit.length).toBeLessThan(3000);
    expect(refit).toContain('flujo://run/conv-of/res-1');
    expect(refit).toContain('read_resource');
    expect(refit).toContain('400000'); // the full size is announced to the model

    // The uncaptured result was written to the store on the fly so it is recoverable.
    expect(writeRunResourceMock).toHaveBeenCalledTimes(1);
    const writeArg = writeRunResourceMock.mock.calls[0][0];
    expect(writeArg.data.text.length).toBe(400_000);
    expect(writeArg.producedBy.toolCallId).toBe('call-1');

    // The retry succeeded.
    expect(result.success).toBe(true);
    if (result.success) expect(result.value.content).toBe('ok');
  });

  it('refits a known-context request before its first provider call', async () => {
    getModelMock.mockResolvedValue({
      id: 'model-1',
      name: 'test-model',
      provider: 'openai',
      contextWindow: 20_000,
      maxTokens: 4_096,
    });
    seedState('conv-budget');
    const result = await callModel('conv-budget');

    expect(createCompletionMock).toHaveBeenCalledTimes(1);
    const sent = toolContentOf(calls[0]);
    expect(sent.length).toBeLessThan(3000);
    expect(sent).toContain('flujo://run/conv-of/res-1');
    expect(writeRunResourceMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it('does not retry on a non-overflow provider error', async () => {
    // A generic 400 must NOT trigger the (lossy) refit path.
    createCompletionMock.mockImplementationOnce((input: { messages: OpenAI.ChatCompletionMessageParam[] }) => {
      calls.push(input.messages);
      return Promise.resolve({ completion: { error: { message: 'Invalid request: bad tool schema' } } });
    });
    seedState('conv-plain');
    const result = await callModel('conv-plain');

    expect(createCompletionMock).toHaveBeenCalledTimes(1);
    expect(writeRunResourceMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });
});
