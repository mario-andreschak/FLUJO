import { resolveEffectiveMaxTurns } from '@/backend/execution/flow/handlers/maxTurns';
import { DEFAULT_AGENTIC_MAX_TURNS } from '@/shared/types/model/model';

// Regression coverage for issue #48: the agentic-turn cap used to be a
// hard-coded 30 in ProcessNode. It is now resolved with the precedence
// per-node override → bound-model setting → system default (255, raised from
// 50 in issue #399).
describe('resolveEffectiveMaxTurns (issues #48, #399)', () => {
  it('defaults to 255 when nothing is set (#399)', () => {
    expect(DEFAULT_AGENTIC_MAX_TURNS).toBe(255);
    expect(resolveEffectiveMaxTurns(undefined, undefined)).toBe(255);
  });

  it('uses the model setting when there is no node override', () => {
    expect(resolveEffectiveMaxTurns(undefined, 120)).toBe(120);
  });

  it('lets the per-node override win over the model setting', () => {
    expect(resolveEffectiveMaxTurns(200, 120)).toBe(200);
  });

  it('uses the node override even when the model setting is unset', () => {
    expect(resolveEffectiveMaxTurns(75, undefined)).toBe(75);
  });

  it('ignores zero / negative / NaN at each level and falls through', () => {
    expect(resolveEffectiveMaxTurns(0, 120)).toBe(120);
    expect(resolveEffectiveMaxTurns(-5, 120)).toBe(120);
    expect(resolveEffectiveMaxTurns(NaN, 120)).toBe(120);
    expect(resolveEffectiveMaxTurns(0, 0)).toBe(DEFAULT_AGENTIC_MAX_TURNS);
    expect(resolveEffectiveMaxTurns(-1, -1)).toBe(DEFAULT_AGENTIC_MAX_TURNS);
  });

  it('never returns an old default (30 or 50) by default', () => {
    // Guards against the regressions reported in #48 and #399.
    expect(resolveEffectiveMaxTurns(undefined, undefined)).not.toBe(30);
    expect(resolveEffectiveMaxTurns(undefined, undefined)).not.toBe(50);
  });

  it('falls back to 255 for every invalid value combination (#399)', () => {
    expect(resolveEffectiveMaxTurns(undefined, undefined)).toBe(255);
    expect(resolveEffectiveMaxTurns(0, 0)).toBe(255);
    expect(resolveEffectiveMaxTurns(-3, -7)).toBe(255);
    expect(resolveEffectiveMaxTurns(NaN, NaN)).toBe(255);
    expect(resolveEffectiveMaxTurns(Infinity, Infinity)).toBe(255);
  });

  it('still lets an explicit 255-and-beyond override through unchanged', () => {
    expect(resolveEffectiveMaxTurns(255, undefined)).toBe(255);
    expect(resolveEffectiveMaxTurns(undefined, 255)).toBe(255);
    expect(resolveEffectiveMaxTurns(1, 255)).toBe(1);
  });

  it('honours an explicit fallback argument', () => {
    expect(resolveEffectiveMaxTurns(undefined, undefined, 10)).toBe(10);
  });
});
