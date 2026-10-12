import { claudeAllowanceSnapshot, collectClaudeAllowance, normalizeClaudeAllowance } from '@/backend/services/model/allowance/claude';

describe('Claude subscription allowance', () => {
  it('uses account percentages, never session costs or token totals', () => {
    const result = normalizeClaudeAllowance({
      session: { total_cost_usd: 999, model_usage: { opus: { inputTokens: 1_000_000 } } },
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 25, resets_at: '2026-10-10T00:00:00Z' },
        seven_day_opus: { utilization: 90, resets_at: null } },
    }, 'opaque-account', '2026-10-09T00:00:00Z');
    expect(result.windows).toEqual([
      { key: 'five_hour', label: 'Five hours', remainingPercent: 75, resetAt: '2026-10-10T00:00:00.000Z', model: null },
      { key: 'seven_day_opus', label: 'Weekly Opus', remainingPercent: 10, resetAt: null, model: 'opus' },
    ]);
    const snapshot = claudeAllowanceSnapshot(result);
    expect(snapshot.windows[1]).toEqual({ id: 'seven_day_opus', label: 'Weekly Opus', remainingPercent: 10, resetAt: null, modelFamily: 'opus' });
    expect(snapshot).not.toHaveProperty('accountKey');
  });

  it('keeps missing and invalid readings unknown', () => {
    expect(normalizeClaudeAllowance({ rate_limits_available: false, rate_limits: null }, 'account').available).toBe(false);
    const result = normalizeClaudeAllowance({ rate_limits_available: true, rate_limits: {
      five_hour: { utilization: null, resets_at: 'not a date' },
      seven_day: { utilization: 101, resets_at: null },
    } }, 'account');
    expect(result.windows.map(row => row.remainingPercent)).toEqual([null, null]);
    expect(result.windows.every(row => row.resetAt === null)).toBe(true);
  });

  it('uses only the live query control request and skips transcript scanning', async () => {
    const method = jest.fn().mockResolvedValue({ rate_limits_available: true, rate_limits: {
      five_hour: { utilization: 0, resets_at: null },
    } });
    const result = await collectClaudeAllowance({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: method }, 'account');
    expect(method).toHaveBeenCalledWith({ skipBehaviors: true });
    expect(result.windows[0].remainingPercent).toBe(100);
  });

  it('bounds waiting and safely handles missing, rejecting, and stalled SDK capabilities', async () => {
    expect((await collectClaudeAllowance({}, 'account')).available).toBe(false);
    expect((await collectClaudeAllowance({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => Promise.reject(new Error('denied')) }, 'account')).available).toBe(false);
    jest.useFakeTimers();
    try {
      const result = collectClaudeAllowance({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => new Promise(() => undefined) }, 'account', 100);
      await jest.advanceTimersByTimeAsync(100);
      expect((await result).available).toBe(false);
    } finally { jest.useRealTimers(); }
  });
});
