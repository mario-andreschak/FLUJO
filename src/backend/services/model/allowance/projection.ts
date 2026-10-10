import type { Model } from '@/shared/types/model/model';
import type { AllowanceSnapshot, ModelAllowance } from '@/shared/types/model/allowance';
import { currentAllowanceWindows, ALLOWANCE_MAX_AGE_MS } from '@/shared/types/model/allowance';
import { resolveModelAdapter } from '@/shared/types/model/provider';

export function projectModelAllowance(model: Model, accountGroup: string | undefined,
  snapshot: AllowanceSnapshot | undefined, now = Date.now()): ModelAllowance {
  const adapter = resolveModelAdapter(model.provider, model.adapter);
  const provider = adapter === 'claude-cli' ? 'claude' : adapter === 'codex-cli' ? 'codex' : model.provider ?? 'unknown';
  const supported = !model.fallbackPolicy && (provider === 'claude' || (provider === 'codex' && !model.ApiKey));
  const base: ModelAllowance = {
    modelId: model.id, modelName: model.displayName || model.name, provider,
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
  base.status = available ? 'available' : !base.windows.length ? 'unavailable' : expired ? 'stale' : 'unknown';
  base.reason = available ? undefined : !base.windows.length ? 'unsupported' : expired ? 'expired' : 'collection-failed';
  return base;
}
