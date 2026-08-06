/**
 * Tests for fetchModelsFromProvider() with the LiteLLM provider.
 *
 * LiteLLM uses adapter:'openai', so model listing goes through the generic
 * fetchOpenAIModels path and hits {baseUrl}/models. We mock global fetch to
 * verify the correct URL is called and the response is normalised.
 */

// Suppress the logger to keep test output clean.
jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    verbose: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import {
  fetchModelsFromProvider,
  fetchOpenAIModels,
  fetchOpenRouterModels,
} from '@/backend/services/model/provider';

// We need to mock global fetch since fetchOpenAIModels uses it.
const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

describe('fetchModelsFromProvider (litellm)', () => {
  const litellmBaseUrl = 'http://localhost:4000/v1';
  const litellmApiKey = 'sk-litellm-master-key';

  it('calls {baseUrl}/models for the litellm provider', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: 'gpt-4o', name: 'GPT-4o' },
          { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet' },
        ],
      }),
    });

    const models = await fetchModelsFromProvider('litellm', litellmBaseUrl, litellmApiKey);

    // The function should call /v1/models (baseUrl + /models).
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).toBe('http://localhost:4000/v1/models');
  });

  it('returns normalised model objects from the LiteLLM proxy', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: 'azure/gpt-4o', name: 'Azure GPT-4o', description: 'GPT-4o via Azure' },
          { id: 'anthropic/claude-sonnet-4-20250514' },
        ],
      }),
    });

    const models = await fetchModelsFromProvider('litellm', litellmBaseUrl, litellmApiKey);

    expect(models).toHaveLength(2);
    expect(models[0]).toEqual({
      id: 'azure/gpt-4o',
      name: 'Azure GPT-4o',
      description: 'GPT-4o via Azure',
      visionInputCapability: 'unknown',
    });
    // Model without explicit name/description gets sensible defaults.
    expect(models[1]).toEqual({
      id: 'anthropic/claude-sonnet-4-20250514',
      name: 'anthropic/claude-sonnet-4-20250514',
      description: 'Model anthropic/claude-sonnet-4-20250514',
      visionInputCapability: 'unknown',
    });
  });

  it('sends Bearer auth header with the LiteLLM master key', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });

    await fetchModelsFromProvider('litellm', litellmBaseUrl, litellmApiKey);

    const headers = mockFetch.mock.calls[0][1]?.headers;
    expect(headers).toMatchObject({
      Authorization: `Bearer ${litellmApiKey}`,
    });
  });

  it('returns an empty array when the proxy returns no models', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });

    const models = await fetchModelsFromProvider('litellm', litellmBaseUrl, litellmApiKey);
    expect(models).toEqual([]);
  });

  it('returns an empty array (not throw) when the proxy is unreachable', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const models = await fetchModelsFromProvider('litellm', litellmBaseUrl, litellmApiKey);
    expect(models).toEqual([]);
  });
});

describe('fetchOpenAIModels with a custom LiteLLM base URL', () => {
  it('works with a trailing-slash base URL', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'model-a' }] }),
    });

    await fetchOpenAIModels('sk-key', 'http://litellm.internal:4000/v1/');

    expect(mockFetch.mock.calls[0][0]).toBe('http://litellm.internal:4000/v1/models');
  });

  it('works with a non-standard LiteLLM proxy path', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'model-b' }] }),
    });

    await fetchOpenAIModels('sk-key', 'https://gateway.corp.io/litellm/v1');

    expect(mockFetch.mock.calls[0][0]).toBe('https://gateway.corp.io/litellm/v1/models');
  });
});

describe('fetchOpenRouterModels capability discovery', () => {
  it('requests all output modalities and normalizes context, token, tool, and modality metadata', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{
          id: 'google/gemini-3.1-flash-lite-image',
          name: 'Gemini 3.1 Flash Lite Image',
          description: 'Image model',
          context_length: 65536,
          supported_parameters: ['temperature', 'response_format'],
          architecture: {
            input_modalities: ['text', 'image'],
            output_modalities: ['text', 'image'],
          },
          top_provider: { max_completion_tokens: 65536 },
        }],
      }),
    });

    const models = await fetchOpenRouterModels();

    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://openrouter.ai/api/v1/models?output_modalities=all',
    );
    expect(models[0]).toEqual({
      id: 'google/gemini-3.1-flash-lite-image',
      name: 'Gemini 3.1 Flash Lite Image',
      description: 'Image model',
      contextWindow: 65536,
      maxTokens: 65536,
      supportsTools: false,
      supportedParameters: ['temperature', 'response_format'],
      inputModalities: ['text', 'image'],
      outputModalities: ['text', 'image'],
      visionInputCapability: 'supported',
    });
  });

  it('marks OpenRouter models advertising tools as tool-capable', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{
          id: 'tool-model',
          supported_parameters: ['tools', 'tool_choice'],
        }],
      }),
    });

    const [model] = await fetchOpenRouterModels();
    expect(model.supportsTools).toBe(true);
  });
});
