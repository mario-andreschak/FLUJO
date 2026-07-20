import OpenAI from 'openai';
import { Model, normalizeMaxTokens } from '@/shared/types/model';

// Shared logger stub (built inside the factory to dodge jest.mock hoisting).
jest.mock('@/utils/logger', () => {
  const log = { verbose: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { createLogger: () => log };
});

// Mock the hardened OpenAI client: createOpenAIClient always returns the same
// fake whose chat.completions.create we can assert on.
jest.mock('@/backend/services/model/openaiClient', () => {
  const create = jest.fn();
  return {
    createOpenAIClient: () => ({ chat: { completions: { create } } }),
    getProviderDefaultHeaders: () => ({}),
    __create: create,
  };
});

// Mock the Anthropic SDK (default export is the client constructor).
jest.mock('@anthropic-ai/sdk', () => {
  const create = jest.fn();
  const Anthropic = jest.fn().mockImplementation(() => ({ messages: { create } }));
  return { __esModule: true, default: Anthropic, __create: create };
});

// Mock the Google GenAI SDK.
jest.mock('@google/genai', () => {
  const generateContent = jest.fn();
  const GoogleGenAI = jest.fn().mockImplementation(() => ({ models: { generateContent } }));
  return { GoogleGenAI, __generateContent: generateContent };
});

// Adapters must be imported AFTER the mocks above.
import { OpenAiAdapter } from '@/backend/services/model/adapters/openaiAdapter';
import { AnthropicAdapter } from '@/backend/services/model/adapters/anthropicAdapter';
import { GeminiAdapter } from '@/backend/services/model/adapters/geminiAdapter';

const openaiCreate = (jest.requireMock('@/backend/services/model/openaiClient') as { __create: jest.Mock }).__create;
const anthropicCreate = (jest.requireMock('@anthropic-ai/sdk') as { __create: jest.Mock }).__create;
const geminiGenerate = (jest.requireMock('@google/genai') as { __generateContent: jest.Mock }).__generateContent;

const MODEL: Model = { id: 'm1', name: 'test-model', ApiKey: 'key' } as Model;
const MESSAGES: OpenAI.ChatCompletionMessageParam[] = [{ role: 'user', content: 'hi' }];

describe('max_tokens threading across the completion-adapter seam (issue #173)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    openaiCreate.mockResolvedValue({
      id: 'c',
      object: 'chat.completion',
      created: 0,
      model: 'test-model',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }],
    });
    anthropicCreate.mockResolvedValue({
      id: 'a',
      model: 'test-model',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    geminiGenerate.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'hi' }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
    });
  });

  describe('OpenAI adapter', () => {
    test('forwards a resolved maxTokens as max_tokens', async () => {
      await new OpenAiAdapter().createCompletion({ model: MODEL, apiKey: 'k', messages: MESSAGES, temperature: 0, maxTokens: 1234 });
      expect(openaiCreate).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 1234 }), undefined);
    });

    test('omits max_tokens when none is resolved (no regression)', async () => {
      await new OpenAiAdapter().createCompletion({ model: MODEL, apiKey: 'k', messages: MESSAGES, temperature: 0 });
      expect(openaiCreate.mock.calls[0][0]).not.toHaveProperty('max_tokens');
    });
  });

  describe('Anthropic (native) adapter', () => {
    test('uses the resolved maxTokens verbatim, un-capped above 8192', async () => {
      await new AnthropicAdapter().createCompletion({ model: MODEL, apiKey: 'k', messages: MESSAGES, temperature: 0, maxTokens: 20000 });
      expect(anthropicCreate).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 20000 }), undefined);
    });

    test('falls back to the documented 8192 default when nothing is resolved', async () => {
      await new AnthropicAdapter().createCompletion({ model: MODEL, apiKey: 'k', messages: MESSAGES, temperature: 0 });
      expect(anthropicCreate).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 8192 }), undefined);
    });
  });

  describe('Gemini (native) adapter', () => {
    test('sets config.maxOutputTokens when a maxTokens is resolved', async () => {
      await new GeminiAdapter().createCompletion({ model: MODEL, apiKey: 'k', messages: MESSAGES, temperature: 0, maxTokens: 4321 });
      expect(geminiGenerate).toHaveBeenCalledWith(
        expect.objectContaining({ config: expect.objectContaining({ maxOutputTokens: 4321 }) })
      );
    });

    test('omits config.maxOutputTokens when nothing is resolved (no regression)', async () => {
      await new GeminiAdapter().createCompletion({ model: MODEL, apiKey: 'k', messages: MESSAGES, temperature: 0 });
      expect((geminiGenerate.mock.calls[0][0] as { config: Record<string, unknown> }).config).not.toHaveProperty('maxOutputTokens');
    });
  });

  describe('normalizeMaxTokens precedence helper', () => {
    test('non-positive / non-finite / unset collapse to undefined', () => {
      expect(normalizeMaxTokens(0)).toBeUndefined();
      expect(normalizeMaxTokens(-5)).toBeUndefined();
      expect(normalizeMaxTokens(Number.NaN)).toBeUndefined();
      expect(normalizeMaxTokens(undefined)).toBeUndefined();
      expect(normalizeMaxTokens('nope')).toBeUndefined();
    });

    test('positive values are floored to integers', () => {
      expect(normalizeMaxTokens(100.7)).toBe(100);
      expect(normalizeMaxTokens(8192)).toBe(8192);
    });

    test('explicit request value wins over the per-model default', () => {
      expect(normalizeMaxTokens(500) ?? normalizeMaxTokens(8192)).toBe(500);
    });

    test('wire 0 (absent) falls through to the per-model default', () => {
      expect(normalizeMaxTokens(0) ?? normalizeMaxTokens(8192)).toBe(8192);
    });
  });
});
