/**
 * Resolve the effective summarizing-compaction configuration for a Process-node
 * model call (issue #248).
 *
 * Precedence mirrors `resolveEffectiveMaxTokens`:
 *   enabled       : on unless the node is explicitly `compactionMode:'off'`.
 *   keepTokens    : per-node override → global `compactionKeepTokens` → default.
 *   bufferTokens  : global `compactionBufferTokens` → default.
 *   threshold     : per-model `compactionThreshold` override (absolute prompt-token
 *                   figure at/above which pre-flight compaction triggers); when
 *                   unset the trigger is derived from contextWindow − buffer.
 */

// Target 30-60% context usage: bufferTokens = 40% of context window (e.g., 50k for 128k window)
// keepTokens = 15% of context window (e.g., 19k for 128k window)
export const DEFAULT_COMPACTION_BUFFER_TOKENS = 50000;  // ~40% of 128k context
export const DEFAULT_COMPACTION_KEEP_TOKENS = 19000;    // ~15% of 128k context

export interface EffectiveCompaction {
  enabled: boolean;
  keepTokens: number;
  bufferTokens: number;
  /** Absolute per-model prompt-token threshold override, if any. */
  threshold?: number;
  /** Percentage-based threshold (0-100) for more precise control. */
  thresholdPercent?: number;
}

export interface CompactionGlobalSettings {
  compactionBufferTokens?: number;
  compactionKeepTokens?: number;
  compactionThresholdPercent?: number;
}

export interface CompactionNodeSettings {
  compactionMode?: 'auto' | 'off';
  compactionKeepTokens?: number;
}

export interface CompactionModelSettings {
  compactionThreshold?: number;
  compactionThresholdPercent?: number;
  contextWindow?: number;
}

function posInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function posPercent(value: unknown): number | undefined {
  const n = posInt(value);
  return n !== undefined && n > 0 && n <= 100 ? n : undefined;
}

export function resolveEffectiveCompaction(
  node?: CompactionNodeSettings,
  model?: CompactionModelSettings,
  global?: CompactionGlobalSettings,
): EffectiveCompaction {
  const enabled = node?.compactionMode !== 'off';

  const window = posInt(model?.contextWindow);
  const requestedKeepTokens =
    posInt(node?.compactionKeepTokens) ??
    posInt(global?.compactionKeepTokens) ??
    DEFAULT_COMPACTION_KEEP_TOKENS;

  const requestedBufferTokens = posInt(global?.compactionBufferTokens)
    ?? DEFAULT_COMPACTION_BUFFER_TOKENS;
  // Preserve the configured/default absolute reserve on large models.
  // Bound persisted absolute settings when moving to a smaller
  // model so neither the trigger nor its retained tail can disable compaction.
  const bufferTokens = window ? Math.min(requestedBufferTokens, Math.floor(window * 0.4)) : requestedBufferTokens;
  const keepTokens = window ? Math.min(requestedKeepTokens, Math.max(1, Math.floor(window * 0.15))) : requestedKeepTokens;

  // Support both absolute threshold and percentage-based threshold
  const threshold = posInt(model?.compactionThreshold);
  const thresholdPercent = posPercent(model?.compactionThresholdPercent) ?? posPercent(global?.compactionThresholdPercent);

  return {
    enabled,
    keepTokens,
    bufferTokens,
    threshold,
    thresholdPercent,
  };
}
