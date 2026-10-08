import fixtureJson from '../fixtures/memory-ranking/golden-semantic-v1.json';

import { runMemoryExperiment } from '@/backend/services/enduringAgents/memoryExperimentHarness';
import type { MemoryExperimentDataset } from '@/backend/services/enduringAgents/memoryExperimentTypes';
import { CURRENT_MEMORY_VARIANT } from '@/backend/services/enduringAgents/memoryRanking';

const fixture = fixtureJson as unknown as MemoryExperimentDataset;

describe('semantic memory golden set (issue #471)', () => {
  it('improves recall and MRR over the lexical-only baseline without regressing lexical queries', () => {
    const lexicalFixture: MemoryExperimentDataset = {
      ...fixture,
      version: `${fixture.version}-lexical-baseline`,
      queries: fixture.queries.map(({ semanticScores: _semanticScores, ...query }) => query),
    };

    const [lexical] = runMemoryExperiment(lexicalFixture, [CURRENT_MEMORY_VARIANT]);
    const [hybrid] = runMemoryExperiment(fixture, [CURRENT_MEMORY_VARIANT]);

    expect(lexical.mode).toBe('lexical-only');
    expect(hybrid.mode).toBe('fixture-semantic');
    expect(hybrid.metrics.recallAtK.value).toBeGreaterThan(
      lexical.metrics.recallAtK.value ?? 0,
    );
    expect(hybrid.metrics.meanReciprocalRank.value).toBeGreaterThan(
      lexical.metrics.meanReciprocalRank.value ?? 0,
    );
    expect(hybrid.queryOutcomes.find(({ caseId }) => caseId === 'ship-process')?.actualIds)
      .toEqual(['release-branch']);
    expect(hybrid.queryOutcomes.find(({ caseId }) => caseId === 'lexical-weekly')?.actualIds)
      .toEqual(lexical.queryOutcomes.find(({ caseId }) => caseId === 'lexical-weekly')?.actualIds);
  });
});
