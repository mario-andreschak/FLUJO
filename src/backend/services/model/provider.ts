import { createLogger } from '@/utils/logger';
import { NormalizedModel } from '@/shared/types/model';
import { ModelProvider } from '@/shared/types/model/provider';

// Create a logger instance for this file
const log = createLogger('backend/services/model/provider');

/**
 * Determine the provider from the base URL
 * Maps each URL pattern to its corresponding provider
 */
export function getProviderFromBaseUrl(baseUrl: string): ModelProvider {
  if (baseUrl.includes('openrouter.ai')) {
    return 'openrouter';
  } else if (baseUrl.includes('api.x.ai')) {
    return 'xai';
  } else if (baseUrl.includes('generativelanguage.googleapis.com')) {
    return 'gemini';
  } else if (baseUrl.includes('api.anthropic.com')) {
    return 'anthropic';
  } else if (baseUrl.includes('api.mistral.ai')) {
    return 'mistral';
  } else if (baseUrl.includes('api.openai.com')) {
    return 'openai';
  } else {
    return 'ollama';
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
 * Fetch models from the specified provider
 * Since most providers are now OpenAI-compatible, we only need special handling
 * for OpenRouter, and use the OpenAI-compatible API for everything else
 */
export async function fetchModelsFromProvider(
  provider: ModelProvider, 
  baseUrl: string, 
  apiKey: string | null
): Promise<NormalizedModel[]> {
  log.debug(`fetchModelsFromProvider: Fetching models for provider: ${provider}`);
  
  try {
    // Only OpenRouter has a special endpoint for fetching models
    if (provider === 'openrouter') {
      return await fetchOpenRouterModels();
    }
    
    // For all other providers (including Ollama), use the OpenAI-compatible API
    return await fetchOpenAIModels(apiKey, baseUrl);
  } catch (error) {
    log.error(`fetchModelsFromProvider: Error fetching models for provider ${provider}:`, error);
    // Return empty array instead of throwing to avoid UI errors
    return [];
  }
}
