import type { MappedOpenAiUsage } from './openaiUsage';

/** Usage emitted by `@openai/codex-sdk` on `turn.completed`. */
export interface CodexUsageLike {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

/** Native rollout totals are cumulative across resumed turns. Count only this invocation. */
export function subtractCodexUsage(total: CodexUsageLike, baseline: CodexUsageLike): CodexUsageLike {
  return Object.fromEntries(
    (['input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'reasoning_output_tokens'] as const)
      .filter(field => total[field] != null)
      .map(field => [field, Math.max(0, total[field]! - (baseline[field] ?? 0))]),
  );
}

/** A resumed cumulative counter is not an invocation count without a known baseline. */
export function subtractKnownCodexUsage(total: CodexUsageLike | undefined, baseline: CodexUsageLike | undefined): CodexUsageLike | undefined {
  if (!total || !baseline) return undefined;
  for (const usage of [total, baseline]) {
    for (const field of ['input_tokens', 'output_tokens'] as const) {
      if (!Number.isSafeInteger(usage[field]) || usage[field]! < 0) return undefined;
    }
    if (!Number.isSafeInteger(usage.input_tokens! + usage.output_tokens!)) return undefined;
    for (const [field, parent] of [['cached_input_tokens', 'input_tokens'], ['cache_write_input_tokens', 'input_tokens'],
      ['reasoning_output_tokens', 'output_tokens']] as const) {
      if (usage[field] != null && (!Number.isSafeInteger(usage[field]) || usage[field]! < 0 || usage[field]! > usage[parent]!)) return undefined;
    }
  }
  for (const field of ['input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'reasoning_output_tokens'] as const) {
    if (baseline[field] != null && (total[field] == null || total[field]! < baseline[field]!)) return undefined;
    if (total[field] != null && baseline[field] == null) return undefined;
  }
  const increment = subtractCodexUsage(total, baseline);
  if (!Number.isSafeInteger(increment.input_tokens! + increment.output_tokens!)) return undefined;
  for (const [field, parent] of [['cached_input_tokens', 'input_tokens'], ['cache_write_input_tokens', 'input_tokens'],
    ['reasoning_output_tokens', 'output_tokens']] as const) {
    if (increment[field] != null && increment[field]! > increment[parent]!) return undefined;
  }
  return increment;
}

/** Normalize Codex SDK usage to the same contract as Chat Completions. */
export function mapCodexUsage(usage: CodexUsageLike | undefined): MappedOpenAiUsage {
  const promptTokens = usage?.input_tokens ?? 0;
  const completionTokens = usage?.output_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    ...(usage?.reasoning_output_tokens != null ? { reasoningTokens: usage.reasoning_output_tokens } : {}),
    ...(usage?.cached_input_tokens != null
      ? { cacheReadTokens: usage.cached_input_tokens }
      : {}),
    ...(usage?.cache_write_input_tokens != null
      ? { cacheWriteTokens: usage.cache_write_input_tokens }
      : {}),
  };
}
