import type { Model } from '@/shared/types/model';
import { resolveModelAdapter, type ModelAdapter } from '@/shared/types/model/provider';
import { resolveOpenRouterMediaRoute } from './openrouterMediaRouting';

/** The concrete route chosen by getCompletionAdapter, including its overrides. */
export type CompletionAdapterRoute = ModelAdapter | 'fallback-policy' | 'openrouter-media';

export function resolveCompletionAdapterRoute(model: Model): CompletionAdapterRoute {
  if (model.fallbackPolicy) return 'fallback-policy';
  if (resolveOpenRouterMediaRoute(model).useMediaRoute) return 'openrouter-media';
  return resolveModelAdapter(model.provider, model.adapter);
}
