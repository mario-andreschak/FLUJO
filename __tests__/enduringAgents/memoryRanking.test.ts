import {
  MEMORY_RANKING_WEIGHTS,
  MEMORY_DEDUP_SETTINGS,
  normaliseMemoryContent,
  contentShingles,
  jaccardSimilarity,
  recencyMultiplier,
  contentLengthFactor,
  trustWeight,
  scoreMemoryCandidate,
} from '@/backend/services/enduringAgents/memoryRanking';
import type { MemoryItem } from '@/shared/types/enduringAgent/enduringAgent';

describe('Memory Ranking (Issue #450)', () => {
  describe('normaliseMemoryContent', () => {
    it('lowercases content', () => {
      expect(normaliseMemoryContent('HELLO WORLD')).toBe('hello world');
    });

    it('strips punctuation', () => {
      expect(normaliseMemoryContent('Hello, world!')).toBe('hello world');
    });

    it('collapses whitespace', () => {
      expect(normaliseMemoryContent('Hello    world\n\tfoo')).toBe('hello world foo');
    });

    it('trims leading/trailing whitespace', () => {
      expect(normaliseMemoryContent('  hello  ')).toBe('hello');
    });

    it('handles NFKC normalisation', () => {
      // ﬁ (fi ligature) becomes f + i
      expect(normaliseMemoryContent('ﬁnish')).toBe('finish');
    });

    it('preserves hyphens and underscores', () => {
      expect(normaliseMemoryContent('snake_case and dash-case')).toBe('snake_case and dash case');
    });

    it('handles mixed punctuation and case', () => {
      expect(normaliseMemoryContent('The Release Branch: Stable!')).toBe('the release branch stable');
    });
  });

  describe('contentShingles', () => {
    it('generates trigrams from a string', () => {
      const shingles = contentShingles('hello');
      expect(shingles).toEqual(new Set(['hel', 'ell', 'llo']));
    });

    it('uses custom shingle size', () => {
      const shingles = contentShingles('hello', 2);
      expect(shingles).toEqual(new Set(['he', 'el', 'll', 'lo']));
    });

    it('handles strings shorter than shingle size', () => {
      const shingles = contentShingles('hi', 3);
      expect(shingles).toEqual(new Set(['hi']));
    });

    it('returns empty set for empty string', () => {
      const shingles = contentShingles('', 3);
      expect(shingles).toEqual(new Set());
    });

    it('returns single-char shingles for length=1', () => {
      const shingles = contentShingles('hello', 1);
      expect(shingles).toEqual(new Set(['h', 'e', 'l', 'o']));
    });

    it('is case-sensitive (relies on normalisation upstream)', () => {
      const shingles = contentShingles('Hello');
      expect(shingles).toEqual(new Set(['Hel', 'ell', 'llo']));
    });
  });

  describe('jaccardSimilarity', () => {
    it('returns 1 for identical sets', () => {
      const a = new Set(['a', 'b', 'c']);
      const b = new Set(['a', 'b', 'c']);
      expect(jaccardSimilarity(a, b)).toBe(1);
    });

    it('returns 0 for disjoint sets', () => {
      const a = new Set(['a', 'b']);
      const b = new Set(['c', 'd']);
      expect(jaccardSimilarity(a, b)).toBe(0);
    });

    it('computes correct Jaccard for partial overlap', () => {
      const a = new Set(['a', 'b', 'c']);
      const b = new Set(['b', 'c', 'd']);
      // intersection: {b, c} (2), union: {a, b, c, d} (4), Jaccard = 2/4 = 0.5
      expect(jaccardSimilarity(a, b)).toBe(0.5);
    });

    it('returns 1 for two empty sets', () => {
      const a = new Set<string>();
      const b = new Set<string>();
      expect(jaccardSimilarity(a, b)).toBe(1);
    });

    it('returns 0 when one set is empty', () => {
      const a = new Set(['a', 'b']);
      const b = new Set<string>();
      expect(jaccardSimilarity(a, b)).toBe(0);
    });
  });

  describe('recencyMultiplier', () => {
    const now = 1000000;

    it('returns 1 for a fresh item (updatedAt === now)', () => {
      expect(recencyMultiplier(now, now)).toBe(1);
    });

    it('returns < 1 for an old item', () => {
      const oneDayMs = 1000 * 60 * 60 * 24;
      const oneDay = recencyMultiplier(now - oneDayMs, now);
      expect(oneDay).toBeLessThan(1);
      expect(oneDay).toBeGreaterThan(0);
    });

    it('decays exponentially with age', () => {
      const oneDayMs = 1000 * 60 * 60 * 24;
      const oneDay = recencyMultiplier(now - oneDayMs, now);
      const ninetyDays = recencyMultiplier(now - 90 * oneDayMs, now);
      expect(oneDay).toBeGreaterThan(ninetyDays);
    });

    it('applies half-life decay (at halfLife, multiplier ≈ 0.5)', () => {
      const halfLifeMs = MEMORY_RANKING_WEIGHTS.recencyHalfLifeDays * 1000 * 60 * 60 * 24;
      const multiplier = recencyMultiplier(now - halfLifeMs, now);
      expect(multiplier).toBeCloseTo(0.5, 1);
    });

    it('returns 1 for core-pinned items (exempt from decay)', () => {
      const oneDayMs = 1000 * 60 * 60 * 24;
      const ninetyDaysAgo = now - 90 * oneDayMs;
      expect(recencyMultiplier(ninetyDaysAgo, now, { core: true })).toBe(1);
    });

    it('clamps to floor for very old items', () => {
      const veryOld = now - 10000 * 1000 * 60 * 60 * 24;
      expect(recencyMultiplier(veryOld, now)).toBe(MEMORY_RANKING_WEIGHTS.recencyFloor);
    });

    it('clamps negative age (future updatedAt) to 1', () => {
      const future = now + 1000 * 60 * 60 * 24;
      expect(recencyMultiplier(future, now)).toBe(1);
    });

    it('respects custom halfLifeDays', () => {
      const oneDayMs = 1000 * 60 * 60 * 24;
      const thirtyDaysAgo = now - 30 * oneDayMs;
      const m30 = recencyMultiplier(thirtyDaysAgo, now, { halfLifeDays: 30 });
      expect(m30).toBeCloseTo(0.5, 1);
    });

    it('respects custom floor', () => {
      const veryOld = now - 10000 * 1000 * 60 * 60 * 24;
      const customFloor = 0.25;
      expect(recencyMultiplier(veryOld, now, { floor: customFloor })).toBe(customFloor);
    });
  });

  describe('contentLengthFactor', () => {
    it('returns 1 for lengths at or below midpoint', () => {
      const midpoint = MEMORY_RANKING_WEIGHTS.lengthNormalisationChars;
      expect(contentLengthFactor(0)).toBe(1);
      expect(contentLengthFactor(midpoint)).toBe(1);
    });

    it('returns < 1 for lengths above midpoint', () => {
      const midpoint = MEMORY_RANKING_WEIGHTS.lengthNormalisationChars;
      // Just above midpoint should be less than 1
      expect(contentLengthFactor(midpoint + 1)).toBeLessThan(1);
    });

    it('clamps to floor for very long content', () => {
      expect(contentLengthFactor(10000)).toBe(MEMORY_RANKING_WEIGHTS.lengthNormalisationFloor);
    });

    it('dampens longer content more than shorter content', () => {
      const short = contentLengthFactor(300);
      const long = contentLengthFactor(5000);
      // Both may hit floor, but if they don't, long should be <= short
      expect(short).toBeGreaterThanOrEqual(long);
    });
  });

  describe('trustWeight', () => {
    it('returns explicit_user weight', () => {
      expect(trustWeight('explicit_user')).toBe(MEMORY_RANKING_WEIGHTS.trustWeights.explicit_user);
    });

    it('returns verified_tool weight', () => {
      expect(trustWeight('verified_tool')).toBe(MEMORY_RANKING_WEIGHTS.trustWeights.verified_tool);
    });

    it('returns model_inference weight', () => {
      expect(trustWeight('model_inference')).toBe(MEMORY_RANKING_WEIGHTS.trustWeights.model_inference);
    });

    it('returns external_untrusted weight', () => {
      expect(trustWeight('external_untrusted')).toBe(MEMORY_RANKING_WEIGHTS.trustWeights.external_untrusted);
    });

    it('has explicit_user > verified_tool > model_inference > external_untrusted', () => {
      const weights = MEMORY_RANKING_WEIGHTS.trustWeights;
      expect(weights.explicit_user).toBeGreaterThan(weights.verified_tool);
      expect(weights.verified_tool).toBeGreaterThan(weights.model_inference);
      expect(weights.model_inference).toBeGreaterThan(weights.external_untrusted);
    });
  });

  describe('scoreMemoryCandidate', () => {
    const now = 1000000;

    const baseItem = (overrides: Partial<MemoryItem> = {}): MemoryItem => ({
      schemaVersion: 1,
      id: 'mem-1',
      personaId: 'persona-1',
      kind: 'semantic',
      scope: 'persona',
      status: 'active',
      content: 'The release branch is stable',
      confidence: 0.8,
      importance: 0.7,
      trust: 'explicit_user',
      createdAt: now,
      updatedAt: now,
      sourceRefs: [],
      ...overrides,
    });

    it('scores fresh items higher than old items', () => {
      const fresh = baseItem({ updatedAt: now });
      const oneDayAgo = baseItem({ updatedAt: now - 1000 * 60 * 60 * 24 });

      const freshScore = scoreMemoryCandidate({ item: fresh, terms: [], core: false, asOf: now });
      const oldScore = scoreMemoryCandidate({ item: oneDayAgo, terms: [], core: false, asOf: now });

      expect(freshScore).toBeGreaterThan(oldScore);
    });

    it('applies core bonus (additive)', () => {
      const item = baseItem();
      const scoreSansCore = scoreMemoryCandidate({ item, terms: [], core: false, asOf: now });
      const scoreWithCore = scoreMemoryCandidate({ item, terms: [], core: true, asOf: now });

      expect(scoreWithCore - scoreSansCore).toBeCloseTo(MEMORY_RANKING_WEIGHTS.coreBonus, 5);
    });

    it('does not decay core items', () => {
      const old = baseItem({ updatedAt: now - 90 * 1000 * 60 * 60 * 24 });
      const fresh = baseItem({ updatedAt: now });

      // Both scored as core items
      const oldCoreScore = scoreMemoryCandidate({ item: old, terms: [], core: true, asOf: now });
      const freshCoreScore = scoreMemoryCandidate({ item: fresh, terms: [], core: true, asOf: now });

      // Scores differ only by the fresh vs old non-core decay (which is 0 for core), plus updatedAt
      // Actually, for core items, there's no decay applied, so the scores should differ only by trust/length factors
      // Let me rethink: core items get exempt from decay, so recencyMultiplier returns 1
      // The scores should be nearly identical (only updatedAt itself doesn't enter the formula)
      expect(oldCoreScore).toBeCloseTo(freshCoreScore, 5);
    });

    it('weights trust levels correctly', () => {
      const userTrust = baseItem({ trust: 'explicit_user' });
      const toolTrust = baseItem({ trust: 'verified_tool' });
      const modelTrust = baseItem({ trust: 'model_inference' });

      const userScore = scoreMemoryCandidate({ item: userTrust, terms: [], core: false, asOf: now });
      const toolScore = scoreMemoryCandidate({ item: toolTrust, terms: [], core: false, asOf: now });
      const modelScore = scoreMemoryCandidate({ item: modelTrust, terms: [], core: false, asOf: now });

      expect(userScore).toBeGreaterThan(toolScore);
      expect(toolScore).toBeGreaterThan(modelScore);
    });

    it('applies length normalisation', () => {
      const short = baseItem({ content: 'fact' });
      const long = baseItem({ content: 'a'.repeat(1000) });

      const shortScore = scoreMemoryCandidate({ item: short, terms: [], core: false, asOf: now });
      const longScore = scoreMemoryCandidate({ item: long, terms: [], core: false, asOf: now });

      expect(shortScore).toBeGreaterThan(longScore);
    });

    it('scores exact term matches higher than substring matches', () => {
      const exactMatch = baseItem({ content: 'stable' });
      const substringMatch = baseItem({ content: 'the release branch is stable' });

      const exactScore = scoreMemoryCandidate({ item: exactMatch, terms: ['stable'], core: false, asOf: now });
      const substringScore = scoreMemoryCandidate({ item: substringMatch, terms: ['stable'], core: false, asOf: now });

      expect(exactScore).toBeGreaterThan(substringScore);
    });

    it('applies term coverage bonus', () => {
      const oneTermMatch = baseItem({ content: 'release stable' });
      const twoTermMatch = baseItem({ content: 'release stable branch' });

      const oneTermScore = scoreMemoryCandidate({ item: oneTermMatch, terms: ['release', 'stable', 'branch'], core: false, asOf: now });
      const twoTermScore = scoreMemoryCandidate({ item: twoTermMatch, terms: ['release', 'stable', 'branch'], core: false, asOf: now });

      expect(twoTermScore).toBeGreaterThan(oneTermScore);
    });

    it('weights importance and confidence', () => {
      const lowConfidence = baseItem({ confidence: 0.3, importance: 0.3 });
      const highConfidence = baseItem({ confidence: 0.9, importance: 0.9 });

      const lowScore = scoreMemoryCandidate({ item: lowConfidence, terms: [], core: false, asOf: now });
      const highScore = scoreMemoryCandidate({ item: highConfidence, terms: [], core: false, asOf: now });

      expect(highScore).toBeGreaterThan(lowScore);
    });
  });

  describe('MEMORY_RANKING_WEIGHTS constants', () => {
    it('has sensible defaults', () => {
      expect(MEMORY_RANKING_WEIGHTS.recencyHalfLifeDays).toBe(90);
      expect(MEMORY_RANKING_WEIGHTS.recencyFloor).toBe(0.15);
      // nearDuplicateThreshold lives in MEMORY_DEDUP_SETTINGS, not in the ranking weights
      expect('nearDuplicateThreshold' in MEMORY_RANKING_WEIGHTS).toBe(false);
      expect(MEMORY_RANKING_WEIGHTS.coreBonus).toBe(2);
      expect(MEMORY_RANKING_WEIGHTS.coreExemptFromDecay).toBe(true);
    });
  });

  describe('MEMORY_DEDUP_SETTINGS constants', () => {
    it('has sensible dedup defaults', () => {
      expect(MEMORY_DEDUP_SETTINGS.enabled).toBe(true);
      expect(MEMORY_DEDUP_SETTINGS.shingleSize).toBe(3);
      expect(MEMORY_DEDUP_SETTINGS.nearDuplicateThreshold).toBe(0.82);
      expect(MEMORY_DEDUP_SETTINGS.comparisonWindow).toBe(200);
      expect(MEMORY_DEDUP_SETTINGS.maxSourceRefsPerItem).toBe(64);
      expect(MEMORY_DEDUP_SETTINGS.confidenceReinforcementStep).toBe(0.05);
      expect(MEMORY_DEDUP_SETTINGS.importanceReinforcementStep).toBe(0.02);
    });
  });
});
