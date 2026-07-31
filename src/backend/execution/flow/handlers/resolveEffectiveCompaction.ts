/**
 * Resolve the effective summarizing-compaction configuration for a Process-node
 * model call (issue #248).
 *
 * Precedence mirrors `resolveEffectiveMaxTokens`:
 *   enabled       : global `compactionEnabled` (default OFF) AND the node is not
 *                   explicitly `compactionMode:'off'`.
 *   keepTokens    : per-node override → global `compactionKeepTokens` → default.
 *   bufferTokens  : global `compactionBufferTokens` → default.
 *   threshold     : per-model `compactionThreshold` override (absolute prompt-token
 *                   figure at/above which pre-flight compaction triggers); when
 *                   unset the trigger is derived from contextWindow − buffer.
 *
 * The feature is a backend behavioural change to context management, so it is
 * OFF unless the global experimental flag is on — a node's `compactionMode`
 * cannot turn it on by itself, only opt a node OUT.
 */

export const DEFAULT_COMPACTION_BUFFER_TOKENS = 20000;
export const DEFAULT_COMPACTION_KEEP_TOKENS = 8000;

export interface EffectiveCompaction {
  enabled: boolean;
  keepTokens: number;
  bufferTokens: number;
  /** Absolute per-model prompt-token threshold override, if any. */
  threshold?: number;
}

export interface CompactionGlobalSettings {
  compactionEnabled?: boolean;
  compactionBufferTokens?: number;
  compactionKeepTokens?: number;
}

export interface CompactionNodeSettings {
  compactionMode?: 'auto' | 'off';
  compactionKeepTokens?: number;
}

export interface CompactionModelSettings {
  compactionThreshold?: number;
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

export function resolveEffectiveCompaction(
  node?: CompactionNodeSettings,
  model?: CompactionModelSettings,
  global?: CompactionGlobalSettings,
): EffectiveCompaction {
  const globalEnabled = Boolean(global?.compactionEnabled);
  const nodeOptedOut = node?.compactionMode === 'off';
  const enabled = globalEnabled && !nodeOptedOut;

  const keepTokens =
    posInt(node?.compactionKeepTokens) ??
    posInt(global?.compactionKeepTokens) ??
    DEFAULT_COMPACTION_KEEP_TOKENS;

  const bufferTokens = posInt(global?.compactionBufferTokens) ?? DEFAULT_COMPACTION_BUFFER_TOKENS;

  return {
    enabled,
    keepTokens,
    bufferTokens,
    threshold: posInt(model?.compactionThreshold),
  };
}
