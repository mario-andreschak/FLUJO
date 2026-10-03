import type { Model } from './model';

export type FallbackTrigger = 'rate_limit' | 'unavailable' | 'timeout';
export const DEFAULT_FALLBACK_TRIGGERS: FallbackTrigger[] = ['rate_limit', 'unavailable', 'timeout'];
export const MAX_FALLBACK_MODELS = 8;

/** Members are workspace model IDs, never credentials or nested policies. */
export interface ModelFallbackPolicy {
  modelIds: string[];
  triggers?: FallbackTrigger[];
  cooldownSeconds?: number;
}

export interface ModelRouteReceipt {
  policyId: string;
  selectedModelId?: string;
  attempts: Array<{
    modelId: string;
    outcome: 'completed' | 'failed' | 'cooldown' | 'incompatible';
    reason?: FallbackTrigger;
  }>;
}

export function validateFallbackPolicy(model: Model, models: Model[]): string | undefined {
  if (model.fallbackPolicy === undefined) return undefined;
  if (typeof model.id !== 'string' || !model.id.trim()) return 'Policy model ID is required';
  const policy = model.fallbackPolicy;
  if (!policy || typeof policy !== 'object' || !Array.isArray(policy.modelIds) ||
      policy.modelIds.length < 2 || policy.modelIds.length > MAX_FALLBACK_MODELS) {
    return `A fallback policy requires 2 to ${MAX_FALLBACK_MODELS} models`;
  }
  if (!/^policy\/[a-z0-9][a-z0-9_-]{0,63}$/.test(model.name)) {
    return 'Policy alias must be policy/ followed by 1–64 lowercase letters, numbers, underscores or hyphens';
  }
  if (models.some(item => item.id !== model.id && item.name.toLowerCase() === model.name.toLowerCase())) {
    return 'Policy alias already exists';
  }
  if (new Set(policy.modelIds).size !== policy.modelIds.length) return 'Policy models must be unique';
  for (const id of policy.modelIds) {
    if (typeof id !== 'string' || id === model.id) return 'A policy cannot reference itself';
    const member = models.find(item => item.id === id);
    if (!member) return `Policy model not found: ${id}`;
    if (member.fallbackPolicy) return 'Nested fallback policies are not supported';
  }
  if (policy.triggers !== undefined && (!Array.isArray(policy.triggers) || !policy.triggers.length ||
      policy.triggers.some(trigger => !DEFAULT_FALLBACK_TRIGGERS.includes(trigger)) ||
      new Set(policy.triggers).size !== policy.triggers.length)) return 'Select valid, unique fallback triggers';
  if (policy.cooldownSeconds !== undefined && (!Number.isInteger(policy.cooldownSeconds) ||
      policy.cooldownSeconds < 0 || policy.cooldownSeconds > 3600)) return 'Cooldown must be between 0 and 3600 seconds';
  if (model.ApiKey?.trim()) return 'Policies use their members’ credentials; leave ApiKey empty';
  return undefined;
}

/** Conservative preflight metadata; actual dispatch always uses the member record. */
export function materializeFallbackPolicy(model: Model, models: Model[]): Model {
  if (!model.fallbackPolicy) return model;
  const members = model.fallbackPolicy.modelIds.map(id => models.find(item => item.id === id)).filter(
    (item): item is Model => Boolean(item && !item.fallbackPolicy),
  );
  const primary = members[0];
  if (!primary) return model;
  const windows = members.map(item => item.contextWindow).filter((value): value is number =>
    typeof value === 'number' && value > 0);
  return {
    ...model, ApiKey: '',
    provider: primary.provider, adapter: primary.adapter,
    contextWindow: windows.length ? Math.min(...windows) : undefined,
    // Unknown metadata must not strip media from the canonical input.
    inputModalities: undefined,
    supportsTools: members.some(item => item.supportsTools !== false) ? undefined : false,
  };
}
