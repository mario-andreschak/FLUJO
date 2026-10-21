import type OpenAI from 'openai';
import type { GenerateContentResponse, Interactions } from '@google/genai';
import { contextUsageFromCompletion } from './contextUsage';

/** Interactions counts thinking separately from visible output; cached input is a subset. */
export function mapInteractionUsage(usage?: Interactions.Usage): OpenAI.Completions.CompletionUsage | undefined {
  if (!usage) return undefined;
  const prompt = usage.total_input_tokens ?? 0;
  const reasoning = usage.total_thought_tokens ?? 0;
  const output = (usage.total_output_tokens ?? 0) + reasoning;
  return {
    prompt_tokens: prompt, completion_tokens: output, total_tokens: usage.total_tokens ?? prompt + output,
    ...(usage.total_cached_tokens !== undefined ? { prompt_tokens_details: { cached_tokens: usage.total_cached_tokens } } : {}),
    ...(usage.total_thought_tokens !== undefined ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}),
  };
}

export function interactionContextUsage(usage?: Interactions.Usage, contextWindow?: number) {
  return contextUsageFromCompletion(mapInteractionUsage(usage), contextWindow, true);
}

/** Gemini's cached input is included in promptTokenCount; thoughts are separate from candidates. */
export function mapGeminiUsage(usage: GenerateContentResponse['usageMetadata']): OpenAI.Completions.CompletionUsage | undefined {
  if (!usage) return undefined;
  const prompt = usage.promptTokenCount ?? 0;
  const reasoning = usage.thoughtsTokenCount ?? 0;
  const output = (usage.candidatesTokenCount ?? 0) + reasoning;
  return {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: usage.totalTokenCount ?? prompt + output,
    ...(usage.cachedContentTokenCount != null
      ? { prompt_tokens_details: { cached_tokens: usage.cachedContentTokenCount } } : {}),
    ...(usage.thoughtsTokenCount != null
      ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}),
  };
}

/** SDK continuation hops accumulate billing; the input window uses the initial prompt. */
export function geminiContextUsage(usage: GenerateContentResponse['usageMetadata'], contextWindow?: number) {
  const snapshot = mapGeminiUsage(usage);
  if (snapshot && usage?.initialPromptTokenCount !== undefined) {
    snapshot.prompt_tokens = usage.initialPromptTokenCount;
  }
  return contextUsageFromCompletion(snapshot, contextWindow, true);
}
