import type { CodexUsageLike } from './codexUsage';
import type { ModelContextUsage } from '@/shared/types/model/contextUsage';

/** Released app-server wire contract admitted by FLUJO, independent of SDK exec. */
export const CODEX_APP_SERVER_CONTRACT = 'flujo-codex-app-server-v1';
export function codexRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Codex protocol response.');
  return value as Record<string, unknown>;
}
export function codexId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256) throw new Error('Invalid Codex protocol identity.');
  return value;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid Codex token usage.');
  return value;
}
function tokens(value: unknown): CodexUsageLike {
  const row = codexRecord(value);
  const usage: CodexUsageLike = { input_tokens: count(row.inputTokens), output_tokens: count(row.outputTokens) };
  for (const [wire, field] of [
    ['cachedInputTokens', 'cached_input_tokens'], ['cacheWriteInputTokens', 'cache_write_input_tokens'],
    ['reasoningOutputTokens', 'reasoning_output_tokens'],
  ] as const) {
    if (row[wire] != null) {
      const value = count(row[wire]);
      if (value > (wire === 'reasoningOutputTokens' ? usage.output_tokens! : usage.input_tokens!)) throw new Error('Invalid Codex token subset.');
      usage[field] = value;
    }
  }
  return usage;
}
export function parseCodexProtocolUsage(value: unknown): { total: CodexUsageLike; context: ModelContextUsage } {
  const row = codexRecord(value);
  const total = tokens(row.total), last = tokens(row.last);
  return { total, context: {
    promptTokens: last.input_tokens!, completionTokens: last.output_tokens!,
    totalTokens: last.input_tokens! + last.output_tokens!,
    ...(row.modelContextWindow != null && count(row.modelContextWindow) > 0
      ? { contextWindow: count(row.modelContextWindow), contextWindowSource: 'runtime' as const } : {}),
  } };
}
