import { mapSdkUsage } from '@/backend/services/model/adapters/claudeUsage';

/**
 * Unit coverage for the Claude Subscription adapter's token-usage mapping (#87).
 *
 * The defect was folding cache RE-READ tokens into the headline prompt count,
 * so a warmed-cache conversation reported millions of tokens. mapSdkUsage keeps
 * promptTokens as the full input context but surfaces the cheap re-read subset
 * separately so the UI can show an honest "fresh (+cached)" split.
 */
describe('mapSdkUsage (#87)', () => {
  it('reports a fresh, uncached turn as-is with zero cache reads', () => {
    const result = mapSdkUsage({ input_tokens: 100, output_tokens: 50 });
    expect(result).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it('keeps promptTokens as the FULL context but splits out cache re-reads', () => {
    // A warmed-cache turn: barely any fresh input, a big cheap re-read, a small
    // cache write. The re-read must be reported separately, not as fresh input.
    const result = mapSdkUsage({
      input_tokens: 2,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 5000,
      output_tokens: 30,
    });
    expect(result.promptTokens).toBe(5202); // 2 + 200 + 5000 (full context)
    expect(result.cacheReadTokens).toBe(5000); // the cheap re-read subset
    expect(result.cacheWriteTokens).toBe(200);
    expect(result.completionTokens).toBe(30);
    expect(result.totalTokens).toBe(5232);
    // The "fresh" figure the UI shows excludes the re-read.
    expect(result.promptTokens - result.cacheReadTokens).toBe(202);
  });

  it('returns all zeros when nothing is known', () => {
    expect(mapSdkUsage(undefined)).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
});
