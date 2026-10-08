import {
  MEMORY_REVIEW_RECENCY_HALF_LIFE_DAYS,
  compareMemoryReviewCandidates,
  memoryReviewScore,
} from '@/backend/services/enduringAgents/memoryReviewRanking';
import type { MemoryItem } from '@/shared/types/enduringAgent';

const DAY_MS = 24 * 60 * 60 * 1000;
const AS_OF = Date.UTC(2027, 0, 29);

function candidate(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    schemaVersion: 1,
    id: 'memory_review',
    personaId: 'persona_review',
    kind: 'semantic',
    scope: 'persona',
    status: 'candidate',
    content: 'A review candidate.',
    confidence: 1,
    importance: 0.5,
    sourceRefs: [{ kind: 'conversation', id: 'conversation_review' }],
    trust: 'model_inference',
    createdAt: AS_OF,
    updatedAt: AS_OF,
    ...overrides,
  };
}

describe('memory review ranking', () => {
  it('uses confidence multiplied by created-at recency with a documented half-life', () => {
    const fresh = candidate({ confidence: 0.5 });
    const halfLifeOld = candidate({
      confidence: 1,
      createdAt: AS_OF - MEMORY_REVIEW_RECENCY_HALF_LIFE_DAYS * DAY_MS,
    });

    expect(memoryReviewScore(fresh, AS_OF)).toBeCloseTo(0.5, 8);
    expect(memoryReviewScore(halfLifeOld, AS_OF)).toBeCloseTo(0.5, 8);
  });

  it('orders score ties by newer creation time and then stable id', () => {
    const sameScoreNewer = candidate({ id: 'memory_b', confidence: 0.5 });
    const sameScoreOlder = candidate({
      id: 'memory_c',
      confidence: 1,
      createdAt: AS_OF - MEMORY_REVIEW_RECENCY_HALF_LIFE_DAYS * DAY_MS,
    });
    const sameTimeAndScore = candidate({ id: 'memory_a', confidence: 0.5 });

    expect([
      sameScoreOlder,
      sameScoreNewer,
      sameTimeAndScore,
    ].sort((left, right) => compareMemoryReviewCandidates(left, right, AS_OF))
      .map(item => item.id)).toEqual(['memory_a', 'memory_b', 'memory_c']);
  });

  it('anchors future-dated candidates at full recency without exceeding confidence', () => {
    expect(memoryReviewScore(candidate({
      confidence: 0.8,
      createdAt: AS_OF + DAY_MS,
    }), AS_OF)).toBe(0.8);
  });
});
