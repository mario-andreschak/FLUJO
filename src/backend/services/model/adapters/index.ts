import { Model } from '@/shared/types/model';
import { CompletionAdapter } from './types';
import { OpenAiAdapter } from './openaiAdapter';
import { OpenAiResponsesAdapter } from './openaiResponsesAdapter';
import { AnthropicAdapter } from './anthropicAdapter';
import { GeminiAdapter } from './geminiAdapter';
import { ClaudeSubscriptionAdapter } from './claudeSubscriptionAdapter';

export * from './types';
export { OpenAiAdapter } from './openaiAdapter';
export { OpenAiResponsesAdapter } from './openaiResponsesAdapter';
export { AnthropicAdapter } from './anthropicAdapter';
export { GeminiAdapter } from './geminiAdapter';
export { ClaudeSubscriptionAdapter } from './claudeSubscriptionAdapter';

/**
 * Pick the completion adapter for a model based on its `adapter` field.
 * Models saved before the field existed (undefined) fall through to the
 * OpenAI-compatible path, preserving their original behaviour.
 */
export function getCompletionAdapter(model: Model): CompletionAdapter {
  switch (model.adapter) {
    case 'openai-responses':
      return new OpenAiResponsesAdapter();
    case 'anthropic':
      return new AnthropicAdapter();
    case 'gemini':
      return new GeminiAdapter();
    case 'claude-cli':
      return new ClaudeSubscriptionAdapter();
    case 'openai':
    default:
      return new OpenAiAdapter();
  }
}
