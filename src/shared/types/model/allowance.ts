/** Account allowance is independent of token consumption and context capacity. */
export type AllowanceProvider = 'claude' | 'codex';
export interface AllowanceWindow {
  id: string;
  label: string;
  remainingPercent: number | null;
  resetAt: string | null;
  /** Provider model family, when this window applies only to that family. */
  modelFamily?: string;
}
export interface AllowanceSnapshot {
  provider: AllowanceProvider;
  source: 'claude-sdk-usage' | 'codex-app-server';
  observedAt: string;
  windows: AllowanceWindow[];
}
export interface ModelAllowance {
  modelId: string;
  modelName?: string;
  policyModelIds?: string[];
  provider: string;
  /** Ephemeral opaque group: models with this value share an account allowance. */
  accountGroup?: string;
  status: 'available' | 'unknown' | 'unavailable' | 'stale';
  observedAt: string | null;
  source: AllowanceSnapshot['source'] | null;
  windows: AllowanceWindow[];
  reason?: 'not-observed' | 'unsupported' | 'expired' | 'collection-failed';
}
export interface WorkspaceAllowance {
  models: ModelAllowance[];
  observedAt: string;
  entities?: { flows: Record<string, string[]>; personas: Record<string, string[]> };
}

export const ALLOWANCE_MAX_AGE_MS = 5 * 60 * 1000;

/** Expired observations never imply that a reset has restored 100% allowance. */
export function currentAllowanceWindows(snapshot: AllowanceSnapshot, now = Date.now()): AllowanceWindow[] {
  const observedAt = Date.parse(snapshot.observedAt);
  const stale = !Number.isFinite(observedAt) || observedAt > now || now - observedAt >= ALLOWANCE_MAX_AGE_MS;
  return snapshot.windows.map(window => {
    const reset = window.resetAt === null ? null : Date.parse(window.resetAt);
    const percent = window.remainingPercent;
    const valid = typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= 100;
    return { ...window, remainingPercent: !stale && valid && (reset === null || (Number.isFinite(reset) && reset > now)) ? percent : null };
  });
}

export function modelAllowancePercent(allowance: ModelAllowance): number | null {
  if (allowance.status !== 'available') return null;
  const known = allowance.windows.map(window => window.remainingPercent).filter((value): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100);
  return known.length ? Math.min(...known) : null;
}
