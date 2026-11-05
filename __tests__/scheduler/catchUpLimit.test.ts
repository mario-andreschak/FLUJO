import {
  catchUpOccurrence, catchUpOccurrences, MAX_CATCH_UP_LIMIT, validateCatchUpLimit,
} from '@/backend/services/scheduler/triggers/schedule';

const hourly = { type: 'schedule' as const, cron: '0 * * * *', timezone: 'UTC' };
const start = '2026-11-01T00:30:00.000Z';
const through = Date.parse('2026-11-01T06:30:00.000Z');

describe('catchUpOccurrences', () => {
  it('with no limit behaves exactly as before: the first missed occurrence, once', () => {
    const found = catchUpOccurrences(hourly, start, through);
    expect(found).toHaveLength(1);
    expect(found[0].toISOString()).toBe('2026-11-01T01:00:00.000Z');
    expect(found[0]).toEqual(catchUpOccurrence(hourly, start, through));
  });

  it('with a limit: the newest ones, oldest of those first', () => {
    const found = catchUpOccurrences({ ...hourly, catchUpLimit: 3 }, start, through);
    expect(found.map(date => date.toISOString())).toEqual([
      '2026-11-01T04:00:00.000Z', '2026-11-01T05:00:00.000Z', '2026-11-01T06:00:00.000Z',
    ]);
  });

  it('a limit larger than what was missed gives just what was missed', () => {
    expect(catchUpOccurrences({ ...hourly, catchUpLimit: 50 }, start, through)).toHaveLength(6);
  });

  it('nothing missed means nothing to run', () => {
    expect(catchUpOccurrences(hourly, '2026-11-01T06:10:00.000Z', through)).toEqual([]);
    expect(catchUpOccurrences({ ...hourly, catchUpLimit: 5 }, '2026-11-01T06:10:00.000Z', through)).toEqual([]);
  });

  it('never returns more than the limit after a long outage, and finishes quickly', () => {
    const everyMinute = { type: 'schedule' as const, cron: '* * * * *', timezone: 'UTC', catchUpLimit: 100 };
    const longAgo = '2026-10-01T00:00:00.000Z';
    const found = catchUpOccurrences(everyMinute, longAgo, Date.parse('2026-11-01T00:00:00.000Z'));
    expect(found).toHaveLength(100);
    expect(found[0].getTime()).toBeLessThan(found[99].getTime());
  });

  it('a stored bad limit is held to the allowed range', () => {
    expect(catchUpOccurrences({ ...hourly, catchUpLimit: 0 }, start, through)).toHaveLength(1);
    expect(catchUpOccurrences({ ...hourly, catchUpLimit: 100000 }, start, through)).toHaveLength(6);
  });
});

describe('validateCatchUpLimit', () => {
  it('accepts nothing at all and whole numbers in range', () => {
    expect(validateCatchUpLimit(undefined)).toBeUndefined();
    expect(validateCatchUpLimit(1)).toBeUndefined();
    expect(validateCatchUpLimit(MAX_CATCH_UP_LIMIT)).toBeUndefined();
  });

  it.each([0, -1, 1.5, MAX_CATCH_UP_LIMIT + 1, '5', null, Number.NaN])('refuses %p', value => {
    expect(validateCatchUpLimit(value)).toMatch(/catchUpLimit/);
  });
});
