/**
 * Embedding provider service (issue #451).
 * Generates embeddings for memory content using OpenAI-compatible APIs.
 * Built on the existing createOpenAIClient() helper.
 */

import { createHash } from 'crypto';
import OpenAI from 'openai';

import { Model } from '@/shared/types/model';
import { supportsEmbeddings, EmbeddingCapabilityError, type EmbeddingInput, type EmbeddingOutput } from '@/shared/types/model/embeddings';
import { createLogger } from '@/utils/logger';
import { resolveAndDecryptApiKey } from './encryption';
import { createOpenAIClient } from './openaiClient';

const log = createLogger('backend/services/model/embeddings');

/**
 * Embedding provider service. Uses the existing ModelService infrastructure
 * to select embedding-capable models and route requests to OpenAI-compatible APIs.
 */
export class EmbeddingProvider {
  /**
   * Generate an embedding for a text string using the specified model.
   * Only OpenAI and Azure adapters are supported.
   *
   * @throws EmbeddingCapabilityError if the model does not support embeddings
   * @throws Error if the embedding API call fails
   */
  async embed(model: Model, input: EmbeddingInput): Promise<EmbeddingOutput> {
    // Validate that the model supports embeddings
    if (!supportsEmbeddings(model.adapter)) {
      throw new EmbeddingCapabilityError(
        model.adapter,
        model.id,
        `Model '${model.name}' uses adapter '${model.adapter}' which does not support embeddings. ` +
          `Only 'openai' and 'azure' adapters can generate embeddings.`,
      );
    }

    // Resolve and decrypt the API key
    const apiKey = await resolveAndDecryptApiKey(model.ApiKey);
    if (!apiKey) {
      throw new Error(`No API key configured for embedding model '${model.name}'`);
    }

    // Create the OpenAI client
    const client = createOpenAIClient({
      apiKey,
      baseURL: model.baseUrl,
      defaultHeaders: {
        'User-Agent': 'FLUJO/1.0 (semantic-recall/embeddings)',
      },
    });

    try {
      // Call the embeddings API
      const response = await client.embeddings.create({
        model: input.modelId,
        input: input.text,
        dimensions: input.dimensions,
      });

      // Extract the embedding vector from the response
      const embedding = response.data[0];
      if (!embedding || !embedding.embedding) {
        throw new Error('No embedding returned from API');
      }

      // Compute a content digest for cache invalidation on model swap
      const contentDigest = createHash('sha256').update(input.text).digest('hex');

      return {
        vector: embedding.embedding as number[],
        dimensions: embedding.embedding.length,
        modelId: input.modelId,
        contentDigest,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Failed to generate embedding for model '${model.name}':`, message);
      throw new Error(
        `Embedding generation failed: ${message}. ` +
          `Check that '${input.modelId}' is a valid embedding model for the '${model.adapter}' adapter.`,
      );
    }
  }

  /**
   * Compute cosine similarity between two vectors.
   * Both vectors should be normalized to unit length (which OpenAI embeddings are by default).
   *
   * @param a First vector
   * @param b Second vector
   * @returns Cosine similarity in range [0, 1]
   */
  static cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Vectors must have the same length');
    }
    if (a.length === 0) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    // Vectors are already normalized by OpenAI, but compute anyway for robustness
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }
}

/**
 * Singleton instance of the embedding provider.
 */
let embeddingProvider: EmbeddingProvider | null = null;

/**
 * Get or create the singleton embedding provider instance.
 */
export function getEmbeddingProvider(): EmbeddingProvider {
  if (!embeddingProvider) {
    embeddingProvider = new EmbeddingProvider();
  }
  return embeddingProvider;
}

/**
 * Reset the singleton (used in testing).
 */
export function resetEmbeddingProvider(): void {
  embeddingProvider = null;
}
