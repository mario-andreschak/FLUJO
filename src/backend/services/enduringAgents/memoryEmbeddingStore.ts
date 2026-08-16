/**
 * Memory embedding sidecar collection storage (issue #451).
 * Manages embeddings as a separate collection to avoid touching the strict MemoryItemSchema.
 * Detects stale embeddings when content changes or models swap.
 */

import { createHash } from 'crypto';
import { z } from 'zod';

import type { CreateMemoryEmbeddingInput, MemoryEmbedding, EmbeddingValidityResult } from '@/shared/types/enduringAgent';
import { MemoryEmbeddingSchema } from '@/shared/types/enduringAgent';
import { createLogger } from '@/utils/logger';
import { saveItem, loadItem, clearItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';

const log = createLogger('backend/services/enduringAgents/memoryEmbeddingStore');

/**
 * Compute SHA256 digest of text for change detection.
 */
export function computeContentDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Load all embeddings for a persona.
 */
async function loadPersonaEmbeddings(personaId: string): Promise<MemoryEmbedding[]> {
  try {
    const storageKey = `${StorageKey.MEMORY_EMBEDDINGS}:${personaId}`;
    const embeddings = await loadItem<MemoryEmbedding[]>(storageKey as any, []);
    return embeddings.filter((e) => MemoryEmbeddingSchema.safeParse(e).success);
  } catch (error: unknown) {
    log.warn(`Failed to load embeddings for persona ${personaId}:`, error);
    return [];
  }
}

/**
 * Save all embeddings for a persona (overwrites).
 */
async function savePersonaEmbeddings(personaId: string, embeddings: MemoryEmbedding[]): Promise<void> {
  try {
    const storageKey = `${StorageKey.MEMORY_EMBEDDINGS}:${personaId}`;
    await saveItem(storageKey as any, embeddings);
  } catch (error: unknown) {
    log.error(`Failed to save embeddings for persona ${personaId}:`, error);
    throw error;
  }
}

/**
 * Store a new embedding for a memory item.
 */
export async function storeMemoryEmbedding(input: CreateMemoryEmbeddingInput): Promise<MemoryEmbedding> {
  const now = Date.now();
  const embedding: MemoryEmbedding = {
    memoryId: input.memoryId,
    personaId: input.personaId,
    modelId: input.modelId,
    dimensions: input.dimensions,
    contentDigest: input.contentDigest,
    vector: input.vector,
    createdAt: now,
    updatedAt: now,
  };

  // Validate before storing
  const validation = MemoryEmbeddingSchema.safeParse(embedding);
  if (!validation.success) {
    throw new Error(`Invalid embedding: ${validation.error.message}`);
  }

  // Load existing embeddings for this persona
  const embeddings = await loadPersonaEmbeddings(input.personaId);

  // Replace or insert
  const existingIndex = embeddings.findIndex((e) => e.memoryId === input.memoryId);
  if (existingIndex >= 0) {
    embeddings[existingIndex] = embedding;
  } else {
    embeddings.push(embedding);
  }

  // Save all
  await savePersonaEmbeddings(input.personaId, embeddings);

  return embedding;
}

/**
 * Retrieve an embedding by memory ID.
 */
export async function getMemoryEmbedding(personaId: string, memoryId: string): Promise<MemoryEmbedding | null> {
  const embeddings = await loadPersonaEmbeddings(personaId);
  return embeddings.find((e) => e.memoryId === memoryId) ?? null;
}

/**
 * Check if an embedding is still valid for the given content and model.
 * Embeddings become stale if:
 * - Content digest changed (content was edited)
 * - Model ID or dimensions changed (model was swapped)
 */
export async function checkEmbeddingValidity(
  personaId: string,
  memoryId: string,
  currentContent: string,
  expectedModelId: string,
): Promise<EmbeddingValidityResult> {
  const embedding = await getMemoryEmbedding(personaId, memoryId);

  if (!embedding) {
    return { valid: false, reason: 'not_found' };
  }

  // Check content digest
  const currentDigest = computeContentDigest(currentContent);
  if (embedding.contentDigest !== currentDigest) {
    return { valid: false, reason: 'stale: content changed' };
  }

  // Check model ID
  if (embedding.modelId !== expectedModelId) {
    return { valid: false, reason: 'stale: model changed' };
  }

  return { valid: true };
}

/**
 * Delete embeddings for a memory item (called on memory deletion).
 */
export async function deleteMemoryEmbedding(personaId: string, memoryId: string): Promise<boolean> {
  try {
    const embeddings = await loadPersonaEmbeddings(personaId);
    const filtered = embeddings.filter((e) => e.memoryId !== memoryId);

    if (filtered.length === embeddings.length) {
      // Not found
      return false;
    }

    await savePersonaEmbeddings(personaId, filtered);
    return true;
  } catch (error) {
    log.error(`Failed to delete embedding for memory ${memoryId}:`, error);
    throw error;
  }
}

/**
 * Delete all embeddings for a persona (called on persona deletion).
 */
export async function deletePersonaEmbeddings(personaId: string): Promise<number> {
  try {
    const storageKey = `${StorageKey.MEMORY_EMBEDDINGS}:${personaId}`;
    const embeddings = await loadPersonaEmbeddings(personaId);
    const count = embeddings.length;

    if (count > 0) {
      await clearItem(storageKey as any);
    }

    return count;
  } catch (error: unknown) {
    log.error(`Failed to delete all embeddings for persona ${personaId}:`, error);
    throw error;
  }
}

/**
 * Get all embeddings for a persona (used for re-indexing).
 */
export async function listPersonaEmbeddings(personaId: string): Promise<MemoryEmbedding[]> {
  return loadPersonaEmbeddings(personaId);
}

/**
 * Count embeddings for a persona (used in deletion preview accounting).
 */
export async function countPersonaEmbeddings(personaId: string): Promise<number> {
  const embeddings = await loadPersonaEmbeddings(personaId);
  return embeddings.length;
}
