/**
 * Embedding provider types and capabilities.
 * Only OpenAI-shaped adapters (openai/azure) support embeddings;
 * native Gemini/Anthropic and CLI-backed adapters are explicitly rejected.
 */

import type { ModelAdapter, ModelProvider } from './provider';

/**
 * Embedding models supported by compatible providers.
 * Each model carries its default vector dimensions and cost profile.
 */
export interface EmbeddingModelInfo {
  /** Model identifier (e.g., 'text-embedding-3-small'). */
  modelId: string;
  /** Default vector dimensions (e.g., 1536 for text-embedding-3-small). */
  dimensions: number;
  /** Provider that hosts this model. */
  provider: EmbeddingCapableProvider;
  /** Cost per 1M input tokens (cents). */
  costPer1MTokens?: number;
}

/**
 * Providers capable of generating embeddings via OpenAI-shaped APIs.
 * CLI-backed models (codex-cli, claude-cli) and native Gemini/Anthropic
 * adapters are explicitly not supported.
 */
export type EmbeddingCapableProvider = 'openai' | 'azure';

/**
 * Embedding capability gate: checks whether a model adapter can produce embeddings.
 * Only returns true for adapters that expose .embeddings.create via OpenAI SDK.
 */
export function supportsEmbeddings(adapter: ModelAdapter | undefined): adapter is 'openai' | 'azure' {
  return adapter === 'openai' || adapter === 'azure';
}

/**
 * Error raised when attempting to use embeddings with an unsupported adapter.
 * This is a typed capability error, not a runtime 400 from the provider.
 */
export class EmbeddingCapabilityError extends Error {
  constructor(
    public readonly adapter: ModelAdapter | undefined,
    public readonly modelId: string,
    message: string,
  ) {
    super(message);
    this.name = 'EmbeddingCapabilityError';
  }
}

/**
 * Embedding request / response types for the embedding provider.
 */
export interface EmbeddingInput {
  /** Text to embed (single string, not batch). */
  text: string;
  /** Model ID (must be an embedding model, not a completion model). */
  modelId: string;
  /** Optional: dimensions to request (some models support it). */
  dimensions?: number;
}

export interface EmbeddingOutput {
  /** Vector embedding (normalized to unit length for cosine similarity). */
  vector: number[];
  /** Number of dimensions in the vector. */
  dimensions: number;
  /** Model ID used. */
  modelId: string;
  /** Digest of the input text (for cache invalidation on content change). */
  contentDigest: string;
}

/**
 * Known embedding models by provider.
 * Used for validation and capability detection.
 */
export const EMBEDDING_MODELS: Record<EmbeddingCapableProvider, EmbeddingModelInfo[]> = {
  openai: [
    {
      modelId: 'text-embedding-3-small',
      dimensions: 1536,
      provider: 'openai',
      costPer1MTokens: 0.02,
    },
    {
      modelId: 'text-embedding-3-large',
      dimensions: 3072,
      provider: 'openai',
      costPer1MTokens: 0.13,
    },
    {
      modelId: 'text-embedding-ada-002',
      dimensions: 1536,
      provider: 'openai',
      costPer1MTokens: 0.10,
    },
  ],
  azure: [
    {
      modelId: 'text-embedding-3-small',
      dimensions: 1536,
      provider: 'azure',
    },
    {
      modelId: 'text-embedding-3-large',
      dimensions: 3072,
      provider: 'azure',
    },
  ],
};

/**
 * Check if a model ID is a valid embedding model for the given provider.
 */
export function isValidEmbeddingModel(
  provider: EmbeddingCapableProvider,
  modelId: string,
): boolean {
  return EMBEDDING_MODELS[provider]?.some((m) => m.modelId === modelId) ?? false;
}

/**
 * Get embedding model info (dimensions, cost, etc.) for validation.
 */
export function getEmbeddingModelInfo(
  provider: EmbeddingCapableProvider,
  modelId: string,
): EmbeddingModelInfo | undefined {
  return EMBEDDING_MODELS[provider]?.find((m) => m.modelId === modelId);
}
