/** Provider-neutral token usage after adapter normalization. */
export interface NormalizedTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Subset of promptTokens served from a prompt cache. */
  cacheReadTokens?: number;
  /** Subset of promptTokens written to a prompt cache. */
  cacheWriteTokens?: number;
}

/**
 * Values used by FLUJO's user-facing token meter.
 *
 * Provider totals remain available as `processedTotalTokens`, but the headline
 * deliberately excludes cache reads so a warmed, repeatedly-sent conversation
 * does not look like fresh work. Cache writes remain fresh input: OpenAI and
 * Anthropic both charge/process them as writes rather than discounted reads.
 */
export function summarizeTokenMeter(usage: NormalizedTokenUsage) {
  const cacheReadTokens = Math.max(0, usage.cacheReadTokens ?? 0);
  const cacheWriteTokens = Math.max(0, usage.cacheWriteTokens ?? 0);
  const freshPromptTokens = Math.max(0, usage.promptTokens - cacheReadTokens);
  return {
    freshPromptTokens,
    completionTokens: Math.max(0, usage.completionTokens),
    meterTotalTokens: Math.max(0, usage.totalTokens - cacheReadTokens),
    processedTotalTokens: Math.max(0, usage.totalTokens),
    cacheReadTokens,
    cacheWriteTokens,
  };
}
