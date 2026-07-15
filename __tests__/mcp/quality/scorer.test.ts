import {
  compositeScore,
  clamp01,
  normalizeCount,
  normalizeRecency,
  STARS_SATURATION,
  WEEKLY_DOWNLOADS_SATURATION,
} from '@/backend/services/mcp/quality/scorer';

describe('quality scorer', () => {
  describe('clamp01', () => {
    it('clamps and rejects non-finite', () => {
      expect(clamp01(-1)).toBe(0);
      expect(clamp01(0.5)).toBe(0.5);
      expect(clamp01(2)).toBe(1);
      expect(clamp01(NaN)).toBe(0);
      expect(clamp01(Infinity)).toBe(0); // non-finite guard runs first
    });
  });

  describe('normalizeCount', () => {
    it('is 0 at zero and ~1 at saturation, clamping beyond', () => {
      expect(normalizeCount(0, STARS_SATURATION)).toBe(0);
      expect(normalizeCount(STARS_SATURATION, STARS_SATURATION)).toBeCloseTo(1, 5);
      expect(normalizeCount(STARS_SATURATION * 10, STARS_SATURATION)).toBe(1);
    });

    it('is monotonic increasing on a log curve (early counts matter more)', () => {
      const a = normalizeCount(10, STARS_SATURATION);
      const b = normalizeCount(100, STARS_SATURATION);
      const c = normalizeCount(1000, STARS_SATURATION);
      expect(a).toBeLessThan(b);
      expect(b).toBeLessThan(c);
      // Log curve: 10→100 is a bigger jump than 10k→100k relative to range.
      expect(b - a).toBeGreaterThan(
        normalizeCount(100000, STARS_SATURATION) - normalizeCount(10000, STARS_SATURATION)
      );
    });

    it('handles the downloads saturation independently', () => {
      expect(normalizeCount(WEEKLY_DOWNLOADS_SATURATION, WEEKLY_DOWNLOADS_SATURATION)).toBeCloseTo(1, 5);
      expect(normalizeCount(-5, WEEKLY_DOWNLOADS_SATURATION)).toBe(0);
    });
  });

  describe('normalizeRecency', () => {
    const now = Date.parse('2026-07-15T00:00:00Z');
    const daysAgo = (d: number) => now - d * 24 * 60 * 60 * 1000;

    it('gives full credit when fresh and zero when dead/missing', () => {
      expect(normalizeRecency(daysAgo(5), now)).toBe(1);
      expect(normalizeRecency(daysAgo(30), now)).toBe(1);
      expect(normalizeRecency(daysAgo(9999), now)).toBe(0);
      expect(normalizeRecency(null, now)).toBe(0);
      expect(normalizeRecency(undefined, now)).toBe(0);
    });

    it('decays linearly between fresh and dead', () => {
      const mid = normalizeRecency(daysAgo((30 + 730) / 2), now);
      expect(mid).toBeGreaterThan(0.4);
      expect(mid).toBeLessThan(0.6);
    });
  });

  describe('compositeScore', () => {
    it('weighted-averages over the given contributions', () => {
      const { score } = compositeScore([
        { providerId: 'a', weight: 1, score: 1 },
        { providerId: 'b', weight: 1, score: 0 },
      ]);
      expect(score).toBeCloseTo(0.5, 6);
    });

    it('an applicable-but-failed provider (score 0) keeps its weight and drags the score down', () => {
      const withSignal = compositeScore([{ providerId: 'stars', weight: 0.5, score: 0.8 }]).score;
      const withFailedNpm = compositeScore([
        { providerId: 'stars', weight: 0.5, score: 0.8 },
        { providerId: 'npm', weight: 0.5, score: 0 }, // applicable but no data
      ]).score;
      expect(withFailedNpm).toBeLessThan(withSignal);
      expect(withFailedNpm).toBeCloseTo(0.4, 6);
    });

    it('is 0 when there are no positive-weight contributions', () => {
      expect(compositeScore([]).score).toBe(0);
      expect(compositeScore([{ providerId: 'x', weight: 0, score: 1 }]).score).toBe(0);
    });

    it('respects relative weights', () => {
      const { score } = compositeScore([
        { providerId: 'a', weight: 3, score: 1 },
        { providerId: 'b', weight: 1, score: 0 },
      ]);
      expect(score).toBeCloseTo(0.75, 6);
    });
  });
});
