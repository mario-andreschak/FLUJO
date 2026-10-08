import type {
  DuplicateMergeCounts,
  FractionMetric,
  MemoryDedupSettings,
  MemoryExperimentDataset,
  MemoryExperimentDuplicateOutcome,
  MemoryExperimentQueryOutcome,
  MemoryExperimentResult,
  MemoryExperimentVariant,
  MemoryExperimentVariantInput,
  MemoryRankingWeights,
} from './memoryExperimentTypes';
import {
  CURRENT_MEMORY_VARIANT,
  MEMORY_SEMANTIC_FLOOR,
  scoreMemoryCandidate,
  semanticCandidateEligible,
  selectNearDuplicateCandidate,
} from './memoryRanking';

const RANKING_KEYS = [
  'importanceWeight',
  'confidenceWeight',
  'exactContentMatchBonus',
  'termHitBonus',
  'termCoverageBonus',
  'lengthNormalisationChars',
  'lengthNormalisationFloor',
  'recencyHalfLifeDays',
  'recencyFloor',
  'trustWeights',
  'coreBonus',
  'coreExemptFromDecay',
  'lexicalWeight',
  'semanticWeight',
] as const;
const DEDUP_KEYS = [
  'enabled',
  'shingleSize',
  'nearDuplicateThreshold',
  'comparisonWindow',
  'confidenceReinforcementStep',
  'importanceReinforcementStep',
  'maxSourceRefsPerItem',
] as const;
const TRUST_KEYS = [
  'explicit_user',
  'verified_tool',
  'model_inference',
  'external_untrusted',
] as const;

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unknown key(s): ${unknown.join(', ')}.`);
  }
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

function nonnegative(value: unknown, label: string): number {
  const number = finiteNumber(value, label);
  if (number < 0) throw new Error(`${label} must be nonnegative.`);
  return number;
}

function positive(value: unknown, label: string): number {
  const number = finiteNumber(value, label);
  if (number <= 0) throw new Error(`${label} must be positive.`);
  return number;
}

function unitInterval(value: unknown, label: string): number {
  const number = finiteNumber(value, label);
  if (number < 0 || number > 1) throw new Error(`${label} must be between 0 and 1.`);
  return number;
}

function positiveInteger(value: unknown, label: string): number {
  const number = positive(value, label);
  if (!Number.isInteger(number)) throw new Error(`${label} must be an integer.`);
  return number;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`);
  return value;
}

function cloneRanking(
  overrides: Record<string, unknown> = {},
): MemoryRankingWeights {
  rejectUnknownKeys(overrides, RANKING_KEYS, 'ranking');
  const trustOverride = overrides.trustWeights;
  if (trustOverride !== undefined) {
    assertRecord(trustOverride, 'ranking.trustWeights');
    rejectUnknownKeys(trustOverride, TRUST_KEYS, 'ranking.trustWeights');
  }
  const trustInput = (trustOverride ?? {}) as Record<string, unknown>;
  const base = CURRENT_MEMORY_VARIANT.ranking;
  const pick = (key: keyof MemoryRankingWeights): unknown => overrides[key] ?? base[key];

  return Object.freeze({
    importanceWeight: nonnegative(pick('importanceWeight'), 'ranking.importanceWeight'),
    confidenceWeight: nonnegative(pick('confidenceWeight'), 'ranking.confidenceWeight'),
    exactContentMatchBonus: nonnegative(pick('exactContentMatchBonus'), 'ranking.exactContentMatchBonus'),
    termHitBonus: nonnegative(pick('termHitBonus'), 'ranking.termHitBonus'),
    termCoverageBonus: nonnegative(pick('termCoverageBonus'), 'ranking.termCoverageBonus'),
    lengthNormalisationChars: positive(pick('lengthNormalisationChars'), 'ranking.lengthNormalisationChars'),
    lengthNormalisationFloor: unitInterval(pick('lengthNormalisationFloor'), 'ranking.lengthNormalisationFloor'),
    recencyHalfLifeDays: positive(pick('recencyHalfLifeDays'), 'ranking.recencyHalfLifeDays'),
    recencyFloor: unitInterval(pick('recencyFloor'), 'ranking.recencyFloor'),
    trustWeights: Object.freeze({
      explicit_user: nonnegative(
        trustInput.explicit_user ?? base.trustWeights.explicit_user,
        'ranking.trustWeights.explicit_user',
      ),
      verified_tool: nonnegative(
        trustInput.verified_tool ?? base.trustWeights.verified_tool,
        'ranking.trustWeights.verified_tool',
      ),
      model_inference: nonnegative(
        trustInput.model_inference ?? base.trustWeights.model_inference,
        'ranking.trustWeights.model_inference',
      ),
      external_untrusted: nonnegative(
        trustInput.external_untrusted ?? base.trustWeights.external_untrusted,
        'ranking.trustWeights.external_untrusted',
      ),
    }),
    coreBonus: nonnegative(pick('coreBonus'), 'ranking.coreBonus'),
    coreExemptFromDecay: requireBoolean(
      pick('coreExemptFromDecay'),
      'ranking.coreExemptFromDecay',
    ),
    lexicalWeight: nonnegative(pick('lexicalWeight'), 'ranking.lexicalWeight'),
    semanticWeight: nonnegative(pick('semanticWeight'), 'ranking.semanticWeight'),
  });
}

function cloneDedup(overrides: Record<string, unknown> = {}): MemoryDedupSettings {
  rejectUnknownKeys(overrides, DEDUP_KEYS, 'dedup');
  const base = CURRENT_MEMORY_VARIANT.dedup;
  const pick = (key: keyof MemoryDedupSettings): unknown => overrides[key] ?? base[key];

  return Object.freeze({
    enabled: requireBoolean(pick('enabled'), 'dedup.enabled'),
    shingleSize: positiveInteger(pick('shingleSize'), 'dedup.shingleSize'),
    nearDuplicateThreshold: unitInterval(
      pick('nearDuplicateThreshold'),
      'dedup.nearDuplicateThreshold',
    ),
    comparisonWindow: positiveInteger(pick('comparisonWindow'), 'dedup.comparisonWindow'),
    confidenceReinforcementStep: nonnegative(
      pick('confidenceReinforcementStep'),
      'dedup.confidenceReinforcementStep',
    ),
    importanceReinforcementStep: nonnegative(
      pick('importanceReinforcementStep'),
      'dedup.importanceReinforcementStep',
    ),
    maxSourceRefsPerItem: positiveInteger(
      pick('maxSourceRefsPerItem'),
      'dedup.maxSourceRefsPerItem',
    ),
  });
}

/** Merge a strict partial variant onto current production defaults. */
export function createMemoryExperimentVariant(
  value: MemoryExperimentVariantInput | unknown,
): MemoryExperimentVariant {
  assertRecord(value, 'variant');
  rejectUnknownKeys(value, ['id', 'ranking', 'dedup'], 'variant');
  if (typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(value.id)) {
    throw new Error('variant.id must be a stable non-empty identifier.');
  }
  if (value.ranking !== undefined) assertRecord(value.ranking, 'ranking');
  if (value.dedup !== undefined) assertRecord(value.dedup, 'dedup');
  return Object.freeze({
    id: value.id,
    ranking: cloneRanking(value.ranking as Record<string, unknown> | undefined),
    dedup: cloneDedup(value.dedup as Record<string, unknown> | undefined),
  });
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${label} ${JSON.stringify(value)}.`);
    seen.add(value);
  }
}

function validateDataset(dataset: MemoryExperimentDataset): void {
  if (!dataset || typeof dataset !== 'object') throw new Error('dataset must be an object.');
  if (!dataset.version?.trim()) throw new Error('dataset.version is required.');
  if (!Array.isArray(dataset.items) || !Array.isArray(dataset.queries) || !Array.isArray(dataset.duplicates)) {
    throw new Error('dataset items, queries, and duplicates must be arrays.');
  }
  assertUnique(dataset.items.map((item) => item.id), 'memory item ID');
  assertUnique(
    [
      ...dataset.queries.map((query) => query.id),
      ...dataset.duplicates.map((duplicate) => duplicate.id),
    ],
    'case ID',
  );
  const itemIds = new Set(dataset.items.map((item) => item.id));
  for (const query of dataset.queries) {
    if (!query.id || !query.query || !Number.isFinite(query.asOf)) {
      throw new Error(`Query case ${JSON.stringify(query.id)} has invalid required fields.`);
    }
    positiveInteger(query.topK, `query ${query.id}.topK`);
    if (!Array.isArray(query.relevantIds) || query.relevantIds.length === 0) {
      throw new Error(`Query case ${JSON.stringify(query.id)} needs relevantIds.`);
    }
    for (const id of [
      ...query.relevantIds,
      ...(query.expectedOrder ?? []),
      ...(query.candidateIds ?? []),
    ]) {
      if (!itemIds.has(id)) throw new Error(`Query case ${query.id} refers to unknown item ${id}.`);
    }
    for (const [id, score] of Object.entries(query.semanticScores ?? {})) {
      if (!itemIds.has(id)) throw new Error(`Query case ${query.id} has semantic score for unknown item ${id}.`);
      unitInterval(score, `query ${query.id}.semanticScores.${id}`);
    }
  }
  for (const duplicate of dataset.duplicates) {
    if (!duplicate.id || !duplicate.incoming) {
      throw new Error('Every duplicate case needs an id and incoming record.');
    }
    for (const id of duplicate.candidateIds ?? []) {
      if (!itemIds.has(id)) throw new Error(`Duplicate case ${duplicate.id} refers to unknown item ${id}.`);
    }
    if (
      duplicate.expectedSurvivorId !== undefined
      && !itemIds.has(duplicate.expectedSurvivorId)
    ) {
      throw new Error(
        `Duplicate case ${duplicate.id} expects unknown survivor ${duplicate.expectedSurvivorId}.`,
      );
    }
  }
}

function queryTerms(query: string): readonly string[] {
  return [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])];
}

function fraction(numerator: number, denominator: number): FractionMetric {
  return {
    value: denominator === 0 ? null : numerator / denominator,
    numerator,
    denominator,
  };
}

function runQueryCases(
  dataset: MemoryExperimentDataset,
  variant: MemoryExperimentVariant,
): readonly MemoryExperimentQueryOutcome[] {
  const itemById = new Map(dataset.items.map((item) => [item.id, item]));
  return dataset.queries.map((query) => {
    const terms = queryTerms(query.query);
    const candidateIds = query.candidateIds ?? dataset.items.map((item) => item.id);
    const ranked = candidateIds
      .map((id) => itemById.get(id))
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .map((item) => {
        const lexicalHit = terms.some(
          (term) => item.content.toLocaleLowerCase().includes(term),
        );
        const semanticValue = query.semanticScores?.[item.id];
        const semantic = semanticValue === undefined
          ? undefined
          : { available: true as const, score: semanticValue };
        return { item, lexicalHit, semantic };
      })
      .filter(({ lexicalHit, semantic }) => (
        terms.length === 0
        || semanticCandidateEligible(lexicalHit, semantic, MEMORY_SEMANTIC_FLOOR)
      ))
      .map(({ item, semantic }) => ({
        item,
        score: scoreMemoryCandidate({
          item,
          terms,
          core: item.core ?? false,
          asOf: query.asOf,
          semantic,
          weights: variant.ranking,
        }),
      }))
      .sort((left, right) => (
        right.score - left.score
        || right.item.updatedAt - left.item.updatedAt
        || left.item.id.localeCompare(right.item.id)
      ))
      .slice(0, query.topK);
    const actualIds = ranked.map(({ item }) => item.id);
    const relevant = new Set(query.relevantIds);
    const relevantHits = actualIds.filter((id) => relevant.has(id)).length;
    const firstRelevantIndex = actualIds.findIndex((id) => relevant.has(id));
    const expectedOrder = query.expectedOrder ?? [];
    return {
      caseId: query.id,
      expectedRelevantIds: [...query.relevantIds],
      expectedOrder: [...expectedOrder],
      actualIds,
      hit: relevantHits > 0,
      recallAtK: fraction(relevantHits, relevant.size),
      reciprocalRank: firstRelevantIndex < 0 ? 0 : 1 / (firstRelevantIndex + 1),
      exactOrderMatch: expectedOrder.length === 0
        ? null
        : expectedOrder.every((id, index) => actualIds[index] === id),
    };
  });
}

function runDuplicateCases(
  dataset: MemoryExperimentDataset,
  variant: MemoryExperimentVariant,
): readonly MemoryExperimentDuplicateOutcome[] {
  const itemById = new Map(dataset.items.map((item) => [item.id, item]));
  return dataset.duplicates.map((duplicate) => {
    const candidates = (duplicate.candidateIds ?? dataset.items.map((item) => item.id))
      .map((id) => itemById.get(id))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    const match = selectNearDuplicateCandidate(candidates, duplicate.incoming, variant.dedup);
    const actualSurvivorId = match?.candidate.id ?? null;
    const survivorCorrect = (
      duplicate.expectedSurvivorId === undefined
      || actualSurvivorId === duplicate.expectedSurvivorId
    );
    const correct = duplicate.expectedDuplicate
      ? match !== null && survivorCorrect
      : match === null;
    return {
      caseId: duplicate.id,
      expectedDuplicate: duplicate.expectedDuplicate,
      expectedSurvivorId: duplicate.expectedSurvivorId ?? null,
      predictedDuplicate: match !== null,
      actualSurvivorId,
      similarity: match?.similarity ?? null,
      correct,
    };
  });
}

function duplicateCounts(
  outcomes: readonly MemoryExperimentDuplicateOutcome[],
): DuplicateMergeCounts {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let trueNegatives = 0;
  for (const outcome of outcomes) {
    if (outcome.expectedDuplicate && outcome.correct) {
      truePositives++;
    } else if (outcome.expectedDuplicate) {
      falseNegatives++;
      if (outcome.predictedDuplicate) falsePositives++;
    } else if (outcome.predictedDuplicate) {
      falsePositives++;
    } else {
      trueNegatives++;
    }
  }
  return { truePositives, falsePositives, falseNegatives, trueNegatives };
}

export function runMemoryExperiment(
  dataset: MemoryExperimentDataset,
  variants: readonly MemoryExperimentVariant[],
): readonly MemoryExperimentResult[] {
  validateDataset(dataset);
  if (variants.length === 0) throw new Error('At least one experiment variant is required.');
  assertUnique(variants.map((variant) => variant.id), 'variant ID');

  return variants.map((variant) => {
    const queryOutcomes = runQueryCases(dataset, variant);
    const duplicateOutcomes = runDuplicateCases(dataset, variant);
    const counts = duplicateCounts(duplicateOutcomes);
    const recallHits = queryOutcomes.filter((outcome) => outcome.hit).length;
    const relevantHits = queryOutcomes.reduce(
      (sum, outcome) => sum + outcome.recallAtK.numerator,
      0,
    );
    const relevantExpected = queryOutcomes.reduce(
      (sum, outcome) => sum + outcome.recallAtK.denominator,
      0,
    );
    const reciprocalRankTotal = queryOutcomes.reduce(
      (sum, outcome) => sum + outcome.reciprocalRank,
      0,
    );
    const ordering = queryOutcomes.filter((outcome) => outcome.exactOrderMatch !== null);
    const correctOrdering = ordering.filter((outcome) => outcome.exactOrderMatch).length;

    return {
      variantId: variant.id,
      fixtureVersion: dataset.version,
      mode: dataset.queries.some((query) => Object.keys(query.semanticScores ?? {}).length > 0)
        ? 'fixture-semantic'
        : 'lexical-only',
      effectiveSettings: {
        ranking: variant.ranking,
        dedup: variant.dedup,
      },
      metrics: {
        recallHitRate: fraction(recallHits, queryOutcomes.length),
        recallAtK: fraction(relevantHits, relevantExpected),
        meanReciprocalRank: fraction(reciprocalRankTotal, queryOutcomes.length),
        rankingAccuracy: fraction(correctOrdering, ordering.length),
        duplicateMergePrecision: fraction(
          counts.truePositives,
          counts.truePositives + counts.falsePositives,
        ),
        duplicateRecall: fraction(
          counts.truePositives,
          counts.truePositives + counts.falseNegatives,
        ),
        duplicateCounts: counts,
      },
      queryOutcomes,
      duplicateOutcomes,
    };
  });
}
