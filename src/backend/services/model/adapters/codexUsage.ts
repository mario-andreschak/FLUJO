import type { MappedOpenAiUsage } from './openaiUsage';

/** Usage emitted by `@openai/codex-sdk` on `turn.completed`. */
export interface CodexUsageLike {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
}

/** Native rollout totals are cumulative across resumed turns. Count only this invocation. */
export function subtractCodexUsage(total: CodexUsageLike, baseline: CodexUsageLike): CodexUsageLike {
  return Object.fromEntries(
    (['input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_input_tokens'] as const)
      .filter(field => total[field] != null)
      .map(field => [field, Math.max(0, total[field]! - (baseline[field] ?? 0))]),
  );
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
