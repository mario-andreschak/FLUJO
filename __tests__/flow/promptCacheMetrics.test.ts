/**
 * Tests for promptCacheMetrics — prefix-drift attribution for provider prompt-cache
 * misses.
 *
 * Pins:
 *  - a byte-identical prefix classifies as 'none'
 *  - a changed tool block classifies as 'tools' (the full-prefix-loss case)
 *  - a changed system message classifies as 'system'
 *  - both changing classifies as 'both'
 *  - growing the history does NOT count as drift (that is the whole point)
 *  - tool ORDER changes are drift (providers hash bytes, not sets)
 *  - the first call on a conversation classifies as 'first'
 *  - conversations are tracked independently
 */

import type OpenAI from 'openai';
import {
  fingerprintPrefix,
  classifyDrift,
  firstDivergentIndex,
  derivePromptCacheKey,
  __resetPrefixTracking,
  forgetConversationPrefix,
} from '@/backend/execution/flow/handlers/promptCacheMetrics';

const tool = (name: string, description = `Tool: ${name}`): OpenAI.ChatCompletionFunctionTool => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties: {} } },
});

const sys = (content: string): OpenAI.ChatCompletionMessageParam => ({
  role: 'system',
  content,
});

const user = (content: string): OpenAI.ChatCompletionMessageParam => ({
  role: 'user',
  content,
});

/** Fingerprint + classify in one step, as ModelHandler does per call. */
const call = (
  conversationId: string,
  messages: OpenAI.ChatCompletionMessageParam[],
  tools?: OpenAI.ChatCompletionFunctionTool[],
) => classifyDrift(conversationId, fingerprintPrefix(messages, tools)).drift;

/** The full drift report, for the tests that assert on cache reach. */
const report = (
  conversationId: string,
  messages: OpenAI.ChatCompletionMessageParam[],
  tools?: OpenAI.ChatCompletionFunctionTool[],
) => classifyDrift(conversationId, fingerprintPrefix(messages, tools));

beforeEach(() => {
  __resetPrefixTracking();
});

describe('classifyDrift', () => {
  it('classifies the first call on a conversation as "first"', () => {
    expect(call('c1', [sys('S'), user('hi')], [tool('a')])).toBe('first');
  });

  it('classifies a byte-identical prefix as "none"', () => {
    const tools = [tool('a'), tool('b')];
    call('c1', [sys('S'), user('hi')], tools);
    expect(call('c1', [sys('S'), user('hi')], tools)).toBe('none');
  });

  it('does not count a GROWING history as drift', () => {
    const tools = [tool('a')];
    call('c1', [sys('S'), user('turn 1')], tools);
    const drift = call(
      'c1',
      [sys('S'), user('turn 1'), { role: 'assistant', content: 'ok' }, user('turn 2')],
      tools,
    );
    // Appending to the end is exactly what prefix caching is meant to absorb.
    expect(drift).toBe('none');
  });

  it('classifies an added tool as "tools"', () => {
    call('c1', [sys('S'), user('hi')], [tool('a')]);
    expect(call('c1', [sys('S'), user('hi')], [tool('a'), tool('b')])).toBe('tools');
  });

  it('classifies a changed tool DESCRIPTION as "tools"', () => {
    call('c1', [sys('S')], [tool('a', 'servers: x, y')]);
    expect(call('c1', [sys('S')], [tool('a', 'servers: y')])).toBe('tools');
  });

  it('classifies a reordered tool block as "tools" (bytes, not sets)', () => {
    call('c1', [sys('S')], [tool('a'), tool('b')]);
    expect(call('c1', [sys('S')], [tool('b'), tool('a')])).toBe('tools');
  });

  it('classifies a REWRITTEN history message as "history", not "none"', () => {
    // This is what compactForWire does: an old oversized tool result is rewritten
    // in place to an excerpt + flujo://run/... pointer. The tools and the system
    // message are untouched, but the cache is lost from that message onward — the
    // single largest real source of misses, and previously reported as 'none'.
    const tools = [tool('a')];
    const before: OpenAI.ChatCompletionMessageParam[] = [
      sys('S'),
      user('go'),
      { role: 'tool', tool_call_id: 'c1', content: 'X'.repeat(5000) },
    ];
    const after: OpenAI.ChatCompletionMessageParam[] = [
      sys('S'),
      user('go'),
      { role: 'tool', tool_call_id: 'c1', content: 'X'.repeat(200) + ' flujo://run/conv/1' },
      user('next turn'),
    ];

    call('c1', before, tools);
    const r = report('c1', after, tools);

    expect(r.drift).toBe('history');
    // Diverged at the rewritten tool result; the two messages before it still hit.
    expect(r.divergedAt).toBe(2);
    expect(r.stableMessages).toBe(2);
    expect(r.totalMessages).toBe(4);
  });

  it('reports full cache reach for a pure append', () => {
    const tools = [tool('a')];
    call('c1', [sys('S'), user('t1')], tools);
    const r = report('c1', [sys('S'), user('t1'), { role: 'assistant', content: 'ok' }], tools);

    expect(r.drift).toBe('none');
    expect(r.divergedAt).toBe(-1);
    expect(r.stableMessages).toBe(2);
    expect(r.totalMessages).toBe(3);
  });

  it('does not call trailing truncation drift (the user-last-message strip)', () => {
    // Dropping a trailing assistant turn leaves the cached prefix intact.
    const tools = [tool('a')];
    call('c1', [sys('S'), user('t1'), { role: 'assistant', content: 'ok' }], tools);
    expect(report('c1', [sys('S'), user('t1')], tools).drift).toBe('none');
  });

  it('attributes a re-rendered system prompt to "system" even though it is index 0', () => {
    const tools = [tool('a')];
    call('c1', [sys('S'), user('go')], tools);
    const r = report('c1', [sys('S with re-read resource'), user('go')], tools);

    expect(r.drift).toBe('system');
    expect(r.divergedAt).toBe(0);
    expect(r.stableMessages).toBe(0);
  });

  it('reports "both" when the tool block changes and the history is rewritten', () => {
    call('c1', [sys('S'), user('go'), { role: 'tool', tool_call_id: 'c', content: 'big' }], [tool('a')]);
    const r = report(
      'c1',
      [sys('S'), user('go'), { role: 'tool', tool_call_id: 'c', content: 'small' }],
      [tool('a'), tool('b')],
    );
    expect(r.drift).toBe('both');
  });

  it('classifies a changed system message as "system"', () => {
    const tools = [tool('a')];
    call('c1', [sys('S')], tools);
    expect(call('c1', [sys('S with a freshly re-read resource')], tools)).toBe('system');
  });

  it('classifies both changing as "both"', () => {
    call('c1', [sys('S')], [tool('a')]);
    expect(call('c1', [sys('S2')], [tool('a'), tool('b')])).toBe('both');
  });

  it('treats dropping the tool block entirely as drift', () => {
    call('c1', [sys('S')], [tool('a')]);
    expect(call('c1', [sys('S')], undefined)).toBe('tools');
  });

  it('tracks conversations independently', () => {
    call('c1', [sys('S')], [tool('a')]);
    expect(call('c2', [sys('S')], [tool('a')])).toBe('first');
    expect(call('c1', [sys('S')], [tool('a')])).toBe('none');
  });

  it('classifies as "first" when no conversationId is in scope', () => {
    expect(call(undefined as unknown as string, [sys('S')], [tool('a')])).toBe('first');
    // ...and records nothing, so a later identified call is still 'first'.
    expect(call('c1', [sys('S')], [tool('a')])).toBe('first');
  });

  it('forgetConversationPrefix resets a conversation to "first"', () => {
    call('c1', [sys('S')], [tool('a')]);
    forgetConversationPrefix('c1');
    expect(call('c1', [sys('S')], [tool('a')])).toBe('first');
  });
});

describe('firstDivergentIndex', () => {
  it('returns -1 when one array is a pure prefix of the other', () => {
    expect(firstDivergentIndex(['a', 'b'], ['a', 'b', 'c'])).toBe(-1);
    expect(firstDivergentIndex(['a', 'b', 'c'], ['a', 'b'])).toBe(-1);
    expect(firstDivergentIndex(['a'], ['a'])).toBe(-1);
    expect(firstDivergentIndex([], ['a'])).toBe(-1);
  });

  it('returns the index of the first differing element', () => {
    expect(firstDivergentIndex(['a', 'b', 'c'], ['a', 'X', 'c'])).toBe(1);
    expect(firstDivergentIndex(['a'], ['X', 'b'])).toBe(0);
  });
});

describe('fingerprintPrefix', () => {
  it('reports tool count and serialized size', () => {
    const fp = fingerprintPrefix([sys('S')], [tool('a'), tool('b')]);
    expect(fp.toolCount).toBe(2);
    expect(fp.toolChars).toBeGreaterThan(0);
    expect(fp.tools).toBeTruthy();
    expect(fp.system).toBeTruthy();
  });

  it('omits hashes that have no corresponding segment', () => {
    const fp = fingerprintPrefix([user('no system message')], undefined);
    expect(fp.tools).toBeUndefined();
    expect(fp.system).toBeUndefined();
    expect(fp.toolCount).toBe(0);
  });

  it('only fingerprints a system message in the LEADING position', () => {
    // A system message that is not at index 0 is not a cacheable prefix segment.
    const fp = fingerprintPrefix([user('hi'), sys('S')], undefined);
    expect(fp.system).toBeUndefined();
  });
});

describe('derivePromptCacheKey', () => {
  const keyFor = (
    messages: OpenAI.ChatCompletionMessageParam[],
    tools?: OpenAI.ChatCompletionFunctionTool[],
  ) => derivePromptCacheKey(fingerprintPrefix(messages, tools));

  it('is stable across turns while the tool block is unchanged', () => {
    const tools = [tool('a'), tool('b')];
    const turn1 = keyFor([sys('S'), user('t1')], tools);
    const turn2 = keyFor([sys('S'), user('t1'), user('t2')], tools);
    expect(turn1).toBe(turn2);
    expect(turn1).toBeTruthy();
  });

  it('does NOT vary with the system message when tools are present', () => {
    // The system message re-renders per turn (resource pills, ${var:}); folding it
    // into the key would make the key unstable and defeat cache routing.
    const tools = [tool('a')];
    expect(keyFor([sys('S1')], tools)).toBe(keyFor([sys('S2')], tools));
  });

  it('is shared by two conversations running the same tool block', () => {
    // This is the point of keying on the prefix rather than on conversationId:
    // separate conversations of the same flow step should land on one warm shard.
    const tools = [tool('a')];
    expect(keyFor([sys('conv A system')], tools)).toBe(keyFor([sys('conv B system')], tools));
  });

  it('differs when the tool block differs', () => {
    expect(keyFor([sys('S')], [tool('a')])).not.toBe(keyFor([sys('S')], [tool('a'), tool('b')]));
  });

  it('falls back to the system hash when there are no tools', () => {
    const key = keyFor([sys('S')], undefined);
    expect(key).toMatch(/^flujo-s/);
  });

  it('is undefined when there is no cacheable prefix at all', () => {
    expect(keyFor([user('hi')], undefined)).toBeUndefined();
  });
});
