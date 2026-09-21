/**
 * Memory embedding sidecar collection storage (issue #451).
 * Manages embeddings as a separate collection to avoid touching the strict MemoryItemSchema.
 * Detects stale embeddings when content changes or models swap.
 */

import { createHash } from 'crypto';

import type {
  CreateMemoryEmbeddingInput,
  EmbeddingValidityResult,
  MemoryEmbedding,
  MemoryItem,
} from '@/shared/types/enduringAgent';
import { MemoryEmbeddingSchema } from '@/shared/types/enduringAgent';
import { createLogger } from '@/utils/logger';
import {
  clearItem,
  deleteCollectionItem,
  getCollectionItemStats,
  loadCollectionItem,
  loadItem,
  saveCollectionItem,
} from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { workspaceCacheKey } from '@/utils/workspace';

const log = createLogger('backend/services/enduringAgents/memoryEmbeddingStore');
const MEMORY_EMBEDDING_COLLECTION = StorageKey.MEMORY_EMBEDDINGS;

interface PersonaEmbeddingCacheEntry {
  mtimeMs: number;
  sizeBytes: number;
  embeddings: MemoryEmbedding[];
}

declare global {
  var __flujo_persona_embedding_cache: Map<string, PersonaEmbeddingCacheEntry> | undefined;
}

function embeddingCache(): Map<string, PersonaEmbeddingCacheEntry> {
  global.__flujo_persona_embedding_cache ??= new Map();
  return global.__flujo_persona_embedding_cache;
}

function embeddingCacheKey(personaId: string): string {
  return workspaceCacheKey('persona-memory-embeddings', personaId);
}

async function cachePersonaEmbeddings(
  personaId: string,
  embeddings: MemoryEmbedding[],
): Promise<void> {
  const stats = await getCollectionItemStats(MEMORY_EMBEDDING_COLLECTION, personaId);
  if (!stats) {
    embeddingCache().delete(embeddingCacheKey(personaId));
    return;
  }
  embeddingCache().set(embeddingCacheKey(personaId), { ...stats, embeddings });
}

function legacyEmbeddingStorageKey(personaId: string): StorageKey {
  return `${StorageKey.MEMORY_EMBEDDINGS}:${personaId}` as StorageKey;
}

/**
 * Compute SHA256 digest of text for change detection.
 */
export function computeContentDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// Cached parsed records retain object identity between index revisions. Avoid
// hashing the same 50k contents on every warm query. Weak keys do not keep
// evicted records alive; checking the text also fences in-place edits.
const contentDigests = new WeakMap<MemoryItem, { content: string; digest: string }>();

function memoryContentDigest(item: MemoryItem): string {
  const cached = contentDigests.get(item);
  if (cached?.content === item.content) return cached.digest;
  const digest = computeContentDigest(item.content);
  contentDigests.set(item, { content: item.content, digest });
  return digest;
}

/**
 * Load all embeddings for a persona.
 */
async function loadPersonaEmbeddings(personaId: string): Promise<MemoryEmbedding[]> {
  try {
    const stats = await getCollectionItemStats(MEMORY_EMBEDDING_COLLECTION, personaId);
    const cached = embeddingCache().get(embeddingCacheKey(personaId));
    if (
      stats
      && cached
      && cached.mtimeMs === stats.mtimeMs
      && cached.sizeBytes === stats.sizeBytes
    ) {
      return cached.embeddings;
    }
    const stored = await loadCollectionItem<MemoryEmbedding[] | null>(
      MEMORY_EMBEDDING_COLLECTION,
      personaId,
      null,
    );
    const embeddings = stored ?? (process.platform === 'win32'
      ? []
      : await loadItem<MemoryEmbedding[]>(legacyEmbeddingStorageKey(personaId), []));
    const parsed = embeddings.filter((e) => MemoryEmbeddingSchema.safeParse(e).success);
    if (stored !== null) await cachePersonaEmbeddings(personaId, parsed);
    return parsed;
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
    await saveCollectionItem(MEMORY_EMBEDDING_COLLECTION, personaId, embeddings);
    await cachePersonaEmbeddings(personaId, embeddings);
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
    const embeddings = await loadPersonaEmbeddings(personaId);
    const count = embeddings.length;

    if (count > 0) {
      await deleteCollectionItem(MEMORY_EMBEDDING_COLLECTION, personaId);
      embeddingCache().delete(embeddingCacheKey(personaId));
      if (process.platform !== 'win32') {
        await clearItem(legacyEmbeddingStorageKey(personaId));
      }
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

export interface SemanticMemoryScore {
  readonly available: true;
  readonly score: number;
}

/**
 * Join an already-loaded Persona sidecar to candidate items without N+1 storage
 * reads. Invalid, stale, foreign, or incompatible vectors are simply absent.
 */
export function buildSemanticMemoryScores(
  personaId: string,
  items: readonly MemoryItem[],
  embeddings: readonly MemoryEmbedding[],
  queryVector: readonly number[],
  expectedModelId: string,
): Map<string, SemanticMemoryScore> {
  const finite = Number.isFinite;
  const sqrt = Math.sqrt;
  if (queryVector.length === 0 || !queryVector.every(finite)) return new Map();
  // The query is constant across the batch. Compute its norm once, and join
  // vector validation, dot product and candidate norm in a single pass.
  let querySquaredNorm = 0;
  for (const value of queryVector) querySquaredNorm += value * value;
  const queryNorm = sqrt(querySquaredNorm);

  // Avoid allocating a temporary pair array for every candidate on each query.
  const embeddingByMemoryId = new Map<string, MemoryEmbedding>();
  for (const embedding of embeddings) embeddingByMemoryId.set(embedding.memoryId, embedding);
  const scores = new Map<string, SemanticMemoryScore>();

  for (const item of items) {
    const embedding = embeddingByMemoryId.get(item.id);
    if (!embedding) continue;
    if (embedding.personaId !== personaId) continue;
    if (embedding.modelId !== expectedModelId) continue;
    if (embedding.contentDigest !== memoryContentDigest(item)) continue;
    if (embedding.dimensions !== queryVector.length) continue;
    if (embedding.vector.length !== queryVector.length) continue;
    let dot = 0;
    let squaredNorm = 0;
    let valid = true;
    for (let index = 0; index < queryVector.length; index += 1) {
      const value = embedding.vector[index];
      if (!finite(value)) { valid = false; break; }
      dot += queryVector[index] * value;
      squaredNorm += value * value;
    }
    if (!valid) continue;
    const denominator = queryNorm * sqrt(squaredNorm);
    const cosine = denominator === 0 ? 0 : dot / denominator;
    if (!finite(cosine)) continue;
    scores.set(item.id, {
      available: true,
      score: cosine < 0 ? 0 : cosine > 1 ? 1 : cosine,
    });
  }

  return scores;
}

/**
 * Count embeddings for a persona (used in deletion preview accounting).
 */
export async function countPersonaEmbeddings(personaId: string): Promise<number> {
  const embeddings = await loadPersonaEmbeddings(personaId);
  return embeddings.length;
}
