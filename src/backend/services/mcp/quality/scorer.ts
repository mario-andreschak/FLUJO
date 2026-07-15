/**
 * Pure scoring math for the quality layer. No IO, no clock reads except the
 * `now` passed in — so every function here is trivially unit-testable.
 *
 * Composite score for a candidate:
 *   score = Σ(weight_i · score_i) / Σ(weight_i)   over APPLICABLE providers only
 * where an applicable-but-failed provider contributes score 0 while KEEPING its
 * weight (missing evidence drags the score down — that's how a real server
 * out-ranks trash), and a non-applicable provider is omitted entirely (a remote-
 * only server isn't penalized for lacking an npm package).
 */

/** One provider's resolved contribution to a candidate's composite score. */
export interface WeightedContribution {
  providerId: string;
  /** Resolved weight (settings override or provider default). */
  weight: number;
  /** Normalized 0..1; 0 when the provider was applicable but produced no signal. */
  score: number;
}

export interface CompositeResult {
  /** Blended 0..1 score, or 0 when no applicable provider had positive weight. */
  score: number;
  /** Per-provider contributions, for transparency in the audit log / UI. */
  breakdown: WeightedContribution[];
}

/**
 * Weighted average over the given contributions. Contributions for
 * non-applicable providers must simply be omitted by the caller (they never
 * appear here); every contribution passed in keeps its weight in the denominator.
 */
export function compositeScore(contributions: WeightedContribution[]): CompositeResult {
  let weightSum = 0;
  let weighted = 0;
  for (const c of contributions) {
    const w = Number.isFinite(c.weight) && c.weight > 0 ? c.weight : 0;
    const s = clamp01(c.score);
    weightSum += w;
    weighted += w * s;
  }
  return {
    score: weightSum > 0 ? weighted / weightSum : 0,
    breakdown: contributions,
  };
}

/** Clamp any number into [0, 1]; non-finite → 0. */
export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Saturating log-scale normalization for count-like signals (stars, downloads):
 * 0 → 0, `saturation` → 1, beyond `saturation` clamped to 1. Log so the
 * difference between 10 and 100 matters more than 10_000 vs 100_000.
 */
export function normalizeCount(value: number, saturation: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (!Number.isFinite(saturation) || saturation <= 1) return value > 0 ? 1 : 0;
  const score = Math.log10(value + 1) / Math.log10(saturation + 1);
  return clamp01(score);
}

/** Saturation points for the count curves — where the score reaches ~1.0. */
export const STARS_SATURATION = 50_000;
export const WEEKLY_DOWNLOADS_SATURATION = 1_000_000;

/**
 * Recency score from a last-activity timestamp: full credit within `freshDays`,
 * decaying linearly to 0 at `deadDays`. Missing/invalid timestamp → 0.
 */
export function normalizeRecency(
  lastActivityMs: number | null | undefined,
  nowMs: number,
  freshDays = 30,
  deadDays = 730
): number {
  if (!lastActivityMs || !Number.isFinite(lastActivityMs)) return 0;
  const ageDays = (nowMs - lastActivityMs) / (24 * 60 * 60 * 1000);
  if (ageDays <= freshDays) return 1;
  if (ageDays >= deadDays) return 0;
  return clamp01(1 - (ageDays - freshDays) / (deadDays - freshDays));
}
