/**
 * Ranking + near-duplicate weights for the persona memory kernel (issue #450).
 * Hybrid embedding + lexical scoring for semantic recall (issue #451).
 * Single source of truth: A/B experiments should fork THIS block, not scatter magic numbers.
 * All functions here are pure (no side effects, no time inside — time is a parameter).
 */

import type { MemoryItem, MemoryTrust } from '@shared/types/enduringAgent/enduringAgent';

/**
 * Ranking weights for memory recall. These control the lexical score, recency decay, trust weighting,
 * and length normalisation applied in `searchPersonaMemory`.
 */
export const MEMORY_RANKING_WEIGHTS = {
  /** Base priors (unchanged from pre-#450). */
  importanceWeight: 0.25,
  confidenceWeight: 0.15,
  /** Lexical match bonuses (unchanged). */
  exactContentMatchBonus: 4,
  termHitBonus: 1,
  /** NEW: reward coverage of the query, not just one hit. */
  termCoverageBonus: 1.5,
  /** NEW: dampen very long memories that trivially contain many terms. */
  lengthNormalisationChars: 280,
  lengthNormalisationFloor: 0.6,
  /** NEW: recency decay (2 ** (-ageDays / halfLifeDays)). */
  recencyHalfLifeDays: 90,
  recencyFloor: 0.15,
  /** NEW: trust weighting (multiplicative, applied after lexical). */
  trustWeights: {
    explicit_user: 1.3,
    verified_tool: 1.15,
    model_inference: 1.0,
    external_untrusted: 0.8,
  },
  /** Core-pinned handling. */
  coreBonus: 2,
  coreExemptFromDecay: true,
  // NEW: Hybrid embedding + lexical scoring (issue #451)
  // These weights control the balance between lexical and semantic ranking.
  // When embeddings are not configured, wSem = 0 and the formula collapses to pure lexical.
  lexicalWeight: 0.6,  // wLex in the formula
  semanticWeight: 0.4, // wSem in the formula
} as const;

/**
 * Settings for near-duplicate detection on write (issue #450 acceptance criterion #1).
 */
export const MEMORY_DEDUP_SETTINGS = {
  /** Kill-switch: set to false to disable dedup entirely without code changes. */
  enabled: true,
  /** Character n-gram size for Jaccard similarity (trigrams are robust to word reordering). */
  shingleSize: 3,
  /** Jaccard threshold above which two items are considered near-duplicates (0–1). */
  nearDuplicateThreshold: 0.82,
  /** Only compare against the N most recently updated same-kind/scope active items. */
  comparisonWindow: 200,
  /** Reinforcement caps. */
  confidenceReinforcementStep: 0.05,
  importanceReinforcementStep: 0.02,
  maxSourceRefsPerItem: 64,
} as const;

/**
 * Normalise memory content for comparison: lowercase, NFKC normalise, strip punctuation,
 * collapse whitespace, trim. Deliberately no stemming or stop-word removal (keeps it
 * language-agnostic).
 */
export function normaliseMemoryContent(content: string): string {
  return content
    .toLocaleLowerCase()
    .normalize('NFKC')
    // Replace punctuation (including hyphens) with spaces
    .replace(/[^\p{L}\p{N}\s_]/gu, ' ')
    // Collapse multiple spaces
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generate character n-grams (shingles) from a normalised string.
 * Character trigrams (size=3) are robust to word reordering and whitespace changes.
 */
export function contentShingles(normalised: string, size = MEMORY_DEDUP_SETTINGS.shingleSize): Set<string> {
  const shingles = new Set<string>();
  if (normalised.length < size) {
    // If string is shorter than shingle size, use the whole thing
    if (normalised.length > 0) shingles.add(normalised);
    return shingles;
  }
  for (let i = 0; i <= normalised.length - size; i++) {
    shingles.add(normalised.substring(i, i + size));
  }
  return shingles;
}

/**
 * Jaccard similarity between two sets: |A ∩ B| / |A ∪ B|.
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = new Set([...a].filter((x) => b.has(x)));
  const union = new Set([...a, ...b]);
  return intersection.size / union.size;
}

/**
 * Recency multiplier for ranking: `2 ** (-ageDays / halfLifeDays)`, clamped to floor.
 * Returns 1 for core-pinned items (they are exempt from decay).
 * Returns 1 for future `updatedAt` (clamps negative age to 1).
 */
export function recencyMultiplier(
  updatedAt: number,
  asOf: number,
  opts: { core?: boolean; halfLifeDays?: number; floor?: number } = {},
): number {
  const { core = false, halfLifeDays = MEMORY_RANKING_WEIGHTS.recencyHalfLifeDays, floor = MEMORY_RANKING_WEIGHTS.recencyFloor } = opts;

  // Core-pinned items are exempt from decay.
  if (core && MEMORY_RANKING_WEIGHTS.coreExemptFromDecay) {
    return 1;
  }

  const ageMs = asOf - updatedAt;
  const ageDays = Math.max(0, ageMs / (1000 * 60 * 60 * 24));
  const multiplier = Math.pow(2, -ageDays / halfLifeDays);
  return Math.max(floor, multiplier);
}

/**
 * Content length factor: dampen very long memories that trivially contain many terms.
 * Sigmoid-like dampening: f(x) = 1 / (1 + (x / midpoint)), clamped to floor.
 */
export function contentLengthFactor(length: number): number {
  const midpoint = MEMORY_RANKING_WEIGHTS.lengthNormalisationChars;
  const floor = MEMORY_RANKING_WEIGHTS.lengthNormalisationFloor;
  if (length <= midpoint) return 1;
  const factor = 1 / (1 + length / midpoint);
  return Math.max(floor, factor);
}

/**
 * Trust weighting: lookup in `MEMORY_RANKING_WEIGHTS.trustWeights`.
 */
export function trustWeight(trust: MemoryTrust): number {
  return MEMORY_RANKING_WEIGHTS.trustWeights[trust] ?? MEMORY_RANKING_WEIGHTS.trustWeights.model_inference;
}

/**
 * Hybrid score: blend lexical and semantic (embedding) similarity.
 * Both inputs should be in [0, 1] range (normalized).
 * Formula: score = wLex * lexical + wSem * semantic
 * When embeddings are unavailable, pass semantic=0 to degrade to pure lexical.
 */
export function hybridScore(lexical: number, semantic: number): number {
  const wLex = MEMORY_RANKING_WEIGHTS.lexicalWeight;
  const wSem = MEMORY_RANKING_WEIGHTS.semanticWeight;
  return wLex * lexical + wSem * semantic;
}

/**
 * Compute the composite ranking score for a candidate memory.
 * Formula:
 *   lexical = importance*wI + confidence*wC
 *           + Σ_terms (content === term ? exactBonus : content.includes(term) ? termHit : 0)
 *           + termCoverageBonus * (matchedTerms / max(1, terms.length))
 *
 *   score = lexical
 *         * contentLengthFactor(item.content.length)
 *         * trustWeight(item.trust)
 *         * recencyMultiplier(item.updatedAt, asOf, { core })
 *         + (core ? coreBonus : 0)
 *
 * When semantic embedding score is provided, combines with lexical via hybridScore().
 */
export function scoreMemoryCandidate(opts: {
  item: MemoryItem;
  terms: readonly string[];
  core: boolean;
  asOf: number;
  semanticScore?: number;
}): number {
  const { item, terms, core, asOf, semanticScore = 0 } = opts;

  // Lexical score
  const contentLC = item.content.toLocaleLowerCase();
  let lexical = item.importance * MEMORY_RANKING_WEIGHTS.importanceWeight + item.confidence * MEMORY_RANKING_WEIGHTS.confidenceWeight;

  let matchedTerms = 0;
  for (const term of terms) {
    if (contentLC === term) {
      lexical += MEMORY_RANKING_WEIGHTS.exactContentMatchBonus;
      matchedTerms++;
    } else if (contentLC.includes(term)) {
      lexical += MEMORY_RANKING_WEIGHTS.termHitBonus;
      matchedTerms++;
    }
  }

  // Term coverage bonus
  if (terms.length > 0) {
    lexical += MEMORY_RANKING_WEIGHTS.termCoverageBonus * (matchedTerms / terms.length);
  }

  // Normalize lexical to [0, 1] for hybrid scoring
  // Cap at reasonable max (e.g., 10) and scale
  const normalizedLexical = Math.min(1, lexical / 10);

  // Hybrid blend of lexical and semantic scores
  const blended = hybridScore(normalizedLexical, semanticScore);

  // Apply multipliers
  const lengthFactor = contentLengthFactor(item.content.length);
  const trust = trustWeight(item.trust);
  const recency = recencyMultiplier(item.updatedAt, asOf, { core });

  let score = blended * lengthFactor * trust * recency;

  // Core bonus (additive, so pinned items cannot be multiplied away)
  if (core) {
    score += MEMORY_RANKING_WEIGHTS.coreBonus;
  }

  return score;
}

/**
 * @deprecated Use `scoreMemoryCandidate` instead. Kept for backwards compatibility.
 * Computes the pre-#450 lexical score without recency decay, trust weighting, or length normalisation.
 */
export function lexicalScore(item: MemoryItem, terms: readonly string[]): number {
  const contentLC = item.content.toLocaleLowerCase();
  let score = item.importance * MEMORY_RANKING_WEIGHTS.importanceWeight + item.confidence * MEMORY_RANKING_WEIGHTS.confidenceWeight;
  for (const term of terms) {
    if (contentLC === term) score += MEMORY_RANKING_WEIGHTS.exactContentMatchBonus;
    else if (contentLC.includes(term)) score += MEMORY_RANKING_WEIGHTS.termHitBonus;
  }
  return score;
}
