import { mapOpenAiUsage } from '@/backend/services/model/adapters/openaiUsage';

/**
 * Unit coverage for the OpenAI-compatible path's token-usage mapping (#89,
 * sibling of #87).
 *
 * A ProcessNode bound to several MCP servers ships a large (~20k-token) tool
 * prefix on every stateless Chat Completions call. Providers auto-cache that
 * prefix and report the cheap re-read under `prompt_tokens_details.cached_tokens`,
 * but `prompt_tokens` still counts it — inflating the headline. mapOpenAiUsage
 * keeps promptTokens as the full context but surfaces the re-read subset
 * separately so the UI can show an honest "fresh (+cached)" split.
 *
 * This also locks in that nothing strips `prompt_tokens_details` between the
 * OpenAI adapter (which returns the provider completion unchanged) and the
 * ModelHandler usage extraction.
 */
describe('mapOpenAiUsage (#89)', () => {
  it('returns undefined when the completion carried no usage block', () => {
    expect(mapOpenAiUsage(undefined)).toBeUndefined();
    expect(mapOpenAiUsage(null)).toBeUndefined();
  });

  it('maps a plain (no cache) completion and omits cacheReadTokens entirely', () => {
    const result = mapOpenAiUsage({
      prompt_tokens: 500,
      completion_tokens: 42,
      total_tokens: 542,
    });
    expect(result).toEqual({
      promptTokens: 500,
      completionTokens: 42,
      totalTokens: 542,
    });
    // Absent (not 0) so consumers can tell "provider doesn't report caching"
    // apart from a genuine zero-cache turn.
    expect(result).not.toHaveProperty('cacheReadTokens');
  });

  it('keeps promptTokens as the FULL context but splits out cached re-reads', () => {
    // A warm turn: 500k prompt tokens of which ~385k were cheaply re-read from
    // the provider's automatic prefix cache (the #89 scenario).
    const result = mapOpenAiUsage({
      prompt_tokens: 500_000,
      completion_tokens: 120,
      total_tokens: 500_120,
      prompt_tokens_details: { cached_tokens: 385_000 },
    });
    expect(result?.promptTokens).toBe(500_000); // full context, unchanged
    expect(result?.cacheReadTokens).toBe(385_000); // cheap re-read subset
    expect(result?.completionTokens).toBe(120);
    // The "fresh" figure the UI shows excludes the re-read.
    expect(result!.promptTokens - result!.cacheReadTokens!).toBe(115_000);
  });

  it('treats an explicit zero cached_tokens as a reported (present) zero', () => {
    const result = mapOpenAiUsage({
      prompt_tokens: 300,
      completion_tokens: 10,
      total_tokens: 310,
      prompt_tokens_details: { cached_tokens: 0 },
    });
    expect(result?.cacheReadTokens).toBe(0);
  });

  it('defaults missing numeric fields to 0', () => {
    expect(mapOpenAiUsage({})).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
  });
});
