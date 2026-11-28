import {
  resolveEffectiveCompaction,
  DEFAULT_COMPACTION_BUFFER_TOKENS,
  DEFAULT_COMPACTION_KEEP_TOKENS,
} from '@/backend/execution/flow/handlers/resolveEffectiveCompaction';

describe('resolveEffectiveCompaction (issue #248)', () => {
  it.each([2048, 32_768, 200_000, 1_050_000, 2_000_000])('fits reserve and retained context for a %i-token model', contextWindow => {
    const settings = resolveEffectiveCompaction(undefined, { contextWindow });
    expect(settings.bufferTokens).toBe(Math.min(50_000, Math.floor(contextWindow * 0.4)));
    expect(settings.keepTokens).toBe(Math.min(19_000, Math.floor(contextWindow * 0.15)));
    expect(contextWindow - settings.bufferTokens).toBeGreaterThan(settings.keepTokens);
  });
  it('fits persisted absolute budgets when switching to a smaller model', () => {
    const settings = resolveEffectiveCompaction(undefined, { contextWindow: 200_000 },
      { compactionBufferTokens: 400_000, compactionKeepTokens: 150_000 });
    expect(settings).toMatchObject({ bufferTokens: 80_000, keepTokens: 30_000 });
  });
  it('is enabled by default (no global flag)', () => {
    const r = resolveEffectiveCompaction();
    expect(r.enabled).toBe(true);
    expect(r.keepTokens).toBe(DEFAULT_COMPACTION_KEEP_TOKENS);
    expect(r.bufferTokens).toBe(DEFAULT_COMPACTION_BUFFER_TOKENS);
    expect(r.threshold).toBeUndefined();
  });

  it('lets a node turn it off; there is no global switch (#1449)', () => {
    expect(resolveEffectiveCompaction({ compactionMode: 'off' }).enabled).toBe(false);
    expect(resolveEffectiveCompaction({ compactionMode: 'auto' }).enabled).toBe(true);
  });

  it('resolves keepTokens with node > global > default precedence', () => {
    expect(
      resolveEffectiveCompaction({ compactionKeepTokens: 111 }, undefined, { compactionKeepTokens: 222 }).keepTokens,
    ).toBe(111);
    expect(
      resolveEffectiveCompaction(undefined, undefined, { compactionKeepTokens: 222 }).keepTokens,
    ).toBe(222);
    expect(resolveEffectiveCompaction().keepTokens).toBe(DEFAULT_COMPACTION_KEEP_TOKENS);
  });

  it('ignores non-positive / non-finite overrides (falls through)', () => {
    expect(
      resolveEffectiveCompaction({ compactionKeepTokens: 0 }, undefined, { compactionKeepTokens: 500 }).keepTokens,
    ).toBe(500);
    expect(
      resolveEffectiveCompaction({ compactionKeepTokens: -5 }, undefined, {}).keepTokens,
    ).toBe(DEFAULT_COMPACTION_KEEP_TOKENS);
  });

  it('carries a positive per-model threshold override', () => {
    expect(resolveEffectiveCompaction(undefined, { compactionThreshold: 90000 }).threshold).toBe(90000);
    expect(resolveEffectiveCompaction(undefined, { compactionThreshold: 0 }).threshold).toBeUndefined();
  });

  it('resolves bufferTokens from global then default', () => {
    expect(resolveEffectiveCompaction(undefined, undefined, { compactionBufferTokens: 30000 }).bufferTokens).toBe(30000);
    expect(resolveEffectiveCompaction().bufferTokens).toBe(DEFAULT_COMPACTION_BUFFER_TOKENS);
  });

  it('uses the saved model percentage before the global percentage and ignores invalid values', () => {
    expect(resolveEffectiveCompaction(undefined, { compactionThresholdPercent: 40 },
      { compactionThresholdPercent: 75 }).thresholdPercent).toBe(40);
    expect(resolveEffectiveCompaction(undefined, { compactionThresholdPercent: 101 },
      { compactionThresholdPercent: 60 }).thresholdPercent).toBe(60);
  });
});
