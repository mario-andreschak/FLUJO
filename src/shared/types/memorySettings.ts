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
}

export const DEFAULT_MEMORY_SETTINGS: Required<MemorySettings> = {
  candidateExpiryDays: 7,
  autoPromoteEnabled: false,
  autoPromoteMinCorroborations: 3,
  autoPromoteMinAgeHours: 24,
  conflictDetectionEnabled: true,
  conflictSimilarityThreshold: 0.72,
};

/**
 * Merge stored settings with defaults, handling missing/invalid values gracefully.
 * @param stored Raw settings from storage (may be null, undefined, or partial)
 * @returns Merged settings object with all fields populated from stored values or defaults
 */
export function mergeMemorySettings(stored?: Partial<MemorySettings> | null): Required<MemorySettings> {
  if (!stored || typeof stored !== 'object') {
    return { ...DEFAULT_MEMORY_SETTINGS };
  }
  return {
    candidateExpiryDays: stored.candidateExpiryDays ?? DEFAULT_MEMORY_SETTINGS.candidateExpiryDays,
    autoPromoteEnabled: stored.autoPromoteEnabled ?? DEFAULT_MEMORY_SETTINGS.autoPromoteEnabled,
    autoPromoteMinCorroborations: stored.autoPromoteMinCorroborations ?? DEFAULT_MEMORY_SETTINGS.autoPromoteMinCorroborations,
    autoPromoteMinAgeHours: stored.autoPromoteMinAgeHours ?? DEFAULT_MEMORY_SETTINGS.autoPromoteMinAgeHours,
    conflictDetectionEnabled: stored.conflictDetectionEnabled ?? DEFAULT_MEMORY_SETTINGS.conflictDetectionEnabled,
    conflictSimilarityThreshold: stored.conflictSimilarityThreshold ?? DEFAULT_MEMORY_SETTINGS.conflictSimilarityThreshold,
  };
}
