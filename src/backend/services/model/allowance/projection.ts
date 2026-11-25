import type { Model } from '@/shared/types/model/model';
import type { AllowanceSnapshot, ModelAllowance, AllowanceFailureReason } from '@/shared/types/model/allowance';
import { currentAllowanceWindows, ALLOWANCE_MAX_AGE_MS } from '@/shared/types/model/allowance';
import { resolveModelAdapter } from '@/shared/types/model/provider';

/** Subscription CLIs signed in with the user's own account rather than an API key. */
export function allowancePlanProvider(model: Model): 'claude' | 'codex' | 'antigravity' | undefined {
  if (model.fallbackPolicy) return undefined;
  const adapter = resolveModelAdapter(model.provider, model.adapter);
  if (adapter === 'claude-cli') return 'claude';
  if (adapter === 'codex-cli' && !model.ApiKey) return 'codex';
  if (adapter === 'antigravity-cli' && !model.ApiKey) return 'antigravity';
  return undefined;
}

export function projectModelAllowance(model: Model, accountGroup: string | undefined,
  snapshot: AllowanceSnapshot | undefined, now = Date.now()): ModelAllowance {
  const adapter = resolveModelAdapter(model.provider, model.adapter);
  const plan = allowancePlanProvider(model);
  const provider = plan ?? (adapter === 'claude-cli' ? 'claude' : adapter === 'codex-cli' ? 'codex' : model.provider ?? 'unknown');
  // Antigravity uses a Google account plan, but has no usage reading FLUJO can use.
  const supported = plan === 'claude' || plan === 'codex';
  let localInference = false;
  if (model.provider === 'ollama') {
    try { localInference = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(model.baseUrl || 'http://localhost:11434').hostname.toLowerCase()); }
    catch { /* An unrecognized endpoint must not imply local inference. */ }
  }
  const base: ModelAllowance = {
    modelId: model.id, modelName: model.displayName || model.name, provider,
    billing: plan ? 'subscription' : localInference ? 'local' : 'api',
    ...(model.fallbackPolicy ? { policyModelIds: [...model.fallbackPolicy.modelIds] } : {}),
    accountGroup, status: supported ? 'unknown' : 'unavailable',
    observedAt: snapshot?.observedAt ?? null, source: snapshot?.source ?? null,
    windows: [], reason: supported ? 'not-observed' : 'unsupported',
  };
  if (!supported || !snapshot) return base;
  base.windows = currentAllowanceWindows(snapshot, now).filter(window => {
    if (!window.modelFamily) return true;
    const family = window.modelFamily.toLowerCase();
    const namedFamily = ['sonnet', 'opus', 'haiku'].find(name => family.includes(name));
    return model.name.toLowerCase().includes(namedFamily ?? family);
  });
  const available = base.windows.some(window => window.remainingPercent !== null);
  const observed = Date.parse(snapshot.observedAt);
  const expired = !Number.isFinite(observed) || observed > now || now - observed >= ALLOWANCE_MAX_AGE_MS
    || base.windows.some(window => window.resetAt !== null && Date.parse(window.resetAt) <= now);
  // A reading with no window for this model (say, only an Opus limit) says
  // nothing about this model yet; it does not make the account unreadable.
  base.status = available ? 'available' : !base.windows.length ? 'unknown' : expired ? 'stale' : 'unknown';
  base.reason = available ? undefined : !base.windows.length ? 'not-observed' : expired ? 'expired' : 'collection-failed';
  return base;
}

/**
 * Lays the account's last failed check over its projected row. A reading that
 * is still current stays on screen. A refused usage page is no failure while
 * another current reading exists: it is a known limit of that login.
 */
export function applyAllowanceFailure(row: ModelAllowance,
  failure: { reason: AllowanceFailureReason; retryAt?: string } | undefined): ModelAllowance {
  if (!failure) return row;
  row.retryAt = failure.retryAt;
  if (row.status === 'unknown' || row.status === 'stale') {
    row.refreshFailed = true;
    row.reason = failure.reason;
  } else if (failure.reason !== 'usage-permission') row.refreshFailed = true;
  return row;
}
