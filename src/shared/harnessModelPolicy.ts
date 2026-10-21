import type { Model } from '@/shared/types/model';
import { resolveModelAdapter } from '@/shared/types/model/provider';

/** Experiment policy is deliberately narrower than FLUJO's general model catalogue. */
export function harnessModelRoute(model: Model): 'codex-subscription' | 'openrouter' | null {
  if (model.fallbackPolicy || model.ownerCredentialBinding
    || model.outputModalities?.some(value => value !== 'text')) return null;
  const name = model.name;
  if (/(?:astra|sonnet|opus|argon)/i.test(name)) return null;
  const adapter = resolveModelAdapter(model.provider, model.adapter);
  if (model.provider === 'codex' && adapter === 'codex-cli' && !model.ApiKey?.trim() && !model.baseUrl?.trim()
    && /^gpt-\d+(?:\.\d+)?-(?:luna|terra|sol)(?:-\d{4}-\d{2}-\d{2})?$/.test(name)) return 'codex-subscription';
  if (model.provider !== 'openrouter' || !['openai', 'openai-responses'].includes(adapter)) return null;
  if (model.baseUrl && model.baseUrl.replace(/\/+$/, '') !== 'https://openrouter.ai/api/v1') return null;
  // Opaque routers cannot guarantee a fixed approved base model for attribution.
  if (name.startsWith('openrouter/') || /(?:sol|terra)/i.test(name)) return null;
  if (/^[a-z0-9.-]+\/[a-z0-9.-]+:free$/.test(name)
    || /^deepseek\/deepseek-[a-z0-9.-]+$/.test(name)
    || /^openai\/gpt-\d+(?:\.\d+)?-luna(?:-\d{4}-\d{2}-\d{2})?$/.test(name)
    || /^anthropic\/claude-haiku-[a-z0-9.-]+$/.test(name)) return 'openrouter';
  return null;
}
