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
      cacheReadTokens: 0,
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
    expect(result.completionTokens).toBe(30);
    // The "fresh" figure the UI shows excludes the re-read.
    expect(result.promptTokens - result.cacheReadTokens).toBe(202);
  });

  it('falls back to the last turn + summed output when the result message is absent (handoff)', () => {
    const result = mapSdkUsage(undefined, {
      lastTurnUsage: { input_tokens: 10, cache_read_input_tokens: 100 },
      totalOutputTokens: 40,
    });
    expect(result.promptTokens).toBe(110); // 10 + 100
    expect(result.cacheReadTokens).toBe(100);
    expect(result.completionTokens).toBe(40);
  });

  it('prefers the result message usage over the fallback when both are present', () => {
    const result = mapSdkUsage(
      { input_tokens: 5, output_tokens: 7 },
      { lastTurnUsage: { input_tokens: 9999 }, totalOutputTokens: 9999 },
    );
    expect(result.promptTokens).toBe(5);
    expect(result.completionTokens).toBe(7);
    expect(result.cacheReadTokens).toBe(0);
  });

  it('returns all zeros when nothing is known', () => {
    expect(mapSdkUsage(undefined)).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
    });
  });
});
