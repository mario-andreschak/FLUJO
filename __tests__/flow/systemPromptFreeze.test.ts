/**
 * Prompt-cache stability: freeze the system prompt per conversation (issue #249).
 *
 * The system prompt is frozen per (conversation, node) on first render and
 * re-sent byte-identically thereafter, so it forms a stable provider cache
 * prefix (mirrors the #89 tool-block freeze). When a live `${resource:}` /
 * `${kv:}` pill (or a date rollover) makes a later render drift, the frozen
 * prefix must NOT change — the drift is surfaced as a synthetic `[System
 * update]` user message at the tail instead.
 *
 * These tests exercise the pure freeze decision (`resolveFrozenSystemPrompt`)
 * that `ProcessNode.prep()` delegates to, so they don't need the full,
 * heavily-mocked prep() pipeline.
 */
import {
  resolveFrozenSystemPrompt,
  buildSystemUpdateText,
  SYSTEM_UPDATE_PREFIX,
  type DriftMessageView,
} from '@/backend/execution/flow/systemPromptDrift';

const NODE = 'node-1';

describe('resolveFrozenSystemPrompt (issue #249)', () => {
  it('freezes the prompt on first render and reports frozeNow', () => {
    const first = resolveFrozenSystemPrompt(NODE, 'SYS v1', undefined, []);
    expect(first.frozeNow).toBe(true);
    expect(first.content).toBe('SYS v1');
    expect(first.frozenSystemPrompts[NODE]).toBe('SYS v1');
    expect(first.driftUpdate).toBeUndefined();
  });

  it('sends byte-identical content on the next turn even when the fresh render drifts', () => {
    const frozen = { [NODE]: 'SYS v1' };
    // Second turn: the live render drifted (e.g. a ${resource:} pill changed).
    const second = resolveFrozenSystemPrompt(NODE, 'SYS v2 (drifted)', frozen, []);

    // The wire content is still the FROZEN string, byte-for-byte.
    expect(second.content).toBe('SYS v1');
    expect(second.frozeNow).toBe(false);
    // Frozen map is unchanged (not mutated to the drifted value).
    expect(second.frozenSystemPrompts[NODE]).toBe('SYS v1');
    // A drift update is emitted exactly once.
    expect(second.driftUpdate).toBe(buildSystemUpdateText('SYS v1', 'SYS v2 (drifted)'));
    expect(second.driftUpdate).toContain(SYSTEM_UPDATE_PREFIX);
  });

  it('emits no drift update when the fresh render matches the frozen prompt', () => {
    const frozen = { [NODE]: 'SYS v1' };
    const again = resolveFrozenSystemPrompt(NODE, 'SYS v1', frozen, []);
    expect(again.content).toBe('SYS v1');
    expect(again.driftUpdate).toBeUndefined();
  });

  it('dedupes an identical drift update already present at the tail (no tool-loop spam)', () => {
    const frozen = { [NODE]: 'SYS v1' };
    const driftText = buildSystemUpdateText('SYS v1', 'SYS v2 (drifted)');
    const existing: DriftMessageView[] = [
      { role: 'user', content: 'the task' },
      { role: 'assistant', content: 'working' },
      { role: 'user', content: driftText }, // update from an earlier prep() iteration
    ];

    const decision = resolveFrozenSystemPrompt(NODE, 'SYS v2 (drifted)', frozen, existing);
    expect(decision.content).toBe('SYS v1');
    expect(decision.driftUpdate).toBeUndefined();
  });

  it('keeps a per-node frozen prompt for multi-node handoff runs', () => {
    const afterN1 = resolveFrozenSystemPrompt('n1', 'PROMPT-1', undefined, []);
    const afterN2 = resolveFrozenSystemPrompt('n2', 'PROMPT-2', afterN1.frozenSystemPrompts, []);
    expect(afterN2.frozenSystemPrompts).toEqual({ n1: 'PROMPT-1', n2: 'PROMPT-2' });

    // Re-visiting n1 with a drifted render still returns n1's original frozen prompt.
    const reN1 = resolveFrozenSystemPrompt('n1', 'PROMPT-1-drift', afterN2.frozenSystemPrompts, []);
    expect(reN1.content).toBe('PROMPT-1');
  });

  it('date rollover mid-conversation does not change the frozen system prompt', () => {
    // Simulate a system prompt that embeds "today's date": on day 2 the fresh
    // render differs, but the frozen prefix (and thus the wire content) is stable.
    const day1 = resolveFrozenSystemPrompt(NODE, 'Today is 2026-07-27', undefined, []);
    expect(day1.frozenSystemPrompts[NODE]).toBe('Today is 2026-07-27');

    const day2 = resolveFrozenSystemPrompt(
      NODE,
      'Today is 2026-07-28',
      day1.frozenSystemPrompts,
      []
    );
    expect(day2.content).toBe('Today is 2026-07-27');
    expect(day2.frozenSystemPrompts[NODE]).toBe('Today is 2026-07-27');
    expect(day2.driftUpdate).toContain('2026-07-28');
  });
});
