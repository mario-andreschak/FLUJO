import type { AllowanceSnapshot, AllowanceWindow, AllowanceFailureReason } from '@/shared/types/model/allowance';

export class ClaudeAllowanceError extends Error {
  constructor(readonly reason: AllowanceFailureReason, cause?: unknown, readonly retryAt?: string) {
    super('CLAUDE_ALLOWANCE_UNAVAILABLE', { cause });
  }
}

/** Only reads an already running SDK query; never starts a model or reads credentials. */
export interface ClaudeAllowanceWindow {
  key: string;
  label: string;
  remainingPercent: number | null;
  resetAt: string | null;
  model: string | null;
}

export interface ClaudeAllowanceObservation {
  source: 'claude-sdk-usage';
  observedAt: string;
  accountKey: string;
  windows: ClaudeAllowanceWindow[];
  available: boolean;
}

export function claudeAllowanceSnapshot(observation: ClaudeAllowanceObservation): AllowanceSnapshot {
  return {
    provider: 'claude', source: observation.source, observedAt: observation.observedAt,
    windows: observation.windows.map(({ key, label, remainingPercent, resetAt, model }) => ({
      id: key, label, remainingPercent, resetAt, ...(model ? { modelFamily: model } : {}),
    })),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Claude's plan windows. The same ids name a window in usage reads and in
 * rate-limit events, so a newer event replaces the matching usage window. */
const CLAUDE_WINDOWS: Record<string, readonly [label: string, model: string | null]> = {
  five_hour: ['Five hours', null], seven_day: ['Weekly', null],
  seven_day_oauth_apps: ['Weekly OAuth apps', null],
  seven_day_opus: ['Weekly Opus', 'opus'], seven_day_sonnet: ['Weekly Sonnet', 'sonnet'],
  seven_day_overage_included: ['Weekly Fable', 'fable'],
};

/** Usage at or above 100% leaves nothing, never an unknown balance. */
function remainingFromUsed(used: unknown): number | null {
  return typeof used === 'number' && Number.isFinite(used) && used >= 0 ? Math.max(0, 100 - used) : null;
}

function isoTime(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function window(key: string, label: string, value: unknown, model: string | null, usedField = 'utilization'): ClaudeAllowanceWindow {
  const row = record(value);
  return { key, label, model, remainingPercent: remainingFromUsed(row?.[usedField]), resetAt: isoTime(row?.resets_at) };
}

function displayName(value: unknown): string | null {
  const name = record(value)?.display_name;
  return typeof name === 'string' && name.trim() ? name.trim().slice(0, 128) : null;
}

/** The usage endpoint's newer `limits[]` rows: classified by `kind`, never by label. */
function serverLimitWindows(rows: unknown[]): ClaudeAllowanceWindow[] {
  const windows: ClaudeAllowanceWindow[] = [];
  for (const [index, value] of rows.slice(0, 64).entries()) {
    const row = record(value);
    const kind = typeof row?.kind === 'string' ? row.kind.slice(0, 64) : '';
    if (!row || !kind) continue;
    const scope = record(row.scope);
    const model = displayName(scope?.model);
    const surface = displayName(scope?.surface);
    if (kind === 'session') windows.push(window('five_hour', 'Five hours', row, null, 'percent'));
    else if (kind === 'weekly_all') windows.push(window('seven_day', 'Weekly', row, null, 'percent'));
    else {
      const weekly = row.group === 'weekly' || kind.startsWith('weekly');
      const name = model ?? surface ?? kind;
      windows.push(window(`limit:${index}`, weekly ? `Weekly ${name}` : name, row, model, 'percent'));
    }
  }
  return windows;
}

export function normalizeClaudeAllowance(value: unknown, accountKey: string, observedAt = new Date().toISOString()): ClaudeAllowanceObservation {
  const data = record(value);
  const limits = record(data?.rate_limits);
  const windows: ClaudeAllowanceWindow[] = [];
  if (data?.rate_limits_available === true && limits) {
    for (const [key, [label, model]] of Object.entries(CLAUDE_WINDOWS)) {
      if (record(limits[key])) windows.push(window(key, label, limits[key], model));
    }
    if (Array.isArray(limits.model_scoped)) {
      for (const [index, value] of limits.model_scoped.slice(0, 64).entries()) {
        const name = displayName(value);
        if (name) windows.push(window(`model:${index}`, name, value, name));
      }
    }
    // Older fields stay authoritative while the endpoint still sends them.
    if (!windows.length && Array.isArray(limits.limits)) windows.push(...serverLimitWindows(limits.limits));
  }
  return { source: 'claude-sdk-usage', observedAt, accountKey, windows, available: windows.length > 0 };
}

/** Body of `GET /api/oauth/usage`; null when it names no plan window. */
export function claudeOAuthUsageSnapshot(body: unknown, accountKey: string, observedAt = new Date().toISOString()): AllowanceSnapshot | null {
  const observation = normalizeClaudeAllowance({ rate_limits_available: true, rate_limits: body }, accountKey, observedAt);
  return observation.available ? { ...claudeAllowanceSnapshot(observation), source: 'claude-oauth-usage' } : null;
}

/**
 * What one answer from the usage page means. Throttling keeps the provider's
 * Retry-After (seconds or an HTTP date, within a day). 401 usually means an
 * access token that is being refreshed: an ordinary, retryable failure. Only
 * 403 says this credential cannot read usage. Nothing here invents a balance.
 */
export function claudeOAuthUsageResult(response: { status: number; retryAfter: string | null; body: string },
  accountKey: string, now = Date.now()): AllowanceSnapshot {
  if (response.status === 429) {
    const header = response.retryAfter;
    const seconds = header && /^\d+$/.test(header) ? Number(header) : NaN;
    const date = header && /^[A-Za-z]{3}, /.test(header) ? Date.parse(header) : NaN;
    const deadline = Number.isFinite(seconds) ? now + seconds * 1000 : Number.isFinite(date) ? date : now + 60_000;
    throw new ClaudeAllowanceError('rate-limited', undefined, new Date(Math.min(Math.max(deadline, now + 1000), now + 24 * 60 * 60 * 1000)).toISOString());
  }
  if (response.status < 200 || response.status > 299) {
    throw new ClaudeAllowanceError(response.status === 403 ? 'usage-permission' : 'collection-failed');
  }
  let value: unknown;
  try { value = JSON.parse(response.body); }
  catch (cause) { throw new ClaudeAllowanceError('collection-failed', cause); }
  const snapshot = claudeOAuthUsageSnapshot(value, accountKey, new Date(now).toISOString());
  if (!snapshot) throw new ClaudeAllowanceError('collection-failed');
  return snapshot;
}

/**
 * The SDK's `rate_limit_event` repeats Claude's rate-limit response headers.
 * They come with model turns, so they also reach a setup-token that may not
 * read the usage page. Claude only sends a number near a limit: `allowed`
 * carries none and ends earlier warnings, `allowed_warning` carries
 * `utilization` as a 0-1 fraction, and `rejected` means the window is used up.
 */
export function claudeRateLimitSignal(info: unknown, observedAt = new Date().toISOString()): AllowanceSnapshot | 'clear' | undefined {
  const data = record(info);
  if (data?.status === 'allowed') return 'clear';
  const type = typeof data?.rateLimitType === 'string' ? data.rateLimitType : '';
  const known = Object.hasOwn(CLAUDE_WINDOWS, type) ? CLAUDE_WINDOWS[type] : undefined;
  if (!data || !known) return undefined;
  const utilization = data.utilization;
  const used = data.status === 'rejected' ? 100
    : data.status === 'allowed_warning' && typeof utilization === 'number' && Number.isFinite(utilization) && utilization >= 0
      ? Math.round(utilization * 1000) / 10 : null;
  if (used === null) return undefined;
  const resets = data.resetsAt;
  const resetAt = typeof resets === 'number' && Number.isSafeInteger(resets) && resets > 0 && resets * 1000 <= 8.64e15
    ? new Date(resets * 1000).toISOString() : null;
  const [label, model] = known;
  const signal: AllowanceWindow = { id: type, label, remainingPercent: remainingFromUsed(used), resetAt, ...(model ? { modelFamily: model } : {}) };
  return { provider: 'claude', source: 'claude-rate-limit-event', observedAt, windows: [signal] };
}

/** Experimental capability is optional; timeout/failure cannot delay or fail execution. */
export async function collectClaudeAllowance(query: unknown, accountKey: string, timeoutMs = 500): Promise<ClaudeAllowanceObservation> {
  const unavailable = () => normalizeClaudeAllowance(null, accountKey);
  const method = (query as { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: unknown } | null)
    ?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
  if (typeof method !== 'function') return unavailable();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => method.call(query, { skipBehaviors: true }))
        .then(value => normalizeClaudeAllowance(value, accountKey), unavailable),
      new Promise<ClaudeAllowanceObservation>(resolve => {
        timer = setTimeout(() => resolve(unavailable()), Math.max(1, Math.min(timeoutMs, 2000)));
      }),
    ]);
  } catch {
    return unavailable();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
