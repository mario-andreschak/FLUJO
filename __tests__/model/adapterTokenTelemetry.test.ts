import type { CompletionAdapter, CompletionInput } from '@/backend/services/model/adapters/types';

jest.mock('@/utils/logger', () => ({ createLogger: () => ({
  verbose: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}) }));
jest.mock('@/backend/services/model/openaiClient', () => {
  const create = jest.fn();
  const responsesCreate = jest.fn();
  return {
    createOpenAIClient: () => ({ chat: { completions: { create } }, responses: { create: responsesCreate } }),
    createAzureOpenAIClient: () => ({ chat: { completions: { create } } }),
    getProviderDefaultHeaders: () => ({}),
    __create: create, __responsesCreate: responsesCreate,
  };
});
jest.mock('@anthropic-ai/sdk', () => {
  const create = jest.fn();
  const stream = jest.fn();
  return { __esModule: true, default: jest.fn(() => ({ messages: { create, stream }, models: { retrieve: jest.fn() } })),
    __create: create, __stream: stream };
});
jest.mock('@google/genai', () => {
  const generateContent = jest.fn();
  const generateContentStream = jest.fn();
  return { GoogleGenAI: jest.fn(() => ({ models: { generateContent, generateContentStream } })),
    __generateContent: generateContent, __generateContentStream: generateContentStream };
});

import { OpenAiAdapter } from '@/backend/services/model/adapters/openaiAdapter';
import { AzureOpenAiAdapter } from '@/backend/services/model/adapters/azureOpenAiAdapter';
import { OpenAiResponsesAdapter } from '@/backend/services/model/adapters/openaiResponsesAdapter';
import { AnthropicAdapter } from '@/backend/services/model/adapters/anthropicAdapter';
import { GeminiAdapter } from '@/backend/services/model/adapters/geminiAdapter';
import { mapOpenAiUsage } from '@/backend/services/model/adapters/openaiUsage';

const openai = jest.requireMock('@/backend/services/model/openaiClient');
const anthropic = jest.requireMock('@anthropic-ai/sdk');
const google = jest.requireMock('@google/genai');
const input: CompletionInput = {
  model: { id: 'model', name: 'test-model', ApiKey: 'test-key', contextWindow: 200000, baseUrl: 'https://test.openai.azure.com' },
  apiKey: 'test-key', messages: [{ role: 'user', content: 'Hello' }],
};
const stream = async function* (...events: unknown[]) { yield* events; };

beforeEach(() => {
  jest.clearAllMocks();
});

describe.each([false, true])('token telemetry (streaming=%s)', streaming => {
  const call = (adapter: CompletionAdapter) => streaming
    ? adapter.createStreamCompletion!(input) : adapter.createCompletion(input);

  it.each([['OpenAI', OpenAiAdapter], ['Azure', AzureOpenAiAdapter]] as const)(
    '%s keeps cache and reasoning as subsets and snapshots the latest request', async (_name, Adapter) => {
      const usage = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100,
        prompt_tokens_details: { cached_tokens: 800 }, completion_tokens_details: { reasoning_tokens: 60 } };
      const response = { id: 'response', model: 'test-model', choices: [{ index: 0,
        message: { role: 'assistant', content: 'hi' }, delta: { content: 'hi' }, finish_reason: 'stop' }], usage };
      // Streaming usage can arrive after the final content/finish_reason, with no choices.
      openai.__create.mockResolvedValue(streaming
        ? stream({ ...response, usage: null }, { choices: [], usage }) : response);
      const result = await call(new Adapter());
      expect(mapOpenAiUsage(result.completion.usage)).toMatchObject({
        promptTokens: 1000, completionTokens: 100, totalTokens: 1100, cacheReadTokens: 800,
      });
      expect(result.contextUsage).toEqual({ promptTokens: 1000, completionTokens: 100, totalTokens: 1100,
        contextWindow: 200000, contextWindowSource: 'configured' });
    },
  );

  it('Responses preserves cached input and does not count reasoning output twice', async () => {
    const response = { id: 'response', created_at: 1, model: 'test-model', output: [],
      usage: { input_tokens: 1000, output_tokens: 100, // Gateways may omit total_tokens.
        input_tokens_details: { cached_tokens: 800 }, output_tokens_details: { reasoning_tokens: 60 } } };
    openai.__responsesCreate.mockResolvedValue(streaming
      ? stream({ type: 'response.completed', response }) : response);
    const result = await call(new OpenAiResponsesAdapter());
    expect(mapOpenAiUsage(result.completion.usage)).toMatchObject({
      promptTokens: 1000, completionTokens: 100, totalTokens: 1100, cacheReadTokens: 800,
    });
    expect(result.contextUsage).toMatchObject({ promptTokens: 1000, completionTokens: 100, totalTokens: 1100 });
  });

  it('Anthropic adds its separate uncached, cache-read, and cache-write input buckets', async () => {
    const response = { id: 'response', model: 'test-model', content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn', usage: { input_tokens: 50, cache_creation_input_tokens: 150,
        cache_read_input_tokens: 800, output_tokens: 100 } };
    anthropic.__create.mockResolvedValue(response);
    anthropic.__stream.mockReturnValue({ finalMessage: async () => response });
    const result = await call(new AnthropicAdapter());
    expect(mapOpenAiUsage(result.completion.usage)).toMatchObject({
      promptTokens: 1000, completionTokens: 100, totalTokens: 1100, cacheReadTokens: 800, cacheWriteTokens: 150,
    });
    expect(result.contextUsage).toMatchObject({ promptTokens: 1000, completionTokens: 100, totalTokens: 1100 });
  });

  it('Gemini includes thinking in output, preserves cache reads, and measures its input limit against input only', async () => {
    const response = { responseId: 'response', candidates: [{ content: { parts: [{ text: 'hi' }] } }],
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 40, thoughtsTokenCount: 60,
        cachedContentTokenCount: 800, totalTokenCount: 1100 } };
    google.__generateContent.mockResolvedValue(response);
    google.__generateContentStream.mockResolvedValue(stream(response));
    const result = await call(new GeminiAdapter());
    expect(mapOpenAiUsage(result.completion.usage)).toMatchObject({
      promptTokens: 1000, completionTokens: 100, totalTokens: 1100, cacheReadTokens: 800,
    });
    expect(result.completion.usage?.completion_tokens_details?.reasoning_tokens).toBe(60);
    expect(result.contextUsage).toEqual({ promptTokens: 1000, completionTokens: 100,
      contextWindow: 200000, contextWindowSource: 'configured' });
  });

  it.each([['OpenAI', OpenAiAdapter], ['Responses', OpenAiResponsesAdapter], ['Gemini', GeminiAdapter]] as const)(
    '%s leaves missing telemetry unavailable instead of inventing zero context', async (_name, Adapter) => {
      const response = { id: 'response', choices: [], output: [], candidates: [] };
      openai.__create.mockResolvedValue(streaming ? stream(response) : response);
      openai.__responsesCreate.mockResolvedValue(streaming ? stream({ type: 'response.completed', response }) : response);
      google.__generateContent.mockResolvedValue(response);
      google.__generateContentStream.mockResolvedValue(stream(response));
      const result = await call(new Adapter());
      expect(result.contextUsage).toBeNull();
      expect(result.completion.usage).toBeUndefined();
    },
  );
});
