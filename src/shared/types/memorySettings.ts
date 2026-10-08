/**
 * Memory subsystem settings for candidate lifecycle, auto-promotion, and conflict detection.
 * These settings are persisted workspace-wide and can be configured via API or admin UI.
 */

export interface MemorySettings {
  /** Days before untouched candidates are automatically expired. Set to 0 to disable expiry. Default: 7. */
  candidateExpiryDays?: number;

  /** Enable automatic promotion of corroborated candidates to active status. Default: false (off by default for safety). */
  autoPromoteEnabled?: boolean;

  /** Minimum number of independent corroborations required before auto-promotion. Default: 3. */
  autoPromoteMinCorroborations?: number;

  /** Minimum hours a candidate must exist before it can be auto-promoted. Default: 24 (prevents same-session promotion). */
  autoPromoteMinAgeHours?: number;

  /** Enable detection and linking of contradictory facts via conflictsWith. Default: true. */
  conflictDetectionEnabled?: boolean;

  /** Similarity threshold (0-1) for conflict detection via lexical scoring. Default: 0.72. */
  conflictSimilarityThreshold?: number;

  /** Enable semantic memory recall. Default: false to avoid new provider calls for existing workspaces. */
  semanticRecallEnabled?: boolean;

  /** ID of the stored FLUJO Model whose credentials and adapter are used for query embeddings. */
  semanticEmbeddingModelId?: string;

  /** Requested embedding dimensions. Default: 1536. */
  semanticEmbeddingDimensions?: number;

  /** Minimum cosine score for admitting a non-lexical candidate. Default: 0.75. */
  semanticFloor?: number;

  /** Lexical share of an available hybrid score. Default: 0.6. */
  lexicalWeight?: number;

  /** Semantic share of an available hybrid score. Default: 0.4. */
  semanticWeight?: number;
}

export const DEFAULT_MEMORY_SETTINGS: Required<MemorySettings> = {
  candidateExpiryDays: 7,
  autoPromoteEnabled: false,
  autoPromoteMinCorroborations: 3,
  autoPromoteMinAgeHours: 24,
  conflictDetectionEnabled: true,
  conflictSimilarityThreshold: 0.72,
  semanticRecallEnabled: false,
  semanticEmbeddingModelId: '',
  semanticEmbeddingDimensions: 1536,
  semanticFloor: 0.75,
  lexicalWeight: 0.6,
  semanticWeight: 0.4,
};

function unitInterval(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/**
 * Merge stored settings with defaults, handling missing/invalid values gracefully.
 * @param stored Raw settings from storage (may be null, undefined, or partial)
 * @returns Merged settings object with all fields populated from stored values or defaults
 */
export function mergeMemorySettings(stored?: Partial<MemorySettings> | null): Required<MemorySettings> {
  if (!stored || typeof stored !== 'object') {
    return { ...DEFAULT_MEMORY_SETTINGS };
  }
  const lexicalWeight = unitInterval(
    stored.lexicalWeight,
    DEFAULT_MEMORY_SETTINGS.lexicalWeight,
  );
  const semanticWeight = unitInterval(
    stored.semanticWeight,
    DEFAULT_MEMORY_SETTINGS.semanticWeight,
  );
  const weightTotal = lexicalWeight + semanticWeight;

  return {
    candidateExpiryDays: stored.candidateExpiryDays ?? DEFAULT_MEMORY_SETTINGS.candidateExpiryDays,
    autoPromoteEnabled: stored.autoPromoteEnabled ?? DEFAULT_MEMORY_SETTINGS.autoPromoteEnabled,
    autoPromoteMinCorroborations: stored.autoPromoteMinCorroborations ?? DEFAULT_MEMORY_SETTINGS.autoPromoteMinCorroborations,
    autoPromoteMinAgeHours: stored.autoPromoteMinAgeHours ?? DEFAULT_MEMORY_SETTINGS.autoPromoteMinAgeHours,
    conflictDetectionEnabled: stored.conflictDetectionEnabled ?? DEFAULT_MEMORY_SETTINGS.conflictDetectionEnabled,
    conflictSimilarityThreshold: stored.conflictSimilarityThreshold ?? DEFAULT_MEMORY_SETTINGS.conflictSimilarityThreshold,
    semanticRecallEnabled: stored.semanticRecallEnabled === true,
    semanticEmbeddingModelId: typeof stored.semanticEmbeddingModelId === 'string'
      ? stored.semanticEmbeddingModelId.trim()
      : DEFAULT_MEMORY_SETTINGS.semanticEmbeddingModelId,
    semanticEmbeddingDimensions: positiveInteger(
      stored.semanticEmbeddingDimensions,
      DEFAULT_MEMORY_SETTINGS.semanticEmbeddingDimensions,
    ),
    semanticFloor: unitInterval(stored.semanticFloor, DEFAULT_MEMORY_SETTINGS.semanticFloor),
    lexicalWeight: weightTotal > 0
      ? lexicalWeight / weightTotal
      : DEFAULT_MEMORY_SETTINGS.lexicalWeight,
    semanticWeight: weightTotal > 0
      ? semanticWeight / weightTotal
      : DEFAULT_MEMORY_SETTINGS.semanticWeight,
  };
}
