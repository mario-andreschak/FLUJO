import { mapOpenAiUsage } from '@/backend/services/model/adapters/openaiUsage';
import { mapCodexUsage } from '@/backend/services/model/adapters/codexUsage';
import { mapSdkUsage } from '@/backend/services/model/adapters/claudeUsage';
import { summarizeTokenMeter } from '@/shared/utils/tokenUsage';

describe('token meter provider consistency', () => {
  it('normalizes Chat Completions, Codex, and Agent SDK usage identically', () => {
    const chatCompletions = mapOpenAiUsage({
      prompt_tokens: 1_000,
      completion_tokens: 100,
      total_tokens: 1_100,
      prompt_tokens_details: {
        cached_tokens: 700,
        cache_write_tokens: 200,
      },
    });
    const codex = mapCodexUsage({
      input_tokens: 1_000,
      cached_input_tokens: 700,
      cache_write_input_tokens: 200,
      output_tokens: 100,
    });
    // Anthropic's Agent SDK reports fresh/cache-write/cache-read input as
    // separate buckets, unlike the two OpenAI paths whose input total already
    // includes both cache subsets.
    const agentSdk = mapSdkUsage({
      input_tokens: 100,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 700,
      output_tokens: 100,
    });

    expect(chatCompletions).toEqual(codex);
    expect(agentSdk).toEqual(codex);
    expect(summarizeTokenMeter(chatCompletions!)).toEqual({
      freshPromptTokens: 300,
      completionTokens: 100,
      meterTotalTokens: 400,
      processedTotalTokens: 1_100,
      cacheReadTokens: 700,
      cacheWriteTokens: 200,
    });
    expect(summarizeTokenMeter(codex)).toEqual(summarizeTokenMeter(chatCompletions!));
    expect(summarizeTokenMeter(agentSdk)).toEqual(summarizeTokenMeter(chatCompletions!));
  });
});
