import { PROVIDER_INFO, getProvidersArray } from '../provider';

describe('Model Provider Types', () => {
  describe('PROVIDER_INFO', () => {
    test('should have all required providers', () => {
      expect(PROVIDER_INFO).toHaveProperty('openai');
      expect(PROVIDER_INFO).toHaveProperty('anthropic');
      expect(PROVIDER_INFO).toHaveProperty('gemini');
      expect(PROVIDER_INFO).toHaveProperty('mistral');
      expect(PROVIDER_INFO).toHaveProperty('xai');
      expect(PROVIDER_INFO).toHaveProperty('ollama');
      expect(PROVIDER_INFO).toHaveProperty('openrouter');
    });

    test('each provider should have required properties', () => {
      Object.entries(PROVIDER_INFO).forEach(([id, info]) => {
        expect(info).toHaveProperty('label');
        expect(info).toHaveProperty('baseUrl');
        expect(typeof info.label).toBe('string');
        expect(typeof info.baseUrl).toBe('string');
      });
    });

    test('should have correct base URLs', () => {
      expect(PROVIDER_INFO.openai.baseUrl).toBe('https://api.openai.com/v1');
      expect(PROVIDER_INFO.anthropic.baseUrl).toBe('https://api.anthropic.com/v1/');
      expect(PROVIDER_INFO.ollama.baseUrl).toBe('http://localhost:11434/v1');
    });
  });

  describe('getProvidersArray', () => {
    test('should return array with all providers', () => {
      const providers = getProvidersArray();
      expect(providers).toHaveLength(Object.keys(PROVIDER_INFO).length);
      
      providers.forEach(provider => {
        expect(provider).toHaveProperty('id');
        expect(provider).toHaveProperty('label');
        expect(provider).toHaveProperty('baseUrl');
        expect(PROVIDER_INFO[provider.id].label).toBe(provider.label);
      });
    });
  });
}); 