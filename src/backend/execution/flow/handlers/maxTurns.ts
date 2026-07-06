import { DEFAULT_AGENTIC_MAX_TURNS } from '@/shared/types/model/model';

/**
 * Resolve the effective agentic-turn cap for a Process-node model call.
 *
 * Precedence: per-node override → bound-model setting → system default (50).
 * Non-positive / non-finite / undefined values at each level are ignored and
 * fall through to the next. This is the single source of truth that replaced the
 * former hard-coded cap of 30 in ProcessNode (issue #48): unset everywhere now
 * yields 50, which is higher than the old 30, so no existing flow is tightened.
 *
 * @param nodeOverride Per-Process-node override (ProcessNodeProperties.maxTurns).
 * @param modelSetting Bound model's configured cap (Model.maxTurns).
 * @param fallback     System default (defaults to DEFAULT_AGENTIC_MAX_TURNS).
 */
export function resolveEffectiveMaxTurns(
  nodeOverride?: number,
  modelSetting?: number,
  fallback: number = DEFAULT_AGENTIC_MAX_TURNS,
): number {
  if (typeof nodeOverride === 'number' && Number.isFinite(nodeOverride) && nodeOverride > 0) {
    return nodeOverride;
  }
  if (typeof modelSetting === 'number' && Number.isFinite(modelSetting) && modelSetting > 0) {
    return modelSetting;
  }
  return fallback;
}
