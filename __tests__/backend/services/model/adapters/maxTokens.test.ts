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
    interactions: { create: (request: { stream?: boolean }, options: unknown) => request.stream ? generateContentStream(request, options) : generateContent(request, options) },
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
const OWNER_BOUND_MODEL: Model = {
  id: 'owner-model',
  name: 'test-model',
  ApiKey: '',
  provider: 'openai',
  adapter: 'openai',
  ownerCredentialBinding: { ownerId: 'owner', credentialId: 'credential' },
};

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
    geminiGenerate.mockResolvedValue({ id: 'g', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'hi' }] }], usage: { total_input_tokens: 1, total_output_tokens: 2, total_tokens: 3 } });
  });

  describe('direct native adapter owner-credential boundary', () => {
    test.each(['createCompletion', 'createStreamCompletion'] as const)(
      'Anthropic %s rejects an owner-bound model before constructing the SDK client',
      async method => {
        await expect(new AnthropicAdapter()[method]({
          model: OWNER_BOUND_MODEL, apiKey: 'local-secret', messages: MESSAGES,
        })).rejects.toMatchObject({ code: 'execution_owner_model_adapter_unsupported' });
        expect(jest.requireMock('@anthropic-ai/sdk').default).not.toHaveBeenCalled();
        expect(anthropicCreate).not.toHaveBeenCalled();
      },
    );

    test.each(['createCompletion', 'createStreamCompletion'] as const)(
      'Gemini %s rejects an owner-bound model before constructing the SDK client',
      async method => {
        await expect(new GeminiAdapter()[method]({
          model: OWNER_BOUND_MODEL, apiKey: 'local-secret', messages: MESSAGES,
        })).rejects.toMatchObject({ code: 'execution_owner_model_adapter_unsupported' });
        expect(jest.requireMock('@google/genai').GoogleGenAI).not.toHaveBeenCalled();
        expect(geminiGenerate).not.toHaveBeenCalled();
        expect(geminiGenerateStream).not.toHaveBeenCalled();
      },
    );

    test('a malformed binding remains protected on the direct native path', async () => {
      await expect(new AnthropicAdapter().createCompletion({
        model: { ...OWNER_BOUND_MODEL, ownerCredentialBinding: null } as unknown as Model,
        apiKey: 'local-secret', messages: MESSAGES,
      })).rejects.toMatchObject({ code: 'execution_owner_model_adapter_unsupported' });
      expect(jest.requireMock('@anthropic-ai/sdk').default).not.toHaveBeenCalled();
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

  describe('Gemini Interactions adapter', () => {
    test('sends stateless function declarations and an explicit output cap', async () => {
      await new GeminiAdapter().createCompletion({ model: MODEL, apiKey: 'k', messages: MESSAGES, maxTokens: 4321,
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }] });
      expect(geminiGenerate).toHaveBeenCalledWith(expect.objectContaining({ store: false,
        generation_config: { max_output_tokens: 4321 }, tools: [expect.objectContaining({ type: 'function', name: 'lookup', parameters: expect.any(Object) })],
      }), expect.objectContaining({ retries: { strategy: 'none' }, redirect: 'error' }));
    });
    test('omits an unresolved cap and maps thinking levels', async () => {
      await new GeminiAdapter().createCompletion({ model: { ...MODEL, thinkingLevel: 'high' }, apiKey: 'k', messages: MESSAGES });
      expect(geminiGenerate.mock.calls[0][0].generation_config).toEqual({ thinking_level: 'high' });
    });
    test('keeps automatic thinking but refuses to silently discard an old numeric cap', async () => {
      await new GeminiAdapter().createCompletion({ model: { ...MODEL, thinkingBudget: -1 }, apiKey: 'k', messages: MESSAGES });
      expect(geminiGenerate.mock.calls[0][0].generation_config).toEqual({});
      await expect(new GeminiAdapter().createCompletion({ model: { ...MODEL, thinkingBudget: 500 }, apiKey: 'k', messages: MESSAGES })).rejects.toThrow('thinking levels');
      expect(geminiGenerate).toHaveBeenCalledTimes(1);
    });
    test('omits unsupported sampling controls for Argon', async () => {
      await new GeminiAdapter().createCompletion({ model: { ...MODEL, name: 'gemini-4-argon' }, apiKey: 'k', messages: MESSAGES, temperature: 0.2 });
      expect(geminiGenerate.mock.calls[0][0].generation_config).not.toHaveProperty('temperature');
    });
    test('requests and returns multimodal output', async () => {
      geminiGenerate.mockResolvedValueOnce({ id: 'g', status: 'completed', steps: [{ type: 'model_output', content: [
        { type: 'text', text: 'Here it is.' }, { type: 'image', mime_type: 'image/png', data: 'AAAA' },
      ] }] });
      const result = await new GeminiAdapter().createCompletion({ model: { ...MODEL, outputModalities: ['text', 'image'] }, apiKey: 'k', messages: MESSAGES });
      expect(geminiGenerate.mock.calls[0][0].response_modalities).toEqual(['text', 'image']);
      expect(result.completion.choices[0].message.content).toBe('Here it is.');
      expect(result.media).toEqual([{ type: 'image', mimeType: 'image/png', data: 'AAAA' }]);
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
