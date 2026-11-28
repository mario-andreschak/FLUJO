import { readClaudeOAuthAllowance, ClaudeAllowanceError } from '@/backend/services/model/allowance/claudeAccount';
import { claudeOAuthUsageResult, claudeRateLimitSignals, normalizeClaudeAllowance } from '@/backend/services/model/allowance/claude';
import { allowanceAccountKey } from '@/backend/services/model/allowance/store';
import { claudeAllowanceFixtures, usagePageText, type ClaudeAllowanceStep } from './fixtures/claudeAllowanceFixtures';

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); });

type Outcome = { windows: unknown[] } | { reason: string; retryAt?: string };
async function outcome(run: () => AllowanceResult): Promise<Outcome> {
  try {
    const snapshot = await run();
    return { windows: snapshot.windows };
  } catch (error) {
    if (!(error instanceof ClaudeAllowanceError)) throw error;
    return { reason: error.reason, ...(error.retryAt ? { retryAt: error.retryAt } : {}) };
  }
}
type AllowanceResult = ReturnType<typeof claudeOAuthUsageResult> | Promise<ReturnType<typeof claudeOAuthUsageResult>>;

const now = Date.now();
const usagePages = claudeAllowanceFixtures(now).flatMap(fixture => fixture.steps
  .filter((step): step is Extract<ClaudeAllowanceStep, { kind: 'usage-page' }> => step.kind === 'usage-page')
  .map(step => [fixture.name, step] as const));

test.each(usagePages)('the live reader and the recorded mapping agree: %s', async (_name, step) => {
  const credential = 'fixture-credential';
  const body = usagePageText(step);
  global.fetch = jest.fn(async () => new Response(body, { status: step.status, headers: step.retryAfter ? { 'Retry-After': step.retryAfter } : {} }));
  const key = allowanceAccountKey('claude', credential);
  jest.spyOn(Date, 'now').mockReturnValue(now);
  const live = await outcome(() => readClaudeOAuthAllowance(credential, new AbortController().signal));
  const recorded = await outcome(() => claudeOAuthUsageResult({ status: step.status, retryAfter: step.retryAfter ?? null, body }, key));
  expect(live).toEqual(recorded);
});

test('a usage page larger than 64 KiB is a failed check, not a partial balance', async () => {
  global.fetch = jest.fn(async () => new Response(JSON.stringify({ five_hour: { utilization: 1, resets_at: null }, padding: 'x'.repeat(70 * 1024) }), { status: 200 }));
  await expect(readClaudeOAuthAllowance('fixture', new AbortController().signal)).rejects.toMatchObject({ reason: 'collection-failed' });
});

describe('Claude rate-limit events', () => {
  test('utilization is a 0-1 fraction and the reset time is in epoch seconds', () => {
    const signals = claudeRateLimitSignals({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.905, resetsAt: 1_900_000_000 }, '2026-11-25T00:00:00.000Z');
    expect(signals).toEqual([{ provider: 'claude', source: 'claude-rate-limit-event', observedAt: '2026-11-25T00:00:00.000Z',
      windows: [{ id: 'seven_day', label: 'Weekly', remainingPercent: expect.closeTo(9.5, 5), resetAt: new Date(1_900_000_000_000).toISOString() }] }]);
  });

  test('a rejection is a used-up window and "allowed" clears earlier signals', () => {
    expect(claudeRateLimitSignals({ status: 'rejected', rateLimitType: 'seven_day_sonnet' })).toEqual([expect.objectContaining({
      windows: [{ id: 'seven_day_sonnet', label: 'Weekly Sonnet', remainingPercent: 0, modelFamily: 'sonnet', resetAt: null }] })]);
    expect(claudeRateLimitSignals({ status: 'allowed' })).toEqual(['clear']);
  });

  test('every window Claude Code reports is read, near a limit or not, and "allowed" replaces older signals', () => {
    const unifiedWindows = { five_hour: { utilization: 0.12, resetsAt: 1_900_000_000, status: 'allowed' },
      seven_day: { utilization: 0.31, resetsAt: 1_900_100_000, status: 'allowed' }, seven_day_overage_included: { utilization: 0.5, resetsAt: 1_900_100_000 } };
    const [clear, snapshot] = claudeRateLimitSignals({ status: 'allowed', rateLimitType: 'five_hour', unifiedWindows }, '2026-11-25T00:00:00.000Z');
    expect(clear).toBe('clear');
    expect(snapshot).toMatchObject({ source: 'claude-rate-limit-event', windows: [
      { id: 'five_hour', remainingPercent: 88, resetAt: new Date(1_900_000_000_000).toISOString() },
      { id: 'seven_day', remainingPercent: 69 }, { id: 'seven_day_overage_included', remainingPercent: 50, modelFamily: 'fable' }] });
    // A rejected window is used up even when its reported share is lower.
    expect(claudeRateLimitSignals({ status: 'rejected', rateLimitType: 'five_hour', unifiedWindows: {
      five_hour: { utilization: 0.97, resetsAt: 1_900_000_000, status: 'rejected' } } })).toEqual([expect.objectContaining({
      windows: [expect.objectContaining({ id: 'five_hour', remainingPercent: 0 })] })]);
  });

  test.each([
    ['extra-usage credits are not the plan allowance', { status: 'rejected', rateLimitType: 'overage' }],
    ['a window type FLUJO does not know', { status: 'rejected', rateLimitType: 'monthly_mystery' }],
    ['a warning without a number', { status: 'allowed_warning', rateLimitType: 'five_hour', surpassedThreshold: 0.9 }],
    ['a reported window without a number', { status: 'allowed_warning', unifiedWindows: { five_hour: { resetsAt: 1 }, monthly: { utilization: 0.4 } } }],
    ['no information at all', null],
  ])('ignores %s', (_name, info) => {
    expect(claudeRateLimitSignals(info)).toEqual([]);
  });
});

describe('Claude usage shapes', () => {
  test('usage over 100% means nothing is left, never an unknown balance', () => {
    const result = normalizeClaudeAllowance({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 112, resets_at: null } } }, 'account');
    expect(result.windows[0].remainingPercent).toBe(0);
  });

  test('the newer limits rows are read by kind when the older fields are gone', () => {
    const result = normalizeClaudeAllowance({ rate_limits_available: true, rate_limits: { limits: [
      { kind: 'session', group: 'session', percent: 10, resets_at: null, severity: 'normal', is_active: false },
      { kind: 'weekly_scoped', group: 'weekly', percent: 50, resets_at: null, scope: { model: { display_name: 'Opus' } }, severity: 'normal', is_active: false },
      { kind: 'weekly_scoped', group: 'weekly', percent: 30, resets_at: null, scope: { surface: { display_name: 'Claude Code' } }, severity: 'normal', is_active: false },
      { group: 'weekly', percent: 99 },
    ] } }, 'account');
    expect(result.windows).toEqual([
      { key: 'five_hour', label: 'Five hours', remainingPercent: 90, resetAt: null, model: null },
      { key: 'limit:1', label: 'Weekly Opus', remainingPercent: 50, resetAt: null, model: 'Opus' },
      { key: 'limit:2', label: 'Weekly Claude Code', remainingPercent: 70, resetAt: null, model: null },
    ]);
  });

  test('the older fields stay authoritative while the endpoint sends both', () => {
    const result = normalizeClaudeAllowance({ rate_limits_available: true, rate_limits: {
      five_hour: { utilization: 20, resets_at: null }, limits: [{ kind: 'session', group: 'session', percent: 90, resets_at: null }],
    } }, 'account');
    expect(result.windows.map(window => window.remainingPercent)).toEqual([80]);
  });
});
