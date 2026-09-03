/**
 * Tests for fetchModelsFromProvider() with the LiteLLM provider.
 *
 * LiteLLM uses adapter:'openai', so model listing goes through the generic
 * fetchOpenAIModels path and hits {baseUrl}/models. We mock global fetch to
 * verify the correct URL is called and the response is normalised.
 */

jest.mock('@google/genai', () => {
  const list = jest.fn();
  const GoogleGenAI = jest.fn().mockImplementation(() => ({
    models: { list },
  }));
  return { GoogleGenAI, __list: list };
});

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
  fetchGeminiModels,
  fetchModelsFromProvider,
  fetchOpenAIModels,
  fetchOpenRouterModels,
} from '@/backend/services/model/provider';

const geminiSdkMock = jest.requireMock('@google/genai') as {
  GoogleGenAI: jest.Mock;
  __list: jest.Mock;
};
const MockGoogleGenAI = geminiSdkMock.GoogleGenAI;
const mockGeminiList = geminiSdkMock.__list;

// We need to mock global fetch since fetchOpenAIModels uses it.
const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
  mockGeminiList.mockReset();
  MockGoogleGenAI.mockClear();
});

describe('fetchModelsFromProvider (azure)', () => {
  it('does not query the deployment-scoped inference endpoint for a management-plane catalogue', async () => {
    const models = await fetchModelsFromProvider(
      'azure',
      'https://team.openai.azure.com',
      'azure-key',
    );

    expect(models).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('fetchModelsFromProvider (native Gemini)', () => {
  function pager(models: unknown[]) {
    return {
      async *[Symbol.asyncIterator]() {
        for (const model of models) yield model;
      },
    };
  }

  it('uses the authenticated SDK pager and normalizes all usable pages', async () => {
    mockGeminiList.mockResolvedValue(pager([
      {
        name: 'models/gemini-3.8-flash',
        displayName: 'Gemini 3.8 Flash',
        description: 'Current stable Flash model',
        inputTokenLimit: 1_000_000,
        outputTokenLimit: 65_536,
        supportedActions: ['generateContent', 'countTokens'],
      },
      {
        name: 'models/gemini-3.5-flash-lite',
        displayName: 'Gemini 3.5 Flash-Lite',
        supportedActions: ['generateContent'],
      },
    ]));

    const models = await fetchGeminiModels('gemini-secret');

    expect(MockGoogleGenAI).toHaveBeenCalledWith({ apiKey: 'gemini-secret' });
    expect(mockGeminiList).toHaveBeenCalledWith({ config: { pageSize: 1000 } });
    expect(models).toEqual([
      {
        id: 'gemini-3.5-flash-lite',
        name: 'Gemini 3.5 Flash-Lite',
        visionInputCapability: 'unknown',
      },
      {
        id: 'gemini-3.8-flash',
        name: 'Gemini 3.8 Flash',
        description: 'Current stable Flash model',
        contextWindow: 1_000_000,
        maxTokens: 65_536,
        visionInputCapability: 'unknown',
      },
    ]);
  });

  it('deduplicates records and rejects malformed, specialist, and non-content models', async () => {
    mockGeminiList.mockResolvedValue(pager([
      { name: 'models/gemini-3.8-flash', supportedActions: ['generateContent'] },
      { name: 'gemini-3.8-flash', supportedActions: ['generateContent'] },
      { name: 'models/gemini-3.1-flash-image', supportedActions: ['generateContent'] },
      { name: 'models/gemini-2.5-flash-native-audio-preview', supportedActions: ['generateContent'] },
      { name: 'models/gemini-embedding-2', supportedActions: ['embedContent'] },
      { name: 'models/gemini-unknown' },
      { name: 42, supportedActions: ['generateContent'] },
    ]));

    await expect(fetchGeminiModels('gemini-secret')).resolves.toEqual([
      {
        id: 'gemini-3.8-flash',
        name: 'gemini-3.8-flash',
        visionInputCapability: 'unknown',
      },
    ]);
  });

  it('dispatches native Gemini without calling an OpenAI-compatible URL', async () => {
    mockGeminiList.mockResolvedValue(pager([
      { name: 'models/gemini-3.8-flash', supportedActions: ['generateContent'] },
    ]));

    const models = await fetchModelsFromProvider('gemini', '', 'gemini-secret', 'gemini');

    expect(models.map(model => model.id)).toEqual(['gemini-3.8-flash']);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns an empty result when the SDK fails or no key is available', async () => {
    mockGeminiList.mockRejectedValue(new Error('provider unavailable'));

    await expect(
      fetchModelsFromProvider('gemini', '', 'gemini-secret', 'gemini'),
    ).resolves.toEqual([]);
    await expect(fetchGeminiModels(null)).resolves.toEqual([]);
  });
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
