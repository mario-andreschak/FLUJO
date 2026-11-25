/**
 * Every Claude allowance answer FLUJO knows about, and what the account bar
 * must show for a Sonnet model afterwards. Shapes follow the official Agent
 * SDK type definitions (@anthropic-ai/claude-agent-sdk 0.3.312: the usage
 * control response, its `limits[]` rows and `rate_limit_event`), the usage
 * page the official CLI reads, and the refusals recorded on issue #756.
 * No real account data: every number here is made up.
 */
import { ClaudeAllowanceError, claudeAllowanceSnapshot, claudeOAuthUsageResult, claudeRateLimitSignal, normalizeClaudeAllowance } from '@/backend/services/model/allowance/claude';
import { recordAllowanceFailure, recordAllowanceSignal, recordAllowanceSnapshot } from '@/backend/services/model/allowance/store';

export type ClaudeAllowanceStep =
  /** `GET https://api.anthropic.com/api/oauth/usage`; a string body is sent as is. */
  | { kind: 'usage-page'; status: number; retryAfter?: string; body: unknown; ageMs?: number }
  /** The SDK's `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` answer. */
  | { kind: 'sdk-usage'; body: unknown; ageMs?: number }
  /** The SDK's `rate_limit_event.rate_limit_info`, taken from rate-limit response headers. */
  | { kind: 'rate-limit-event'; info: unknown; ageMs?: number };

export interface ClaudeAllowanceFixture {
  name: string;
  steps: ClaudeAllowanceStep[];
  /** The account bar for a Sonnet model: its text, and its colour and value when it has a bar. */
  shows: { text: string; bar?: { percent: number; colour: 'success' | 'warning' | 'error' }; detail?: string };
}

export const FIXTURE_SONNET = { id: 'fixture-sonnet', name: 'claude-sonnet-4-6', provider: 'claude-subscription', adapter: 'claude-cli', ApiKey: 'fixture' } as const;

const window = (utilization: number | null, resetsAt: string | null = null) => ({ utilization, resets_at: resetsAt });
const refused = { kind: 'usage-page', status: 403, body: { type: 'error', error: { type: 'permission_error', message: 'OAuth authentication is currently not allowed for this organization.' } } } as const;

export function claudeAllowanceFixtures(now: number): ClaudeAllowanceFixture[] {
  const inHours = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
  const epoch = (hours: number) => Math.floor((now + hours * 3_600_000) / 1000);
  const plenty = {
    five_hour: window(12, inHours(2)), seven_day: window(35, inHours(72)), seven_day_oauth_apps: null,
    seven_day_opus: window(50, inHours(72)), seven_day_sonnet: window(20, inHours(72)),
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
  };
  return [
    { name: 'usage page: plenty left', steps: [{ kind: 'usage-page', status: 200, body: plenty }],
      shows: { text: '65% left', bar: { percent: 65, colour: 'success' } } },
    { name: 'usage page: a quarter or less left', steps: [{ kind: 'usage-page', status: 200, body: { five_hour: window(80, inHours(1)), seven_day: window(41, inHours(48)) } }],
      shows: { text: '20% left', bar: { percent: 20, colour: 'warning' } } },
    { name: 'usage page: almost used up', steps: [{ kind: 'usage-page', status: 200, body: { five_hour: window(5, inHours(4)), seven_day: window(93, inHours(30)) } }],
      shows: { text: '7% left', bar: { percent: 7, colour: 'error' } } },
    { name: 'usage page: over the limit', steps: [{ kind: 'usage-page', status: 200, body: { five_hour: window(104.5, inHours(1)), seven_day: window(60, inHours(30)) } }],
      shows: { text: '0% left', bar: { percent: 0, colour: 'error' } } },
    { name: 'usage page: nothing used yet', steps: [{ kind: 'usage-page', status: 200, body: { five_hour: window(0), seven_day: window(0) } }],
      shows: { text: '100% left', bar: { percent: 100, colour: 'success' } } },
    { name: 'usage page: only the newer limits rows', steps: [{ kind: 'usage-page', status: 200, body: { limits: [
      { kind: 'session', group: 'session', percent: 40, resets_at: inHours(3), severity: 'normal', is_active: false },
      { kind: 'weekly_all', group: 'weekly', percent: 78, resets_at: inHours(60), severity: 'warning', is_active: true },
      { kind: 'weekly_scoped', group: 'weekly', percent: 10, resets_at: inHours(60), scope: { model: { display_name: 'Fable' } }, severity: 'normal', is_active: false },
    ] } }], shows: { text: '22% left', bar: { percent: 22, colour: 'warning' } } },
    { name: 'usage page: one window without a number', steps: [{ kind: 'usage-page', status: 200, body: { five_hour: window(null), seven_day: window(30, inHours(30)) } }],
      shows: { text: 'Partial reading' } },
    { name: 'usage page: no plan windows', steps: [{ kind: 'usage-page', status: 200, body: { five_hour: null, seven_day: null, seven_day_opus: null, seven_day_sonnet: null, extra_usage: null } }],
      shows: { text: 'Check failed' } },
    { name: 'usage page: not JSON', steps: [{ kind: 'usage-page', status: 200, body: '<html>maintenance</html>' }],
      shows: { text: 'Check failed' } },
    { name: 'usage page: refuses a setup-token (403)', steps: [refused],
      shows: { text: 'Usage not exposed', detail: 'Your Claude setup-token can run models' } },
    { name: 'usage page: login being refreshed (401)', steps: [{ kind: 'usage-page', status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'OAuth token has expired.' } } }],
      shows: { text: 'Check failed' } },
    { name: 'usage page: provider error (500)', steps: [{ kind: 'usage-page', status: 500, body: { type: 'error', error: { type: 'api_error', message: 'Internal server error' } } }],
      shows: { text: 'Check failed' } },
    { name: 'usage page: throttled for 120 seconds (429)', steps: [{ kind: 'usage-page', status: 429, retryAfter: '120', body: { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } } }],
      shows: { text: 'Usage check paused', detail: 'Try again in 2 minutes' } },
    { name: 'usage page: throttled until a date (429)', steps: [{ kind: 'usage-page', status: 429, retryAfter: new Date(now + 3_600_000 + 30_000).toUTCString(), body: '' }],
      shows: { text: 'Usage check paused', detail: 'Try again in 1 hour' } },
    { name: 'SDK usage: plan windows and per-model rows', steps: [{ kind: 'sdk-usage', body: {
      session: { total_cost_usd: 3.2, total_api_duration_ms: 1, total_duration_ms: 1, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
      subscription_type: 'max', rate_limits_available: true, behaviors: null,
      rate_limits: { five_hour: window(30, inHours(2)), seven_day: window(45, inHours(80)), seven_day_sonnet: window(60, inHours(80)),
        model_scoped: [{ display_name: 'Fable', utilization: 95, resets_at: inHours(80) }] },
    } }], shows: { text: '40% left', bar: { percent: 40, colour: 'success' } } },
    { name: 'SDK usage: setup-token without usage access, then the usage page refuses', steps: [
      { kind: 'sdk-usage', body: { session: {}, subscription_type: null, rate_limits_available: false, rate_limits: null, behaviors: null } }, refused,
    ], shows: { text: 'Usage not exposed' } },
    { name: 'rate-limit event: weekly warning for a setup-token', steps: [refused,
      { kind: 'rate-limit-event', info: { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.82, resetsAt: epoch(40), isUsingOverage: false } }],
    shows: { text: '18% left', bar: { percent: 18, colour: 'warning' }, detail: 'This number comes from a limit warning' } },
    { name: 'rate-limit event: five-hour limit reached', steps: [refused,
      { kind: 'rate-limit-event', info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: epoch(1), overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled' } }],
    shows: { text: '0% left', bar: { percent: 0, colour: 'error' } } },
    { name: 'rate-limit event: warning without a number', steps: [refused,
      { kind: 'rate-limit-event', info: { status: 'allowed_warning', rateLimitType: 'seven_day', surpassedThreshold: 0.75, resetsAt: epoch(40) } }],
    shows: { text: 'Usage not exposed' } },
    { name: 'rate-limit event: the limit was lifted', steps: [refused,
      { kind: 'rate-limit-event', info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: epoch(1) } },
      { kind: 'rate-limit-event', info: { status: 'allowed', isUsingOverage: false } }],
    shows: { text: 'Usage not exposed' } },
    { name: 'rate-limit event: an Opus limit says nothing about Sonnet', steps: [refused,
      { kind: 'rate-limit-event', info: { status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: epoch(50) } }],
    shows: { text: 'Usage not exposed' } },
    { name: 'rate-limit event: newer than a full usage read', steps: [{ kind: 'usage-page', status: 200, body: plenty, ageMs: 60_000 },
      { kind: 'rate-limit-event', info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: epoch(1) } }],
    shows: { text: '0% left', bar: { percent: 0, colour: 'error' } } },
    { name: 'stale: a reading older than five minutes', steps: [{ kind: 'usage-page', status: 200, body: plenty, ageMs: 6 * 60_000 }],
      shows: { text: 'Outdated', detail: 'Checked 6 minutes ago' } },
    { name: 'stale: a window reset after the reading', steps: [{ kind: 'usage-page', status: 200, ageMs: 120_000,
      body: { five_hour: window(90, new Date(now - 60_000).toISOString()), seven_day: window(30, inHours(30)) } }],
    shows: { text: 'Partial reading' } },
  ];
}

export function usagePageText(step: Extract<ClaudeAllowanceStep, { kind: 'usage-page' }>): string {
  return typeof step.body === 'string' ? step.body : JSON.stringify(step.body);
}

/** Feeds a fixture to the account store the way the refresh and the Claude adapter do. */
export function recordClaudeFixture(fixture: ClaudeAllowanceFixture, accountKey: string, now: number): void {
  for (const step of fixture.steps) {
    const at = now - (step.ageMs ?? 0);
    if (step.kind === 'usage-page') {
      try {
        recordAllowanceSnapshot(accountKey, claudeOAuthUsageResult({ status: step.status, retryAfter: step.retryAfter ?? null, body: usagePageText(step) }, accountKey, at));
      } catch (error) {
        recordAllowanceFailure(accountKey, error instanceof ClaudeAllowanceError ? error.reason : 'collection-failed', error instanceof ClaudeAllowanceError ? error.retryAt : undefined);
      }
    } else if (step.kind === 'sdk-usage') {
      recordAllowanceSnapshot(accountKey, claudeAllowanceSnapshot(normalizeClaudeAllowance(step.body, accountKey, new Date(at).toISOString())));
    } else {
      recordAllowanceSignal(accountKey, claudeRateLimitSignal(step.info, new Date(at).toISOString()), now);
    }
  }
}
