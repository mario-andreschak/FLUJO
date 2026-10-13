import type { AllowanceSnapshot } from '@/shared/types/model/allowance';

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

function window(key: string, label: string, value: unknown, model: string | null): ClaudeAllowanceWindow {
  const row = record(value);
  const used = row?.utilization;
  const reset = row?.resets_at;
  return {
    key, label, model,
    remainingPercent: typeof used === 'number' && Number.isFinite(used) && used >= 0 && used <= 100 ? 100 - used : null,
    resetAt: typeof reset === 'string' && Number.isFinite(Date.parse(reset)) ? new Date(reset).toISOString() : null,
  };
}

export function normalizeClaudeAllowance(value: unknown, accountKey: string, observedAt = new Date().toISOString()): ClaudeAllowanceObservation {
  const data = record(value);
  const limits = record(data?.rate_limits);
  const windows: ClaudeAllowanceWindow[] = [];
  if (data?.rate_limits_available === true && limits) {
    for (const [key, label, model] of [
      ['five_hour', 'Five hours', null], ['seven_day', 'Weekly', null],
      ['seven_day_oauth_apps', 'Weekly OAuth apps', null],
      ['seven_day_opus', 'Weekly Opus', 'opus'], ['seven_day_sonnet', 'Weekly Sonnet', 'sonnet'],
    ] as const) {
      if (record(limits[key])) windows.push(window(key, label, limits[key], model));
    }
    if (Array.isArray(limits.model_scoped)) {
      for (const [index, value] of limits.model_scoped.slice(0, 64).entries()) {
        const row = record(value);
        if (typeof row?.display_name !== 'string' || !row.display_name.trim()) continue;
        const name = row.display_name.slice(0, 128);
        windows.push(window(`model:${index}`, name, row, name));
      }
    }
  }
  return { source: 'claude-sdk-usage', observedAt, accountKey, windows, available: windows.length > 0 };
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
