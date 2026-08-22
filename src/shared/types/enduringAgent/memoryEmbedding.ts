/**
 * Memory embedding storage schema (issue #451).
 * Sidecar collection `persona-memory-embeddings` - one record per memory item.
 * Kept separate from MemoryItem to avoid touching the strict schema and recordMigrations gate.
 */

import { z } from 'zod';

import { EnduringAgentIdSchema } from './schemas';

/**
 * A single embedding record for a memory item.
 * Tracks the model used, dimensions, and content digest to detect stale embeddings
 * when the model changes.
 */
export const MemoryEmbeddingSchema = z.object({
  /** Durable Enduring Agent id of the memory item this embedding is for. */
  memoryId: EnduringAgentIdSchema,
  /** Durable Enduring Agent id of the Persona that owns this memory. */
  personaId: EnduringAgentIdSchema,
  /** Embedding model ID (e.g., 'text-embedding-3-small'). */
  modelId: z.string().min(1),
  /** Number of dimensions in the vector. Used to detect model swaps. */
  dimensions: z.number().int().positive(),
  /** SHA256 digest of the memory content at embedding time. Detect invalidation on edit. */
  contentDigest: z.string().length(64),
  /** The embedding vector itself. */
  vector: z.array(z.number()).min(1),
  /** Timestamp when this embedding was created (ms since epoch). */
  createdAt: z.number().int().positive(),
  /** Timestamp when this embedding was last updated (ms since epoch). */
  updatedAt: z.number().int().positive(),
}).strict();

export type MemoryEmbedding = z.infer<typeof MemoryEmbeddingSchema>;

/**
 * Parameters for creating a new memory embedding.
 */
export interface CreateMemoryEmbeddingInput {
  memoryId: string;
  personaId: string;
  modelId: string;
  dimensions: number;
  contentDigest: string;
  vector: number[];
}

/**
 * Result of checking embedding validity.
 */
export interface EmbeddingValidityResult {
  valid: boolean;
  reason?: string; // Why it's invalid (e.g., 'stale: content changed', 'model mismatch')
}
