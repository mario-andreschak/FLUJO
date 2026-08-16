import type { MappedOpenAiUsage } from './openaiUsage';

/** Usage emitted by `@openai/codex-sdk` on `turn.completed`. */
export interface CodexUsageLike {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
}

/** Normalize Codex SDK usage to the same contract as Chat Completions. */
export function mapCodexUsage(usage: CodexUsageLike | undefined): MappedOpenAiUsage {
  const promptTokens = usage?.input_tokens ?? 0;
  const completionTokens = usage?.output_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    ...(usage?.cached_input_tokens != null
      ? { cacheReadTokens: usage.cached_input_tokens }
      : {}),
    ...(usage?.cache_write_input_tokens != null
      ? { cacheWriteTokens: usage.cache_write_input_tokens }
      : {}),
  };
}
