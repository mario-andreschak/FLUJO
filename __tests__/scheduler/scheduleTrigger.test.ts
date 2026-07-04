/**
 * Tests for the croner-backed schedule trigger helpers: validation, next-run
 * preview, the catch-up predicate, and actual arm/fire/dispose behavior.
 */
import {
  validateSchedule,
  scheduleNextRuns,
  isCatchUpDue,
  armSchedule,
} from '@/backend/services/scheduler/triggers/schedule';

describe('validateSchedule', () => {
  it('accepts a standard 5-field pattern', () => {
    expect(validateSchedule('*/15 * * * *')).toEqual({ valid: true });
  });

  it('accepts a 6-field (seconds) pattern', () => {
    expect(validateSchedule('30 * * * * *')).toEqual({ valid: true });
  });

  it('rejects garbage patterns with an error message', () => {
    const result = validateSchedule('every day at nine');
    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('rejects an invalid timezone', () => {
    const result = validateSchedule('0 9 * * *', 'Middle/Earth');
    expect(result.valid).toBe(false);
  });
});

describe('scheduleNextRuns', () => {
  it('returns the requested number of strictly increasing ISO times', () => {
    const runs = scheduleNextRuns('0 9 * * *', undefined, 3);
    expect(runs).toHaveLength(3);
    const times = runs.map(iso => new Date(iso).getTime());
    expect(times[0]).toBeGreaterThan(Date.now());
    expect(times[1]).toBeGreaterThan(times[0]);
    expect(times[2]).toBeGreaterThan(times[1]);
  });
});

describe('isCatchUpDue', () => {
  const daily = { type: 'schedule' as const, cron: '0 9 * * *' };

  it('is due when an occurrence fell between the last fire and now', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(isCatchUpDue(daily, twoDaysAgo)).toBe(true);
  });

  it('is not due when the last fire is recent enough', () => {
    // Last "fire" 1 minute ago: the next daily-9am occurrence is in the future.
    const justNow = new Date(Date.now() - 60 * 1000).toISOString();
    expect(isCatchUpDue(daily, justNow)).toBe(false);
  });
});

describe('armSchedule', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('fires on schedule and stops firing after dispose', () => {
    const onFire = jest.fn();
    // 6-field croner pattern: every second.
    const trigger = armSchedule({ type: 'schedule', cron: '* * * * * *' }, onFire);

    jest.advanceTimersByTime(2100);
    expect(onFire.mock.calls.length).toBeGreaterThanOrEqual(2);

    const countAtDispose = onFire.mock.calls.length;
    trigger.dispose();
    jest.advanceTimersByTime(3000);
    expect(onFire).toHaveBeenCalledTimes(countAtDispose);
  });

  it('exposes the next run time', () => {
    const trigger = armSchedule({ type: 'schedule', cron: '0 9 * * *' }, jest.fn());
    const next = trigger.nextRun ? trigger.nextRun() : null;
    expect(next).toBeTruthy();
    expect(new Date(next as string).getTime()).toBeGreaterThan(Date.now());
    trigger.dispose();
  });
});
