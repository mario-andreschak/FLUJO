import { Model } from './model';
import OpenAI from 'openai';

/**
 * Base response interface for model service operations
 */
export interface ModelServiceResponse {
  success: boolean;
  error?: string;
}

/**
 * Response for operations that return a list of models
 */
export interface ModelListResponse extends ModelServiceResponse {
  models?: Model[];
}

/**
 * Response for operations that return a single model
 */
export interface ModelOperationResponse extends ModelServiceResponse {
  model?: Model;
}

/**
 * Response for completion generation operations
 * Aligned with OpenAI's response format
 */
export interface CompletionResponse extends ModelServiceResponse {
  content?: string;
  fullResponse?: OpenAI.ChatCompletion;  // Use OpenAI type instead of any
  toolCalls?: Array<{
    name: string;
    args: Record<string, unknown>;  // More specific type than any
    id: string;
    result: string;
  }>;
  newMessages?: OpenAI.ChatCompletionMessageParam[];  // Use OpenAI type
  errorDetails?: {
    message: string;
    name?: string;
    type?: string;  // Added to match OpenAI error format
    code?: string;  // Added to match OpenAI error format
    param?: string; // Added to match OpenAI error format
    status?: number; // HTTP status code
    stack?: string;
  };
}

/**
 * Interface for normalized model data from providers
 */
export interface NormalizedModel {
  id: string;
  name: string;
  description?: string;
}
