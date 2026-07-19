import {
  enumerateOccurrences,
  timelineFraction,
  WAVE_WINDOWS,
  MAX_OCCURRENCES,
} from '@/frontend/components/Waves/waveTimeline';

const FROM = Date.parse('2026-07-17T12:00:00.000Z');

describe('enumerateOccurrences (#144)', () => {
  test('an hourly cron over a 1-day window yields multiple, capped, strictly increasing runs', () => {
    const occ = enumerateOccurrences('0 * * * *', FROM, WAVE_WINDOWS['1d']);
    expect(occ.length).toBeGreaterThan(1);
    expect(occ.length).toBeLessThanOrEqual(MAX_OCCURRENCES);
    for (let i = 1; i < occ.length; i++) {
      expect(occ[i]).toBeGreaterThan(occ[i - 1]);
    }
    // Every occurrence sits inside the window.
    for (const t of occ) {
      expect(t).toBeGreaterThanOrEqual(FROM);
      expect(t).toBeLessThanOrEqual(FROM + WAVE_WINDOWS['1d']);
    }
  });

  test('a wider window never yields fewer runs than a narrower one', () => {
    const h = enumerateOccurrences('0 * * * *', FROM, WAVE_WINDOWS['1h']);
    const d = enumerateOccurrences('0 * * * *', FROM, WAVE_WINDOWS['1d']);
    expect(d.length).toBeGreaterThanOrEqual(h.length);
  });

  test('absent / blank / invalid cron patterns resolve to no occurrences', () => {
    expect(enumerateOccurrences(undefined, FROM, WAVE_WINDOWS['6h'])).toEqual([]);
    expect(enumerateOccurrences(null, FROM, WAVE_WINDOWS['6h'])).toEqual([]);
    expect(enumerateOccurrences('', FROM, WAVE_WINDOWS['6h'])).toEqual([]);
    expect(enumerateOccurrences('   ', FROM, WAVE_WINDOWS['6h'])).toEqual([]);
    expect(enumerateOccurrences('this is not a cron', FROM, WAVE_WINDOWS['6h'])).toEqual([]);
  });

  test('is deterministic for a fixed anchor', () => {
    const a = enumerateOccurrences('*/15 * * * *', FROM, WAVE_WINDOWS['6h']);
    const b = enumerateOccurrences('*/15 * * * *', FROM, WAVE_WINDOWS['6h']);
    expect(a).toEqual(b);
  });
});

describe('timelineFraction', () => {
  test('due-now / past runs clamp to 0 (left, next to the clock)', () => {
    expect(timelineFraction(FROM, FROM, WAVE_WINDOWS['6h'])).toBe(0);
    expect(timelineFraction(FROM - 1000, FROM, WAVE_WINDOWS['6h'])).toBe(0);
  });

  test('a run a full window away clamps to 1 (far right)', () => {
    expect(timelineFraction(FROM + WAVE_WINDOWS['6h'] * 2, FROM, WAVE_WINDOWS['6h'])).toBe(1);
  });

  test('a mid-window run maps proportionally', () => {
    const f = timelineFraction(FROM + WAVE_WINDOWS['6h'] / 2, FROM, WAVE_WINDOWS['6h']);
    expect(f).toBeCloseTo(0.5, 5);
  });

  test('a null run time is treated as 0', () => {
    expect(timelineFraction(null, FROM, WAVE_WINDOWS['6h'])).toBe(0);
  });
});
