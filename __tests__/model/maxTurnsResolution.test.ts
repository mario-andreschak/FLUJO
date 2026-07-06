import { resolveEffectiveMaxTurns } from '@/backend/execution/flow/handlers/maxTurns';
import { DEFAULT_AGENTIC_MAX_TURNS } from '@/shared/types/model/model';

// Regression coverage for issue #48: the agentic-turn cap used to be a
// hard-coded 30 in ProcessNode. It is now resolved with the precedence
// per-node override → bound-model setting → system default (50).
describe('resolveEffectiveMaxTurns (issue #48)', () => {
  it('defaults to 50 when nothing is set', () => {
    expect(DEFAULT_AGENTIC_MAX_TURNS).toBe(50);
    expect(resolveEffectiveMaxTurns(undefined, undefined)).toBe(50);
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

  it('never returns the old hard-coded cap of 30 by default', () => {
    // Guards against the regression reported in #48.
    expect(resolveEffectiveMaxTurns(undefined, undefined)).not.toBe(30);
  });

  it('honours an explicit fallback argument', () => {
    expect(resolveEffectiveMaxTurns(undefined, undefined, 10)).toBe(10);
  });
});
