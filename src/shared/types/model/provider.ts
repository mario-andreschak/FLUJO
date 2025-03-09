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
 * Provider-specific configuration
 */
export interface ProviderConfig {
  baseUrl: string;
  apiVersion?: string;
  defaultModel?: string;
}

/**
 * Provider API request options
 */
export interface ProviderRequestOptions {
  headers?: Record<string, string>;
  timeout?: number;
  retries?: number;
}

/**
 * Provider-specific completion request parameters
 */
export interface CompletionRequestParams {
  model: string;
  messages: Array<{
    role: string;
    content: string;
  }>;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string[];
  [key: string]: any; // Allow for provider-specific parameters
}
