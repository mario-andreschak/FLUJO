import { 
  getProviderFromBaseUrl, 
  fetchOpenRouterModels, 
  fetchOpenAIModels, 
  fetchModelsFromProvider 
} from '../provider';

// Mock the logger
jest.mock('@/utils/logger', () => ({
  createLogger: jest.fn(() => ({
    debug: jest.fn(),
    verbose: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }))
}));

// Mock fetch
const mockFetch = jest.fn();
Object.defineProperty(global, 'fetch', {
  value: mockFetch,
  writable: true
});

describe('Model Provider', () => {
  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();
  });

  describe('getProviderFromBaseUrl', () => {
    it('should identify openrouter provider from URL', () => {
      expect(getProviderFromBaseUrl('https://openrouter.ai/api')).toBe('openrouter');
    });

    it('should identify xai provider from URL', () => {
      expect(getProviderFromBaseUrl('https://api.x.ai/v1')).toBe('xai');
    });

    it('should identify gemini provider from URL', () => {
      expect(getProviderFromBaseUrl('https://generativelanguage.googleapis.com/v1')).toBe('gemini');
    });

    it('should identify anthropic provider from URL', () => {
      expect(getProviderFromBaseUrl('https://api.anthropic.com/v1')).toBe('anthropic');
    });

    it('should identify mistral provider from URL', () => {
      expect(getProviderFromBaseUrl('https://api.mistral.ai/v1')).toBe('mistral');
    });

    it('should identify openai provider from URL', () => {
      expect(getProviderFromBaseUrl('https://api.openai.com/v1')).toBe('openai');
    });

    it('should identify ollama provider from URL', () => {
      expect(getProviderFromBaseUrl('http://localhost:11434')).toBe('ollama');
    });

    it('should default to ollama for unknown URLs', () => {
      expect(getProviderFromBaseUrl('https://unknown-provider.com')).toBe('ollama');
    });
  });

  describe('fetchOpenRouterModels', () => {
    it('should fetch and normalize OpenRouter models', async () => {
      const mockModels = {
        data: [
          { id: 'model1', name: 'Model 1', description: 'Description 1' },
          { id: 'model2', name: 'Model 2', description: 'Description 2' }
        ]
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockModels)
      });

      const result = await fetchOpenRouterModels();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/models',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          })
        })
      );

      expect(result).toEqual(mockModels.data);
    });

    it('should handle API errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found'
      });

      await expect(fetchOpenRouterModels()).rejects.toThrow('OpenRouter API error: 404 Not Found');
    });

    it('should handle invalid response data', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ invalid: 'data' })
      });

      const result = await fetchOpenRouterModels();
      expect(result).toEqual([]);
    });
  });

  describe('fetchOpenAIModels', () => {
    const baseUrl = 'https://api.openai.com/v1';
    const apiKey = 'test-api-key';

    it('should fetch and normalize OpenAI models', async () => {
      const mockModels = {
        data: [
          { id: 'gpt-4', name: 'GPT-4' },
          { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo' },
          { id: 'non-gpt-model', name: 'Other Model' }
        ]
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockModels)
      });

      const result = await fetchOpenAIModels(apiKey, baseUrl);

      expect(mockFetch).toHaveBeenCalledWith(
        `${baseUrl}/models`,
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          })
        })
      );

      expect(result).toEqual([
        { id: 'gpt-4', name: 'gpt-4', description: 'OpenAI gpt-4' },
        { id: 'gpt-3.5-turbo', name: 'gpt-3.5-turbo', description: 'OpenAI gpt-3.5-turbo' },
        { id: 'non-gpt-model', name: 'non-gpt-model', description: 'OpenAI non-gpt-model' }
      ]);
    });

    it('should handle Anthropic API differently', async () => {
      const anthropicUrl = 'https://api.anthropic.com/v1';
      const mockModels = {
        data: [
          { id: 'claude-3', name: 'Claude 3' }
        ]
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockModels)
      });

      await fetchOpenAIModels(apiKey, anthropicUrl);

      expect(mockFetch).toHaveBeenCalledWith(
        `${anthropicUrl}/models`,
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          })
        })
      );
    });

    it('should handle Ollama format', async () => {
      const ollamaUrl = 'http://localhost:11434/api';
      const mockModels = {
        object: 'list',
        data: [
          { id: 'llama2', owned_by: 'Meta' }
        ]
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockModels)
      });

      const result = await fetchOpenAIModels(null, ollamaUrl);

      expect(result).toEqual([{
        id: 'llama2',
        name: 'llama2',
        description: 'Model llama2'
      }]);
    });

    it('should handle API errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized'
      });

      await expect(fetchOpenAIModels(apiKey, baseUrl)).rejects.toThrow('API error: 401 Unauthorized');
    });

    it('should handle unknown response formats', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ unknown: 'format' })
      });

      const result = await fetchOpenAIModels(apiKey, baseUrl);
      expect(result).toEqual([]);
    });
  });

  describe('fetchModelsFromProvider', () => {
    it('should use OpenRouter API for OpenRouter provider', async () => {
      const mockModels = [{ id: 'model1', name: 'Model 1' }];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: mockModels })
      });

      const result = await fetchModelsFromProvider('openrouter', 'https://openrouter.ai/api', null);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/models',
        expect.any(Object)
      );
      expect(result).toEqual(mockModels);
    });

    it('should use OpenAI-compatible API for other providers', async () => {
      const mockModels = {
        data: [{ id: 'gpt-4', name: 'GPT-4' }]
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockModels)
      });

      const result = await fetchModelsFromProvider('openai', 'https://api.openai.com/v1', 'test-key');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/models',
        expect.any(Object)
      );
      expect(result[0].id).toBe('gpt-4');
    });

    it('should handle errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await fetchModelsFromProvider('openai', 'https://api.openai.com/v1', 'test-key');
      expect(result).toEqual([]);
    });
  });
}); 