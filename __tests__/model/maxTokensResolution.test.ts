import { resolveEffectiveMaxTokens } from '@/backend/execution/flow/handlers/maxTokens';

// Coverage for issue #189: node-level per-run maxTokens override. The effective
// per-completion output-token cap is resolved with the precedence
// per-node override → bound-model setting → adapter default. Unlike maxTurns,
// there is NO numeric system default: everything unset yields `undefined` so
// the adapter's own default stays authoritative.
describe('resolveEffectiveMaxTokens (issue #189)', () => {
  it('returns undefined when nothing is set (adapter default applies)', () => {
    expect(resolveEffectiveMaxTokens(undefined, undefined)).toBeUndefined();
  });

  it('uses the model setting when there is no node override', () => {
    expect(resolveEffectiveMaxTokens(undefined, 8192)).toBe(8192);
  });

  it('lets the per-node override win over the model setting', () => {
    expect(resolveEffectiveMaxTokens(2000, 8192)).toBe(2000);
  });

  it('uses the node override even when the model setting is unset', () => {
    expect(resolveEffectiveMaxTokens(4096, undefined)).toBe(4096);
  });

  it('ignores zero / negative / NaN at each level and falls through', () => {
    expect(resolveEffectiveMaxTokens(0, 8192)).toBe(8192);
    expect(resolveEffectiveMaxTokens(-5, 8192)).toBe(8192);
    expect(resolveEffectiveMaxTokens(NaN, 8192)).toBe(8192);
    expect(resolveEffectiveMaxTokens(0, 0)).toBeUndefined();
    expect(resolveEffectiveMaxTokens(-1, -1)).toBeUndefined();
  });

  it('floors positive floats to integers (via normalizeMaxTokens)', () => {
    expect(resolveEffectiveMaxTokens(1000.9, undefined)).toBe(1000);
    expect(resolveEffectiveMaxTokens(undefined, 512.4)).toBe(512);
  });
});
