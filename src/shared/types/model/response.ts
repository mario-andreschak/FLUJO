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
 * Result of a single transport attempt (SDK or axios) inside a model test.
 */
export interface ModelTestAttempt {
  ok: boolean;
  /** HTTP status code, when one was received. */
  status?: number;
  /** Wall-clock duration of the attempt in milliseconds. */
  durationMs: number;
  /** Assistant content returned on success (trimmed). */
  content?: string;
  /** Token usage reported by the provider, if any. */
  usage?: Record<string, unknown>;
  /** Verbose error payload on failure. */
  error?: {
    name?: string;
    message: string;
    status?: number;
    code?: string;
    type?: string;
    param?: string;
    retryAfter?: string;
    /** Selected response headers (rate-limit hints etc.). */
    headers?: Record<string, string>;
    /** Parsed provider error body, when available. */
    body?: unknown;
    stack?: string;
  };
}

/**
 * Verbose result of a direct (no flow engine) model connectivity test, used by
 * the "Test" button on the Models page. Runs the request through the hardened
 * OpenAI SDK client and, independently, through axios so transport issues such
 * as "Premature close" can be told apart from genuine provider errors.
 */
export interface ModelTestResult {
  ok: boolean;
  model: string;
  baseUrl?: string;
  provider?: string;
  /** Result of the OpenAI SDK attempt (the path flows actually use). */
  sdk: ModelTestAttempt;
  /** Result of the independent axios attempt (cross-check). */
  axios: ModelTestAttempt;
  /** Human-readable summary of what the two attempts imply. */
  diagnosis: string;
}

/**
 * Interface for normalized model data from providers
 */
export interface NormalizedModel {
  id: string;
  name: string;
  description?: string;
}
