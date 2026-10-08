import {
  enumerateOccurrences,
  timelineFraction,
  timelineTicks,
  timelineTickStep,
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

describe('timelineTicks (#209)', () => {
  test('per-window step choices produce evenly spaced ticks spanning [now, now+window]', () => {
    expect(timelineTickStep(WAVE_WINDOWS['1h'])).toBe(10 * 60 * 1000);
    expect(timelineTickStep(WAVE_WINDOWS['6h'])).toBe(60 * 60 * 1000);
    expect(timelineTickStep(WAVE_WINDOWS['1d'])).toBe(4 * 60 * 60 * 1000);

    const ticks = timelineTicks(FROM, WAVE_WINDOWS['1h']);
    // 0,10,20,30,40,50,60 minutes = 7 ticks.
    expect(ticks).toHaveLength(7);
    expect(ticks[0].fraction).toBe(0);
    expect(ticks[ticks.length - 1].fraction).toBe(1);
    // Evenly spaced by 10 minutes.
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i].atMs - ticks[i - 1].atMs).toBe(10 * 60 * 1000);
    }
  });

  test('labels are offset-from-now (now, 10m, 1h, ...)', () => {
    const ticks = timelineTicks(FROM, WAVE_WINDOWS['1h']);
    expect(ticks.map((t) => t.label)).toEqual(['now', '10m', '20m', '30m', '40m', '50m', '1h']);
    const sixHour = timelineTicks(FROM, WAVE_WINDOWS['6h']);
    expect(sixHour[0].label).toBe('now');
    expect(sixHour[1].label).toBe('1h');
  });

  test('each tick lands exactly where a card at that instant would (aligns with timelineFraction)', () => {
    const windowMs = WAVE_WINDOWS['6h'];
    for (const t of timelineTicks(FROM, windowMs)) {
      expect(t.fraction).toBeCloseTo(timelineFraction(t.atMs, FROM, windowMs), 6);
    }
  });

  test('invalid inputs yield no ticks', () => {
    expect(timelineTicks(NaN, WAVE_WINDOWS['1h'])).toEqual([]);
    expect(timelineTicks(FROM, 0)).toEqual([]);
    expect(timelineTicks(FROM, -1000)).toEqual([]);
  });
});
