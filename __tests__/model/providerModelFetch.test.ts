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
    });
    // Model without explicit name/description gets sensible defaults.
    expect(models[1]).toEqual({
      id: 'anthropic/claude-sonnet-4-20250514',
      name: 'anthropic/claude-sonnet-4-20250514',
      description: 'Model anthropic/claude-sonnet-4-20250514',
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
