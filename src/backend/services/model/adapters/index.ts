import { Model } from '@/shared/types/model';
import { CompletionAdapter } from './types';
import { OpenAiAdapter } from './openaiAdapter';
import { OpenAiResponsesAdapter } from './openaiResponsesAdapter';
import { AnthropicAdapter } from './anthropicAdapter';
import { GeminiAdapter } from './geminiAdapter';
import { ClaudeSubscriptionAdapter } from './claudeSubscriptionAdapter';
import { CodexAdapter } from './codexAdapter';
import { OpenRouterMediaAdapter } from './openrouterMediaAdapter';
import { resolveOpenRouterMediaRoute } from './openrouterMediaRouting';

export * from './types';
export { OpenAiAdapter } from './openaiAdapter';
export { OpenAiResponsesAdapter } from './openaiResponsesAdapter';
export { AnthropicAdapter } from './anthropicAdapter';
export { GeminiAdapter } from './geminiAdapter';
export { ClaudeSubscriptionAdapter } from './claudeSubscriptionAdapter';
export { CodexAdapter } from './codexAdapter';
export { OpenRouterMediaAdapter } from './openrouterMediaAdapter';
export {
  resolveOpenRouterMediaRoute,
  normalizeOutputModalities,
} from './openrouterMediaRouting';
export type {
  OpenRouterMediaKind,
  OpenRouterMediaRoute,
} from './openrouterMediaRouting';

/**
 * Pick the completion adapter for a model based on its `adapter` field.
 * Models saved before the field existed (undefined) fall through to the
 * OpenAI-compatible path, preserving their original behaviour.
 */
export function getCompletionAdapter(model: Model): CompletionAdapter {
  if (resolveOpenRouterMediaRoute(model).useMediaRoute) {
    return new OpenRouterMediaAdapter();
  }
  switch (model.adapter) {
    case 'openai-responses':
      return new OpenAiResponsesAdapter();
    case 'anthropic':
      return new AnthropicAdapter();
    case 'gemini':
      return new GeminiAdapter();
    case 'claude-cli':
      return new ClaudeSubscriptionAdapter();
    case 'codex-cli':
      return new CodexAdapter();
    case 'openai':
    default:
      return new OpenAiAdapter();
  }
}

/** Adapter identifier + endpoint description, used by the model-card diagnostics UI. */
export interface ResolvedAdapterInfo {
  adapterId: 'openrouter-media' | NonNullable<Model['adapter']>;
  endpoint: string;
  reason: string;
}

/**
 * Describe which adapter/endpoint `getCompletionAdapter` will select for this
 * model, without instantiating it. Derived from the exact same branches as
 * `getCompletionAdapter` so the two can never disagree.
 */
export function describeCompletionAdapter(model: Model): ResolvedAdapterInfo {
  const mediaRoute = resolveOpenRouterMediaRoute(model);
  if (mediaRoute.useMediaRoute) {
    return {
      adapterId: 'openrouter-media',
      endpoint: mediaRoute.kind === 'videos' ? '/videos' : '/images',
      reason: mediaRoute.reason,
    };
  }
  switch (model.adapter) {
    case 'openai-responses':
      return { adapterId: 'openai-responses', endpoint: '/responses', reason: mediaRoute.reason };
    case 'anthropic':
      return { adapterId: 'anthropic', endpoint: 'native SDK', reason: mediaRoute.reason };
    case 'gemini':
      return { adapterId: 'gemini', endpoint: 'native SDK', reason: mediaRoute.reason };
    case 'claude-cli':
      return { adapterId: 'claude-cli', endpoint: 'local CLI', reason: mediaRoute.reason };
    case 'codex-cli':
      return { adapterId: 'codex-cli', endpoint: 'local CLI', reason: mediaRoute.reason };
    case 'openai':
    default:
      return { adapterId: 'openai', endpoint: '/chat/completions', reason: mediaRoute.reason };
  }
}
