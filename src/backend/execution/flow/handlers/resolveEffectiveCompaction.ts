/**
 * Resolve the effective summarizing-compaction configuration for a Process-node
 * model call (issue #248).
 *
 * Precedence mirrors `resolveEffectiveMaxTokens`:
 *   enabled       : global `compactionEnabled` (default ON) AND the node is not
 *                   explicitly `compactionMode:'off'`.
 *   keepTokens    : per-node override → global `compactionKeepTokens` → default.
 *   bufferTokens  : global `compactionBufferTokens` → default.
 *   threshold     : per-model `compactionThreshold` override (absolute prompt-token
 *                   figure at/above which pre-flight compaction triggers); when
 *                   unset the trigger is derived from contextWindow − buffer.
 *
 * The feature is a backend behavioural change to context management, so it is
 * ON by default for new installations — a node's `compactionMode`
 * cannot turn it on by itself, only opt a node OUT.
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
  compactionEnabled?: boolean;
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
}

export interface VisualCompactionGlobalSettings {
  visualCompactionEnabled?: boolean;
  visualCompactionToolResultsOnly?: boolean;
  visualCompactionEvaluationMode?: boolean;
}

export interface EffectiveVisualCompactionSettings {
  enabled: boolean;
  toolResultsOnly: boolean;
  evaluationOnly: boolean;
}

/**
 * Visual compaction is independently and globally gated. There is no Process
 * node visual override in the current schema/UI, so nodes cannot silently turn
 * the experimental feature on. Missing persisted values migrate to the safe
 * defaults: disabled and tool-results-only.
 */
export function resolveEffectiveVisualCompaction(
  global?: VisualCompactionGlobalSettings,
): EffectiveVisualCompactionSettings {
  return {
    enabled: Boolean(global?.visualCompactionEnabled),
    toolResultsOnly: global?.visualCompactionToolResultsOnly !== false,
    evaluationOnly: Boolean(global?.visualCompactionEvaluationMode),
  };
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
  // Default to ENABLED for new installations (missing value = true)
  const globalEnabled = global?.compactionEnabled !== false;
  const nodeOptedOut = node?.compactionMode === 'off';
  const enabled = globalEnabled && !nodeOptedOut;

  const keepTokens =
    posInt(node?.compactionKeepTokens) ??
    posInt(global?.compactionKeepTokens) ??
    DEFAULT_COMPACTION_KEEP_TOKENS;

  const bufferTokens = posInt(global?.compactionBufferTokens) ?? DEFAULT_COMPACTION_BUFFER_TOKENS;

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
