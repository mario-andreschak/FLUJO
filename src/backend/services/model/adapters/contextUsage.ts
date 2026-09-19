import type { ModelContextUsage } from '@/shared/types/model/contextUsage';
import type { OpenAiUsageLike } from './openaiUsage';

/** Snapshot one API request; never pass an SDK run's accumulated usage here. */
export function contextUsageFromCompletion(
  usage: OpenAiUsageLike | null | undefined,
  contextWindow?: number,
  inputOnly = false,
): ModelContextUsage | null {
  const promptTokens = usage?.prompt_tokens;
  if (typeof promptTokens !== 'number' || !Number.isFinite(promptTokens) || promptTokens < 0) return null;
  const output = usage?.completion_tokens;
  const completionTokens = typeof output === 'number' && Number.isFinite(output) && output >= 0 ? output : undefined;
  return {
    promptTokens,
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(!inputOnly && completionTokens !== undefined ? { totalTokens: promptTokens + completionTokens } : {}),
    ...(typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0
      ? { contextWindow, contextWindowSource: 'configured' as const } : {}),
  };
}
