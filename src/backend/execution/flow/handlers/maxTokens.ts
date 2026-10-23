import { normalizeMaxTokens } from '@/shared/types/model/model';

/**
 * Resolve the effective per-completion output-token cap for a Process-node
 * model call.
 *
 * Precedence (flow-execution path): per-node override → bound-model setting →
 * adapter default. Unlike `maxTurns`, there is NO numeric system default for
 * tokens: when both the node override and the model setting are unset (or
 * invalid), this returns `undefined` so the adapter's own default remains
 * authoritative (OpenAI/Gemini send no cap; Anthropic uses its documented
 * fallback). Each level is validated with `normalizeMaxTokens` (empty / 0 /
 * negative / non-finite → ignored and falls through; positive float → floored
 * int), mirroring the Model-settings UI parsing and the wire precedence added
 * in #173.
 *
 * @param nodeOverride Per-Process-node override (ProcessNodeProperties.maxTokens).
 * @param modelSetting Bound model's configured cap (Model.maxTokens).
 */
export function resolveEffectiveMaxTokens(
  nodeOverride?: number,
  modelSetting?: number,
  contextWindow?: number,
): number | undefined {
  const explicit = normalizeMaxTokens(nodeOverride);
  if (explicit !== undefined) return explicit;
  const configured = normalizeMaxTokens(modelSetting);
  // Older discovery could carry a different model's output ceiling into a
  // router whose catalogue has no output limit. Recover that impossible
  // model-level default while respecting deliberate per-node overrides.
  if (configured !== undefined && Number.isFinite(contextWindow) && contextWindow! > 0 && configured >= contextWindow!) {
    return Math.max(1, Math.floor(contextWindow! / 4));
  }
  return configured;
}
