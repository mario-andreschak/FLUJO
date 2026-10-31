/**
 * Prompt-cache stability: freeze the system prompt per conversation (issue #249).
 *
 * The system prompt is frozen per (conversation, node) on first render and
 * re-sent byte-identically thereafter, so it forms a stable provider cache
 * prefix (mirrors the #89 tool-block freeze). A later render that drifts (a live
 * `${resource:}` / `${kv:}` pill or a date rollover) neither changes the frozen
 * prefix nor adds a message to the conversation (issue #1333).
 *
 * These tests exercise the pure freeze decision (`resolveFrozenSystemPrompt`)
 * that `ProcessNode.prep()` delegates to, so they don't need the full,
 * heavily-mocked prep() pipeline.
 */
import { resolveFrozenSystemPrompt } from '@/backend/execution/flow/systemPromptFreeze';

const NODE = 'node-1';

describe('resolveFrozenSystemPrompt (issue #249)', () => {
  it('freezes the prompt on first render and reports frozeNow', () => {
    const first = resolveFrozenSystemPrompt(NODE, 'SYS v1', undefined);
    expect(first.frozeNow).toBe(true);
    expect(first.content).toBe('SYS v1');
    expect(first.frozenSystemPrompts[NODE]).toBe('SYS v1');
  });

  it('sends byte-identical content on the next turn even when the fresh render drifts', () => {
    const frozen = { [NODE]: 'SYS v1' };
    // Second turn: the live render drifted (e.g. a ${resource:} pill changed).
    const second = resolveFrozenSystemPrompt(NODE, 'SYS v2 (drifted)', frozen);

    // The wire content is still the FROZEN string, byte-for-byte.
    expect(second.content).toBe('SYS v1');
    expect(second.frozeNow).toBe(false);
    // Frozen map is unchanged (not mutated to the drifted value).
    expect(second.frozenSystemPrompts[NODE]).toBe('SYS v1');
    // Nothing besides the wire content is produced (no drift message).
    expect(Object.keys(second).sort()).toEqual(['content', 'frozeNow', 'frozenSystemPrompts']);
  });

  it('reuses the frozen prompt when the fresh render matches it', () => {
    const frozen = { [NODE]: 'SYS v1' };
    const again = resolveFrozenSystemPrompt(NODE, 'SYS v1', frozen);
    expect(again).toEqual({ content: 'SYS v1', frozenSystemPrompts: frozen, frozeNow: false });
  });

  it('keeps a per-node frozen prompt for multi-node handoff runs', () => {
    const afterN1 = resolveFrozenSystemPrompt('n1', 'PROMPT-1', undefined);
    const afterN2 = resolveFrozenSystemPrompt('n2', 'PROMPT-2', afterN1.frozenSystemPrompts);
    expect(afterN2.frozenSystemPrompts).toEqual({ n1: 'PROMPT-1', n2: 'PROMPT-2' });

    // Re-visiting n1 with a drifted render still returns n1's original frozen prompt.
    const reN1 = resolveFrozenSystemPrompt('n1', 'PROMPT-1-drift', afterN2.frozenSystemPrompts);
    expect(reN1.content).toBe('PROMPT-1');
  });

  it('date rollover mid-conversation does not change the frozen system prompt', () => {
    // Simulate a system prompt that embeds "today's date": on day 2 the fresh
    // render differs, but the frozen prefix (and thus the wire content) is stable.
    const day1 = resolveFrozenSystemPrompt(NODE, 'Today is 2026-07-27', undefined);
    const day2 = resolveFrozenSystemPrompt(NODE, 'Today is 2026-07-28', day1.frozenSystemPrompts);
    expect(day2.content).toBe('Today is 2026-07-27');
    expect(day2.frozenSystemPrompts[NODE]).toBe('Today is 2026-07-27');
  });
});
