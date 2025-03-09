import { createLogger } from '@/utils/logger';
import { NormalizedModel } from '@/shared/types/model';
import { ModelProvider } from '@/shared/types/model/provider';

// Create a logger instance for this file
const log = createLogger('backend/services/model/provider');

/**
 * Determine the provider from the base URL
 */
export function getProviderFromBaseUrl(baseUrl: string): ModelProvider {
  if (baseUrl.includes('openrouter.ai')) {
    return 'openrouter';
  } else if (baseUrl.includes('api.openai.com')) {
    return 'openai';
  } else if (baseUrl.includes('api.x.ai')) {
    return 'xai';
  } else if (baseUrl.includes('generativelanguage.googleapis.com')) {
    return 'gemini';
  } else if (baseUrl.includes('api.anthropic.com')) {
    return 'anthropic';
  } else if (baseUrl.includes('api.mistral.ai')) {
    return 'mistral';
  } else if (baseUrl.toLowerCase().includes('/v1') && !baseUrl.includes('api.openai.com')) {
    // Check if the URL follows the pattern used by Ollama (ends with /v1)
    // But ensure it's not just the OpenAI API with a custom domain
    return 'ollama';
  } else {
    // Default to openai if unknown
    return 'openai';
  }
}

/**
 * Fetch models from OpenRouter
 */
export async function fetchOpenRouterModels(): Promise<NormalizedModel[]> {
  log.debug('fetchOpenRouterModels: Entering method');
  const response = await fetch('https://openrouter.ai/api/v1/models', {
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  });
  
  if (!response.ok) {
    throw new Error(`OpenRouter API error: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json();
  
  if (!data.data || !Array.isArray(data.data)) {
    return [];
  }
  
  return data.data.map((model: any) => ({
    id: model.id,
    name: model.name || model.id,
    description: model.description
  }));
}

/**
 * Fetch models from OpenAI
 */
export async function fetchOpenAIModels(apiKey: string | null, baseUrl: string): Promise<NormalizedModel[]> {
  log.debug('fetchOpenAIModels: Entering method');
  
  // Ensure baseUrl ends with /v1
  let modelsUrl = baseUrl;
  if (!modelsUrl.endsWith('/v1')) {
    modelsUrl = modelsUrl.endsWith('/') ? `${modelsUrl}v1` : `${modelsUrl}/v1`;
  }
  modelsUrl = `${modelsUrl}/models`;
  
  log.debug(`Fetching models from: ${modelsUrl}`);
  
  // Prepare headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  
  // Add Authorization header if API key is provided (OpenRouter doesn't require it for listing models)
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  
  try {
    const response = await fetch(modelsUrl, { headers });
    
    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    
    // Try parsing as standard OpenAI format
    if (data.data && Array.isArray(data.data)) {
      log.debug('Successfully parsed response in standard OpenAI format');
      
      // For OpenAI, filter to only include chat models
      if (baseUrl.includes('api.openai.com')) {
        return data.data
          .filter((model: any) => model.id.includes('gpt'))
          .map((model: any) => ({
            id: model.id,
            name: model.id,
            description: `OpenAI ${model.id}`
          }));
      }
      
      // For other providers using OpenAI format (like OpenRouter)
      return data.data
        .filter((model: any) => model.id)
        .map((model: any) => ({
          id: model.id,
          name: model.name || model.id,
          description: model.description || `Model ${model.id}`
        }));
    }
    // Fallback for Ollama format
    else if (data.object === 'list' && Array.isArray(data.data)) {
      log.debug('Parsing response in Ollama format');
      return data.data.map((model: any) => ({
        id: model.id,
        name: model.id,
        description: `${model.owned_by ? `${model.owned_by}: ` : ''}${model.id}`
      }));
    }
    
    // If we can't parse the response in any known format, return an empty array
    log.warn('Could not parse API response in any known format', { data });
    return [];
  } catch (error) {
    log.error(`Error fetching models from ${modelsUrl}:`, error);
    throw error;
  }
}

/**
 * Fetch models from X.AI
 */
export async function fetchXAIModels(apiKey: string | null): Promise<NormalizedModel[]> {
  log.debug('fetchXAIModels: Entering method');
  if (!apiKey) {
    throw new Error('API key is required for X.AI');
  }
  
  // X.AI doesn't have a models endpoint, so we return a static list
  return [
    {
      id: 'grok-1',
      name: 'Grok-1',
      description: 'X.AI Grok-1 model'
    }
  ];
}

/**
 * Fetch models from Gemini
 */
export async function fetchGeminiModels(apiKey: string | null): Promise<NormalizedModel[]> {
  log.debug('fetchGeminiModels: Entering method');
  if (!apiKey) {
    throw new Error('API key is required for Gemini');
  }
  
  // Gemini doesn't have a simple models endpoint, so we return a static list
  return [
    {
      id: 'gemini-pro',
      name: 'Gemini Pro',
      description: 'Google Gemini Pro model'
    },
    {
      id: 'gemini-ultra',
      name: 'Gemini Ultra',
      description: 'Google Gemini Ultra model'
    }
  ];
}

/**
 * Fetch models from Anthropic
 */
export async function fetchAnthropicModels(apiKey: string | null): Promise<NormalizedModel[]> {
  log.debug('fetchAnthropicModels: Entering method');
  if (!apiKey) {
    throw new Error('API key is required for Anthropic');
  }
  
  // Anthropic doesn't have a models endpoint, so we return a static list
  return [
    {
      id: 'claude-3-opus-20240229',
      name: 'Claude 3 Opus',
      description: 'Anthropic Claude 3 Opus - Most powerful model'
    },
    {
      id: 'claude-3-sonnet-20240229',
      name: 'Claude 3 Sonnet',
      description: 'Anthropic Claude 3 Sonnet - Balanced model'
    },
    {
      id: 'claude-3-haiku-20240307',
      name: 'Claude 3 Haiku',
      description: 'Anthropic Claude 3 Haiku - Fast and efficient model'
    }
  ];
}

/**
 * Fetch models from Mistral
 */
export async function fetchMistralModels(apiKey: string | null): Promise<NormalizedModel[]> {
  log.debug('fetchMistralModels: Entering method');
  if (!apiKey) {
    throw new Error('API key is required for Mistral');
  }
  
  // Mistral models
  return [
    {
      id: 'mistral-tiny',
      name: 'Mistral Tiny',
      description: 'Mistral Tiny model'
    },
    {
      id: 'mistral-small',
      name: 'Mistral Small',
      description: 'Mistral Small model'
    },
    {
      id: 'mistral-medium',
      name: 'Mistral Medium',
      description: 'Mistral Medium model'
    },
    {
      id: 'mistral-large-latest',
      name: 'Mistral Large',
      description: 'Mistral Large model'
    }
  ];
}

/**
 * Fetch models from the specified provider
 */
export async function fetchModelsFromProvider(
  provider: ModelProvider, 
  baseUrl: string, 
  apiKey: string | null
): Promise<NormalizedModel[]> {
  log.debug(`fetchModelsFromProvider: Fetching models for provider: ${provider}`);
  
  try {
    switch (provider) {
      case 'openrouter':
        return await fetchOpenRouterModels();
      
      case 'openai':
      case 'ollama':
        return await fetchOpenAIModels(apiKey, baseUrl);
      
      case 'xai':
        return await fetchXAIModels(apiKey);
      
      case 'gemini':
        return await fetchGeminiModels(apiKey);
      
      case 'anthropic':
        return await fetchAnthropicModels(apiKey);
        
      case 'mistral':
        return await fetchMistralModels(apiKey);
      
      default:
        // Try using OpenAI-compatible API as a fallback for unknown providers
        log.info(`Unknown provider "${provider}", attempting to use OpenAI-compatible API`);
        return await fetchOpenAIModels(apiKey, baseUrl);
    }
  } catch (error) {
    log.error(`fetchModelsFromProvider: Error fetching models for provider ${provider}:`, error);
    throw error;
  }
}
