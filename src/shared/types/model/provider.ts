/**
 * Supported model providers
 */
export type ModelProvider = 
  | 'openai'
  | 'openrouter'
  | 'anthropic'
  | 'gemini'
  | 'mistral'
  | 'xai'
  | 'ollama';

/**
 * Provider information mapping
 */
export interface ProviderInfo {
  id: ModelProvider;
  label: string;
  baseUrl: string;
}

/**
 * Map of providers with their display labels and base URLs
 */
export const PROVIDER_INFO: Record<ModelProvider, Omit<ProviderInfo, 'id'>> = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1'
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1'
  },
  xai: {
    label: 'X.ai',
    baseUrl: 'https://api.x.ai/v1'
  },
  gemini: {
    label: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/'
  },
  anthropic: {
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1/'
  },
  mistral: {
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1'
  },
  ollama: {
    label: 'Ollama',
    baseUrl: 'http://localhost:11434/v1'
  }
};

/**
 * Helper function to get all providers as an array
 */
export function getProvidersArray(): ProviderInfo[] {
  return Object.entries(PROVIDER_INFO).map(([id, info]) => ({
    id: id as ModelProvider,
    ...info
  }));
}
