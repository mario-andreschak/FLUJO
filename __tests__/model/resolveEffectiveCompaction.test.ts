import {
  resolveEffectiveCompaction,
  DEFAULT_COMPACTION_BUFFER_TOKENS,
  DEFAULT_COMPACTION_KEEP_TOKENS,
  resolveEffectiveVisualCompaction,
} from '@/backend/execution/flow/handlers/resolveEffectiveCompaction';

describe('resolveEffectiveCompaction (issue #248)', () => {
  it('is disabled by default (no global flag)', () => {
    const r = resolveEffectiveCompaction();
    expect(r.enabled).toBe(false);
    expect(r.keepTokens).toBe(DEFAULT_COMPACTION_KEEP_TOKENS);
    expect(r.bufferTokens).toBe(DEFAULT_COMPACTION_BUFFER_TOKENS);
    expect(r.threshold).toBeUndefined();
  });

  it('enables only when the global flag is on', () => {
    expect(resolveEffectiveCompaction(undefined, undefined, { compactionEnabled: true }).enabled).toBe(true);
    expect(resolveEffectiveCompaction(undefined, undefined, { compactionEnabled: false }).enabled).toBe(false);
  });

  it('lets a node opt OUT but not opt IN', () => {
    // opt out while global on
    expect(
      resolveEffectiveCompaction({ compactionMode: 'off' }, undefined, { compactionEnabled: true }).enabled,
    ).toBe(false);
    // a node cannot enable compaction by itself
    expect(
      resolveEffectiveCompaction({ compactionMode: 'auto' }, undefined, { compactionEnabled: false }).enabled,
    ).toBe(false);
    // auto + global on = enabled
    expect(
      resolveEffectiveCompaction({ compactionMode: 'auto' }, undefined, { compactionEnabled: true }).enabled,
    ).toBe(true);
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
});

describe('resolveEffectiveVisualCompaction (issue #356)', () => {
  it('migrates missing persisted values to safe defaults', () => {
    expect(resolveEffectiveVisualCompaction()).toEqual({
      enabled: false,
      toolResultsOnly: true,
      evaluationOnly: false,
    });
  });

  it('keeps the controls independent', () => {
    expect(resolveEffectiveVisualCompaction({
      visualCompactionEnabled: true,
      visualCompactionToolResultsOnly: false,
      visualCompactionEvaluationMode: true,
    })).toEqual({
      enabled: true,
      toolResultsOnly: false,
      evaluationOnly: true,
    });
  });
});
