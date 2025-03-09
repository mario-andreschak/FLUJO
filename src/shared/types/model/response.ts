import { Model } from './model';

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
 */
export interface CompletionResponse extends ModelServiceResponse {
  content?: string;
  fullResponse?: any;
  toolCalls?: Array<{
    name: string;
    args: any;
    id: string;
    result: string;
  }>;
  newMessages?: any[];
  errorDetails?: {
    message: string;
    name?: string;
    stack?: string;
    [key: string]: any;
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
