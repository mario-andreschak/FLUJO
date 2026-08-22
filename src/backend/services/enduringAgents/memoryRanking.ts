/**
 * Ranking + near-duplicate weights for the persona memory kernel (issues #450 and #466).
 * All functions are pure: experiment configuration and time are explicit inputs.
 */

import type { MemoryTrust } from '@/shared/types/enduringAgent';

import type {
  IncomingMemoryDedupCandidate,
  MemoryDedupCandidate,
  MemoryDedupSettings,
  MemoryExperimentVariant,
  MemoryRankingCandidate,
  MemoryRankingWeights,
} from './memoryExperimentTypes';

export const MEMORY_LEXICAL_WEIGHT = 0.6;
export const MEMORY_SEMANTIC_WEIGHT = 0.4;
export const MEMORY_SEMANTIC_FLOOR = 0.75;

export interface SemanticRankingInput {
  readonly available: boolean;
  readonly score?: number;
}

/** Production ranking defaults. Experiments pass a complete fork explicitly. */
export const MEMORY_RANKING_WEIGHTS = {
  importanceWeight: 0.25,
  confidenceWeight: 0.15,
  exactContentMatchBonus: 4,
  termHitBonus: 1,
  termCoverageBonus: 1.5,
  lengthNormalisationChars: 280,
  lengthNormalisationFloor: 0.6,
  /** Provisionally approved in issue #467; see docs/architecture/memory-ranking-dedup-decision.md. */
  recencyHalfLifeDays: 90,
  recencyFloor: 0.15,
  trustWeights: {
    explicit_user: 1.3,
    verified_tool: 1.15,
    model_inference: 1.0,
    external_untrusted: 0.8,
  },
  coreBonus: 2,
  coreExemptFromDecay: true,
  lexicalWeight: MEMORY_LEXICAL_WEIGHT,
  semanticWeight: MEMORY_SEMANTIC_WEIGHT,
} as const satisfies MemoryRankingWeights;

/** Production near-duplicate defaults. Experiments pass a complete fork explicitly. */
export const MEMORY_DEDUP_SETTINGS = {
  enabled: true,
  shingleSize: 3,
  /** Provisionally approved in issue #467; see docs/architecture/memory-ranking-dedup-decision.md. */
  nearDuplicateThreshold: 0.82,
  comparisonWindow: 200,
  confidenceReinforcementStep: 0.05,
  importanceReinforcementStep: 0.02,
  maxSourceRefsPerItem: 64,
} as const satisfies MemoryDedupSettings;

/** Stable baseline used by the experiment harness. */
export const CURRENT_MEMORY_VARIANT: MemoryExperimentVariant = Object.freeze({
  id: 'current',
  ranking: MEMORY_RANKING_WEIGHTS,
  dedup: MEMORY_DEDUP_SETTINGS,
});

export function normaliseMemoryContent(content: string): string {
  return content
    .toLocaleLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s_]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function contentShingles(
  normalised: string,
  size: number = MEMORY_DEDUP_SETTINGS.shingleSize,
): Set<string> {
  const shingles = new Set<string>();
  if (normalised.length < size) {
    if (normalised.length > 0) shingles.add(normalised);
    return shingles;
  }
  for (let index = 0; index <= normalised.length - size; index++) {
    shingles.add(normalised.substring(index, index + size));
  }
  return shingles;
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = new Set([...a].filter((value) => b.has(value)));
  const union = new Set([...a, ...b]);
  return intersection.size / union.size;
}

export function recencyMultiplier(
  updatedAt: number,
  asOf: number,
  opts: {
    readonly core?: boolean;
    readonly halfLifeDays?: number;
    readonly floor?: number;
    readonly weights?: MemoryRankingWeights;
  } = {},
): number {
  const weights = opts.weights ?? MEMORY_RANKING_WEIGHTS;
  const core = opts.core ?? false;
  const halfLifeDays = opts.halfLifeDays ?? weights.recencyHalfLifeDays;
  const floor = opts.floor ?? weights.recencyFloor;
  if (core && weights.coreExemptFromDecay) return 1;

  const ageDays = Math.max(0, (asOf - updatedAt) / (1000 * 60 * 60 * 24));
  return Math.max(floor, Math.pow(2, -ageDays / halfLifeDays));
}

export function contentLengthFactor(
  length: number,
  weights: MemoryRankingWeights = MEMORY_RANKING_WEIGHTS,
): number {
  if (length <= weights.lengthNormalisationChars) return 1;
  const factor = 1 / (1 + length / weights.lengthNormalisationChars);
  return Math.max(weights.lengthNormalisationFloor, factor);
}

export function trustWeight(
  trust: MemoryTrust,
  weights: MemoryRankingWeights = MEMORY_RANKING_WEIGHTS,
): number {
  return weights.trustWeights[trust] ?? weights.trustWeights.model_inference;
}

export function normaliseSemanticScore(score: number | undefined): number | null {
  if (score === undefined || !Number.isFinite(score)) return null;
  return Math.min(1, Math.max(0, score));
}

export function hybridScore(
  lexical: number,
  semantic: number | SemanticRankingInput | undefined,
  weights: MemoryRankingWeights = MEMORY_RANKING_WEIGHTS,
): number {
  const semanticInput = typeof semantic === 'number'
    ? { available: true, score: semantic }
    : semantic;
  const semanticScore = normaliseSemanticScore(semanticInput?.score);
  if (!semanticInput?.available || semanticScore === null) return lexical;
  return weights.lexicalWeight * lexical + weights.semanticWeight * semanticScore;
}

export function semanticCandidateEligible(
  lexicalHit: boolean,
  semantic: SemanticRankingInput | undefined,
  floor: number = MEMORY_SEMANTIC_FLOOR,
): boolean {
  if (lexicalHit) return true;
  if (!semantic?.available) return false;
  const score = normaliseSemanticScore(semantic.score);
  const effectiveFloor = Number.isFinite(floor)
    ? Math.min(1, Math.max(0, floor))
    : MEMORY_SEMANTIC_FLOOR;
  return score !== null && score >= effectiveFloor;
}

export function scoreMemoryCandidate(opts: {
  readonly item: MemoryRankingCandidate;
  readonly terms: readonly string[];
  readonly core: boolean;
  readonly asOf: number;
  readonly semantic?: SemanticRankingInput;
  /** @deprecated Prefer semantic, which represents availability explicitly. */
  readonly semanticScore?: number;
  readonly weights?: MemoryRankingWeights;
}): number {
  const {
    item,
    terms,
    core,
    asOf,
    weights = MEMORY_RANKING_WEIGHTS,
  } = opts;
  const semantic = opts.semantic ?? (
    opts.semanticScore === undefined
      ? undefined
      : { available: true, score: opts.semanticScore }
  );
  const content = item.content.toLocaleLowerCase();
  let lexical = (
    item.importance * weights.importanceWeight
    + item.confidence * weights.confidenceWeight
  );

  let matchedTerms = 0;
  for (const term of terms) {
    if (content === term) {
      lexical += weights.exactContentMatchBonus;
      matchedTerms++;
    } else if (content.includes(term)) {
      lexical += weights.termHitBonus;
      matchedTerms++;
    }
  }
  if (terms.length > 0) {
    lexical += weights.termCoverageBonus * (matchedTerms / terms.length);
  }

  const normalizedLexical = Math.min(1, lexical / 10);
  const blended = hybridScore(normalizedLexical, semantic, weights);
  let score = (
    blended
    * contentLengthFactor(item.content.length, weights)
    * trustWeight(item.trust, weights)
    * recencyMultiplier(item.updatedAt, asOf, { core, weights })
  );
  if (core) score += weights.coreBonus;
  return score;
}

/**
 * Select a near-duplicate without reading or writing storage. Equal-similarity
 * ties are resolved newest-first and then by ID, matching the experiment's
 * deterministic ordering contract.
 */
export function selectNearDuplicateCandidate<T extends MemoryDedupCandidate>(
  candidates: readonly T[],
  incoming: IncomingMemoryDedupCandidate,
  settings: MemoryDedupSettings = MEMORY_DEDUP_SETTINGS,
): { readonly candidate: T; readonly similarity: number } | null {
  if (!settings.enabled) return null;

  const eligible = candidates
    .filter((candidate) => (
      candidate.status === 'active'
      && candidate.kind === incoming.kind
      && candidate.scope === incoming.scope
    ))
    .sort((left, right) => (
      right.updatedAt - left.updatedAt
      || left.id.localeCompare(right.id)
    ))
    .slice(0, settings.comparisonWindow);

  const incomingShingles = contentShingles(
    normaliseMemoryContent(incoming.content),
    settings.shingleSize,
  );
  let best: { readonly candidate: T; readonly similarity: number } | null = null;

  for (const candidate of eligible) {
    const similarity = jaccardSimilarity(
      incomingShingles,
      contentShingles(normaliseMemoryContent(candidate.content), settings.shingleSize),
    );
    if (
      similarity >= settings.nearDuplicateThreshold
      && (best === null || similarity > best.similarity)
    ) {
      best = { candidate, similarity };
    }
  }
  return best;
}

/**
 * @deprecated Use scoreMemoryCandidate. Kept for backwards compatibility with
 * the pre-recency lexical scorer.
 */
export function lexicalScore(
  item: MemoryRankingCandidate,
  terms: readonly string[],
  weights: MemoryRankingWeights = MEMORY_RANKING_WEIGHTS,
): number {
  const content = item.content.toLocaleLowerCase();
  let score = (
    item.importance * weights.importanceWeight
    + item.confidence * weights.confidenceWeight
  );
  for (const term of terms) {
    if (content === term) score += weights.exactContentMatchBonus;
    else if (content.includes(term)) score += weights.termHitBonus;
  }
  return score;
}
