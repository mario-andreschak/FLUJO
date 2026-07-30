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
  const retrieve = jest.fn();
  const Anthropic = jest.fn().mockImplementation(() => ({
    messages: { create },
    models: { retrieve },
  }));
  return { __esModule: true, default: Anthropic, __create: create };
});

// Mock the Google GenAI SDK.
jest.mock('@google/genai', () => {
  const generateContent = jest.fn();
  const generateContentStream = jest.fn();
  const GoogleGenAI = jest.fn().mockImplementation(() => ({
    models: { generateContent, generateContentStream },
  }));
  return { GoogleGenAI, __generateContent: generateContent, __generateContentStream: generateContentStream };
});

// Adapters must be imported AFTER the mocks above.
import { OpenAiAdapter } from '@/backend/services/model/adapters/openaiAdapter';
import { AnthropicAdapter } from '@/backend/services/model/adapters/anthropicAdapter';
import { GeminiAdapter } from '@/backend/services/model/adapters/geminiAdapter';

const openaiCreate = (jest.requireMock('@/backend/services/model/openaiClient') as { __create: jest.Mock }).__create;
const anthropicCreate = (jest.requireMock('@anthropic-ai/sdk') as { __create: jest.Mock }).__create;
const geminiGenerate = (jest.requireMock('@google/genai') as { __generateContent: jest.Mock }).__generateContent;
const geminiGenerateStream =
  (jest.requireMock('@google/genai') as { __generateContentStream: jest.Mock }).__generateContentStream;

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

    test('requests advertised image output and normalizes OpenRouter message.images', async () => {
      const url = 'data:image/png;base64,AAAA';
      openaiCreate.mockResolvedValueOnce({
        id: 'c-image',
        object: 'chat.completion',
        created: 0,
        model: 'image-model',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: null,
            images: [{ type: 'image_url', image_url: { url } }],
          },
        }],
      });

      const result = await new OpenAiAdapter().createCompletion({
        model: { ...MODEL, outputModalities: ['image', 'text'] },
        apiKey: 'k',
        messages: MESSAGES,
        temperature: 0,
      });

      expect(openaiCreate.mock.calls[0][0]).toHaveProperty('modalities', ['image', 'text']);
      expect(result.media).toEqual([
        expect.objectContaining({ type: 'image', url, mimeType: 'image/png', data: 'AAAA' }),
      ]);
    });
    geminiGenerateStream.mockResolvedValue((async function* () {
      yield {
        responseId: 'gemini-stream',
        candidates: [{ content: { parts: [{ text: 'hi' }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
      };
    })());

    test('maps configured effort to reasoning_effort', async () => {
      await new OpenAiAdapter().createCompletion({
        model: { ...MODEL, reasoningEffort: 'high' },
        apiKey: 'k',
        messages: MESSAGES,
        temperature: 0,
      });
      expect(openaiCreate.mock.calls[0][0]).toHaveProperty('reasoning_effort', 'high');
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

    test('maps configured effort to output_config.effort', async () => {
      await new AnthropicAdapter().createCompletion({
        model: { ...MODEL, reasoningEffort: 'xhigh' },
        apiKey: 'k',
        messages: MESSAGES,
        temperature: 0,
      });
      expect(anthropicCreate).toHaveBeenCalledWith(
        expect.objectContaining({ output_config: { effort: 'xhigh' } }),
        undefined,
      );
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

    test('maps Gemini thinking level and token-budget controls', async () => {
      await new GeminiAdapter().createCompletion({
        model: { ...MODEL, thinkingLevel: 'high' },
        apiKey: 'k',
        messages: MESSAGES,
        temperature: 0,
      });
      expect(geminiGenerate.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          config: expect.objectContaining({ thinkingConfig: { thinkingLevel: 'HIGH' } }),
        }),
      );

      geminiGenerate.mockClear();
      await new GeminiAdapter().createCompletion({
        model: { ...MODEL, thinkingBudget: -1 },
        apiKey: 'k',
        messages: MESSAGES,
        temperature: 0,
      });
      expect(geminiGenerate.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          config: expect.objectContaining({ thinkingConfig: { thinkingBudget: -1 } }),
        }),
      );
    });

    test('requests advertised image output and keeps inlineData from the response', async () => {
      geminiGenerate.mockResolvedValueOnce({
        candidates: [{
          content: {
            parts: [
              { text: 'Here it is.' },
              { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
            ],
          },
        }],
      });

      const result = await new GeminiAdapter().createCompletion({
        model: { ...MODEL, outputModalities: ['text', 'image'] },
        apiKey: 'k',
        messages: MESSAGES,
        temperature: 0,
      });

      expect(geminiGenerate.mock.calls[0][0]).toEqual(expect.objectContaining({
        config: expect.objectContaining({ responseModalities: ['TEXT', 'IMAGE'] }),
      }));
      expect(result.completion.choices[0].message.content).toBe('Here it is.');
      expect(result.media).toEqual([
        { type: 'image', mimeType: 'image/png', data: 'AAAA' },
      ]);
    });

    test('streams text and function calls with one stable assistant id', async () => {
      geminiGenerateStream.mockResolvedValueOnce((async function* () {
        yield { responseId: 'g1', candidates: [{ content: { parts: [{ text: 'hel' }] } }] };
        yield {
          responseId: 'g1',
          candidates: [{
            content: {
              parts: [{
                functionCall: { id: 'call_g', name: 'lookup', args: { query: 'x' } },
              }],
            },
          }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 3, totalTokenCount: 4 },
        };
      })());
      const deltas: unknown[] = [];
      const result = await new GeminiAdapter().createStreamCompletion({
        model: MODEL,
        apiKey: 'k',
        messages: MESSAGES,
        temperature: 0,
        onModelDelta: delta => deltas.push(delta),
      });

      expect(geminiGenerateStream).toHaveBeenCalledTimes(1);
      expect(result.completion.choices[0].message.content).toBe('hel');
      expect(result.completion.choices[0].message.tool_calls?.[0]).toMatchObject({
        id: 'call_g',
        function: { name: 'lookup', arguments: '{"query":"x"}' },
      });
      expect(deltas).toEqual(expect.arrayContaining([
        expect.objectContaining({ contentDelta: 'hel' }),
        expect.objectContaining({
          toolCallDelta: expect.objectContaining({
            id: 'call_g',
            nameDelta: 'lookup',
            argumentsDelta: '{"query":"x"}',
          }),
        }),
      ]));
      expect(new Set(deltas.map(delta => (delta as { messageId: string }).messageId))).toEqual(
        new Set([result.liveMessageId]),
      );
    });

    test('streams complete media parts without dropping them', async () => {
      geminiGenerateStream.mockResolvedValueOnce((async function* () {
        yield {
          responseId: 'g-image',
          candidates: [{
            content: {
              parts: [{ inlineData: { mimeType: 'image/webp', data: 'BBBB' } }],
            },
          }],
        };
      })());
      const deltas: unknown[] = [];
      const result = await new GeminiAdapter().createStreamCompletion({
        model: { ...MODEL, outputModalities: ['image'] },
        apiKey: 'k',
        messages: MESSAGES,
        temperature: 0,
        onModelDelta: delta => deltas.push(delta),
      });

      expect(result.media).toEqual([
        { type: 'image', mimeType: 'image/webp', data: 'BBBB' },
      ]);
      expect(deltas).toContainEqual(expect.objectContaining({
        mediaPart: { type: 'image', mimeType: 'image/webp', data: 'BBBB' },
      }));
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
