import fixtureJson from '../fixtures/memory-ranking/golden-v1.json';
import {
  createMemoryExperimentVariant,
  runMemoryExperiment,
} from '@/backend/services/enduringAgents/memoryExperimentHarness';
import type {
  MemoryExperimentDataset,
  MemoryRankingCandidate,
} from '@/backend/services/enduringAgents/memoryExperimentTypes';
import {
  CURRENT_MEMORY_VARIANT,
  MEMORY_DEDUP_SETTINGS,
  MEMORY_RANKING_WEIGHTS,
  scoreMemoryCandidate,
  selectNearDuplicateCandidate,
} from '@/backend/services/enduringAgents/memoryRanking';

const fixture = fixtureJson as unknown as MemoryExperimentDataset;
const asOf = 2_000_000_000_000;
const day = 24 * 60 * 60 * 1_000;

const candidate = (
  overrides: Partial<MemoryRankingCandidate> = {},
): MemoryRankingCandidate => ({
  id: 'candidate',
  content: 'release stable',
  confidence: 0.5,
  importance: 0.5,
  trust: 'model_inference',
  updatedAt: asOf - day,
  ...overrides,
});

function score(
  item: MemoryRankingCandidate,
  terms: readonly string[],
  variant = CURRENT_MEMORY_VARIANT,
): number {
  return scoreMemoryCandidate({
    item,
    terms,
    core: false,
    asOf,
    weights: variant.ranking,
  });
}

describe('memory ranking experiment harness (issue #466)', () => {
  it('reproduces all checked-in baseline expectations and metrics', () => {
    const baselineCandidate = candidate();
    expect(scoreMemoryCandidate({
      item: baselineCandidate,
      terms: ['release'],
      core: false,
      asOf,
    })).toBe(scoreMemoryCandidate({
      item: baselineCandidate,
      terms: ['release'],
      core: false,
      asOf,
      weights: MEMORY_RANKING_WEIGHTS,
    }));

    const [result] = runMemoryExperiment(fixture, [CURRENT_MEMORY_VARIANT]);

    expect(result.mode).toBe('lexical-only');
    expect(result.queryOutcomes.every((outcome) => (
      outcome.hit && outcome.exactOrderMatch !== false
    ))).toBe(true);
    expect(result.duplicateOutcomes.every((outcome) => outcome.correct)).toBe(true);
    expect(result.metrics.recallHitRate.value).toBe(1);
    expect(result.metrics.rankingAccuracy.value).toBe(1);
    expect(result.metrics.duplicateMergePrecision.value).toBe(1);
    expect(result.metrics.duplicateRecall.value).toBe(1);
  });

  it('evaluates sequential and concurrent variants without leaking configuration', async () => {
    const defaultsBefore = JSON.stringify({
      ranking: MEMORY_RANKING_WEIGHTS,
      dedup: MEMORY_DEDUP_SETTINGS,
    });
    const fastDecay = createMemoryExperimentVariant({
      id: 'fast-decay',
      ranking: { recencyHalfLifeDays: 15 },
    });
    const strictDedup = createMemoryExperimentVariant({
      id: 'strict-dedup',
      dedup: { nearDuplicateThreshold: 0.99 },
    });

    const sequential = runMemoryExperiment(fixture, [
      CURRENT_MEMORY_VARIANT,
      fastDecay,
      strictDedup,
    ]);
    const concurrent = await Promise.all([
      Promise.resolve(runMemoryExperiment(fixture, [fastDecay])),
      Promise.resolve(runMemoryExperiment(fixture, [strictDedup])),
    ]);

    expect(concurrent[0][0]).toEqual(sequential[1]);
    expect(concurrent[1][0]).toEqual(sequential[2]);
    expect(JSON.stringify({
      ranking: MEMORY_RANKING_WEIGHTS,
      dedup: MEMORY_DEDUP_SETTINGS,
    })).toBe(defaultsBefore);
  });

  it('applies ranking overrides only through the supplied variant', () => {
    const baselineItem = candidate();
    const variants = {
      importance: createMemoryExperimentVariant({
        id: 'importance',
        ranking: { importanceWeight: 1 },
      }),
      confidence: createMemoryExperimentVariant({
        id: 'confidence',
        ranking: { confidenceWeight: 1 },
      }),
      exact: createMemoryExperimentVariant({
        id: 'exact',
        ranking: { exactContentMatchBonus: 8 },
      }),
      hit: createMemoryExperimentVariant({
        id: 'hit',
        ranking: { termHitBonus: 3 },
      }),
      coverage: createMemoryExperimentVariant({
        id: 'coverage',
        ranking: { termCoverageBonus: 4 },
      }),
      recency: createMemoryExperimentVariant({
        id: 'recency',
        ranking: { recencyHalfLifeDays: 365 },
      }),
      trust: createMemoryExperimentVariant({
        id: 'trust',
        ranking: { trustWeights: { model_inference: 2 } },
      }),
      length: createMemoryExperimentVariant({
        id: 'length',
        ranking: { lengthNormalisationChars: 10_000 },
      }),
    };

    expect(score(candidate({ importance: 1 }), [], variants.importance))
      .toBeGreaterThan(score(candidate({ importance: 1 }), []));
    expect(score(candidate({ confidence: 1 }), [], variants.confidence))
      .toBeGreaterThan(score(candidate({ confidence: 1 }), []));
    expect(score(candidate({ content: 'release' }), ['release'], variants.exact))
      .toBeGreaterThan(score(candidate({ content: 'release' }), ['release']));
    expect(score(baselineItem, ['release'], variants.hit))
      .toBeGreaterThan(score(baselineItem, ['release']));
    expect(score(baselineItem, ['release', 'stable'], variants.coverage))
      .toBeGreaterThan(score(baselineItem, ['release', 'stable']));
    expect(score(candidate({ updatedAt: asOf - 180 * day }), [], variants.recency))
      .toBeGreaterThan(score(candidate({ updatedAt: asOf - 180 * day }), []));
    expect(score(baselineItem, [], variants.trust))
      .toBeGreaterThan(score(baselineItem, []));
    expect(score(candidate({ content: 'x'.repeat(1_000) }), [], variants.length))
      .toBeGreaterThan(score(candidate({ content: 'x'.repeat(1_000) }), []));
  });

  it('uses a deterministic comparison window and survivor tie-break', () => {
    const candidates = [
      {
        id: 'new-unrelated',
        content: 'nothing alike',
        kind: 'semantic' as const,
        scope: 'persona' as const,
        status: 'active' as const,
        updatedAt: 20,
      },
      {
        id: 'z-duplicate',
        content: 'release branch stable',
        kind: 'semantic' as const,
        scope: 'persona' as const,
        status: 'active' as const,
        updatedAt: 10,
      },
      {
        id: 'a-duplicate',
        content: 'release branch stable',
        kind: 'semantic' as const,
        scope: 'persona' as const,
        status: 'active' as const,
        updatedAt: 10,
      },
    ];
    const incoming = {
      content: 'release branch stable',
      kind: 'semantic' as const,
      scope: 'persona' as const,
    };
    const windowOne = createMemoryExperimentVariant({
      id: 'window-one',
      dedup: { comparisonWindow: 1 },
    });
    const windowThree = createMemoryExperimentVariant({
      id: 'window-three',
      dedup: { comparisonWindow: 3 },
    });

    expect(selectNearDuplicateCandidate(candidates, incoming, windowOne.dedup)).toBeNull();
    expect(
      selectNearDuplicateCandidate(candidates, incoming, windowThree.dedup)?.candidate.id,
    ).toBe('a-duplicate');
  });

  it('rejects unknown, invalid, and duplicate variant IDs', () => {
    expect(() => createMemoryExperimentVariant({
      id: 'unknown',
      ranking: { surprise: 1 },
    })).toThrow(/unknown key/i);
    expect(() => createMemoryExperimentVariant({
      id: 'invalid-threshold',
      dedup: { nearDuplicateThreshold: 2 },
    })).toThrow(/between 0 and 1/i);
    expect(() => runMemoryExperiment(fixture, [
      CURRENT_MEMORY_VARIANT,
      createMemoryExperimentVariant({ id: 'current' }),
    ])).toThrow(/duplicate variant id/i);
  });

  it('reports null for metrics with zero denominators', () => {
    const dataset: MemoryExperimentDataset = {
      ...fixture,
      duplicates: [],
    };
    const [result] = runMemoryExperiment(dataset, [CURRENT_MEMORY_VARIANT]);

    expect(result.metrics.duplicateMergePrecision).toEqual({
      value: null,
      numerator: 0,
      denominator: 0,
    });
    expect(result.metrics.duplicateRecall.value).toBeNull();
  });
});
