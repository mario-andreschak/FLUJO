import type OpenAI from 'openai';
import type { GenerateContentResponse } from '@google/genai';
import { contextUsageFromCompletion } from './contextUsage';

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
