import type OpenAI from 'openai';
import { compactForWire, couldCompact, wireHasRunResourceUri } from '@/backend/execution/flow/handlers/compactForWire';
import type { ToolResourceMarker } from '@/backend/services/model/adapters/types';
import type { RunResourceEntry } from '@/shared/types/runResources';

jest.mock('@/utils/logger', () => {
  const log = { verbose: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { createLogger: () => log };
});

type Msg = OpenAI.ChatCompletionMessageParam;

/** A markers map whose tool_call_id -> captured result URI, matching #168 shape. */
function markersFor(callId: string, uri: string): Map<string, ToolResourceMarker> {
  const entry = { uri } as RunResourceEntry;
  return new Map([[callId, { result: entry }]]);
}

const big = (n: number) => 'x'.repeat(n);

/** An assistant turn that calls one tool, followed by its tool result. */
function toolTurn(callId: string, resultLen: number, prose = ''): Msg[] {
  return [
    {
      role: 'assistant',
      content: prose,
      tool_calls: [
        { id: callId, type: 'function', function: { name: 'download', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: callId, content: big(resultLen) },
  ];
}

describe('compactForWire', () => {
  it('returns the input untouched when nothing is old enough to compact', () => {
    const msgs: Msg[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      ...toolTurn('c1', 50_000),
    ];
    expect(couldCompact(msgs, { keepRecentMessages: 12 })).toBe(false);
    expect(compactForWire(msgs, { keepRecentMessages: 12 })).toBe(msgs); // identity, no copy
  });

  it('recoverably truncates an oversized OLD tool result when a resource marker exists', () => {
    const uri = 'flujo://run/conv-1/res-abc';
    const msgs: Msg[] = [
      ...toolTurn('c1', 50_000), // old, captured
      { role: 'user', content: 'next' },
      ...toolTurn('c2', 50_000), // recent
    ];
    const out = compactForWire(msgs, {
      keepRecentMessages: 3,
      toolResultHeadChars: 2000,
      resourceMarkers: markersFor('c1', uri),
    });

    const oldTool = out[1] as OpenAI.ChatCompletionToolMessageParam;
    expect(typeof oldTool.content).toBe('string');
    expect((oldTool.content as string).length).toBeLessThan(2200);
    expect(oldTool.content).toContain(uri);
    expect(oldTool.content).toContain('read_resource');
    expect(wireHasRunResourceUri(out)).toBe(true);

    // The recent tool result is left verbatim.
    const recentTool = out[4] as OpenAI.ChatCompletionToolMessageParam;
    expect((recentTool.content as string).length).toBe(50_000);
  });

  it('leaves an oversized OLD tool result INLINE when no marker backs it (no silent loss)', () => {
    const msgs: Msg[] = [
      ...toolTurn('c1', 50_000), // old, NOT captured
      { role: 'user', content: 'next' },
      ...toolTurn('c2', 50_000), // recent
    ];
    const out = compactForWire(msgs, { keepRecentMessages: 3, toolResultHeadChars: 2000 });
    expect(((out[1] as OpenAI.ChatCompletionToolMessageParam).content as string).length).toBe(50_000);
    expect(wireHasRunResourceUri(out)).toBe(false);
  });

  it('lossily truncates without a marker only when allowLossyTruncation is set', () => {
    const msgs: Msg[] = [
      ...toolTurn('c1', 50_000),
      { role: 'user', content: 'next' },
      ...toolTurn('c2', 50_000),
    ];
    const out = compactForWire(msgs, {
      keepRecentMessages: 3,
      toolResultHeadChars: 2000,
      allowLossyTruncation: true,
    });
    const oldTool = out[1] as OpenAI.ChatCompletionToolMessageParam;
    expect((oldTool.content as string).length).toBeLessThan(2200);
    expect(oldTool.content).toContain('truncated 48000 chars');
    expect(wireHasRunResourceUri(out)).toBe(false); // lossy notice carries no URI
  });

  it('never drops, adds, or reorders messages (tool-pair integrity)', () => {
    const msgs: Msg[] = [
      { role: 'system', content: 'sys' },
      ...toolTurn('c1', 50_000, 'thinking...'),
      ...toolTurn('c2', 50_000, 'more thinking'),
      { role: 'user', content: 'go on' },
      ...toolTurn('c3', 50_000, 'final thinking'),
    ];
    const out = compactForWire(msgs, { keepRecentMessages: 3 });

    expect(out).toHaveLength(msgs.length);
    expect(out.map((m) => m.role)).toEqual(msgs.map((m) => m.role));

    // Every assistant tool_calls turn is still followed by a matching tool result.
    for (let i = 0; i < out.length; i++) {
      const m = out[i] as OpenAI.ChatCompletionAssistantMessageParam;
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const result = out
            .slice(i + 1)
            .find((r) => r.role === 'tool' && (r as OpenAI.ChatCompletionToolMessageParam).tool_call_id === tc.id);
          expect(result).toBeDefined();
        }
      }
    }
  });

  it('drops prose from OLD assistant turns that also carry tool_calls, keeping the calls', () => {
    const msgs: Msg[] = [
      ...toolTurn('c1', 10, 'let me download the file first'), // old
      { role: 'user', content: 'thanks' },
      ...toolTurn('c2', 10, 'now the recent one'), // recent
    ];
    const out = compactForWire(msgs, { keepRecentMessages: 3, dropOldAssistantProse: true });

    const oldAssistant = out[0] as OpenAI.ChatCompletionAssistantMessageParam;
    expect(oldAssistant.content).toBe('');
    expect(oldAssistant.tool_calls).toHaveLength(1); // calls survive

    const recentAssistant = out[3] as OpenAI.ChatCompletionAssistantMessageParam;
    expect(recentAssistant.content).toBe('now the recent one'); // untouched
  });

  it('leaves prose-only (no tool_calls) old assistant answers intact', () => {
    const msgs: Msg[] = [
      { role: 'assistant', content: 'Here is my earlier conclusion.' }, // old, no tool_calls
      { role: 'user', content: 'ok' },
      { role: 'user', content: 'and now?' },
      { role: 'user', content: 'still here' },
    ];
    const out = compactForWire(msgs, { keepRecentMessages: 3 });
    expect(out[0].content).toBe('Here is my earlier conclusion.');
  });

  it('respects dropOldAssistantProse: false', () => {
    const msgs: Msg[] = [
      ...toolTurn('c1', 10, 'keep this prose'),
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'user', content: 'c' },
    ];
    const out = compactForWire(msgs, { keepRecentMessages: 3, dropOldAssistantProse: false });
    expect((out[0] as OpenAI.ChatCompletionAssistantMessageParam).content).toBe('keep this prose');
  });

  it('is deterministic across turns for the stable prefix (cache stability)', () => {
    // Turn N: history H. Turn N+1: same H plus one appended user message.
    const base: Msg[] = [
      { role: 'system', content: 'sys' },
      ...toolTurn('c1', 50_000, 'p1'),
      ...toolTurn('c2', 50_000, 'p2'),
      ...toolTurn('c3', 50_000, 'p3'),
    ];
    const turnN = compactForWire(base, { keepRecentMessages: 4 });
    const turnN1 = compactForWire([...base, { role: 'user', content: 'more' }], {
      keepRecentMessages: 4,
    });

    // The compacted prefix that both turns share must be byte-identical so the
    // provider prompt cache stays warm. Compare the region that is "old" in BOTH
    // turns (indices strictly before the recent window of the SHORTER turn).
    const sharedOld = base.length - 4; // old count for turn N
    for (let i = 0; i < sharedOld; i++) {
      expect(JSON.stringify(turnN1[i])).toBe(JSON.stringify(turnN[i]));
    }
  });

  it('mirrors the reported conversation: fat downloads stop riding along', () => {
    // Reproduces cc894ecd…: two large "downloaded file" tool results early in a
    // long tool-calling run, then many more turns. On the wire they should shrink.
    const msgs: Msg[] = [
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: 'Fix the flow folder bug.' },
      ...toolTurn('dl1', 49_838, 'downloading main file'),
      ...toolTurn('dl2', 28_324, 'downloading second file'),
    ];
    // simulate 20 more small tool turns
    for (let i = 0; i < 20; i++) msgs.push(...toolTurn(`t${i}`, 400, `step ${i}`));

    // Both fat downloads were auto-captured (≥ 8192 chars), so markers exist.
    const markers = new Map<string, ToolResourceMarker>([
      ['dl1', { result: { uri: 'flujo://run/cc894ecd/dl1' } as RunResourceEntry }],
      ['dl2', { result: { uri: 'flujo://run/cc894ecd/dl2' } as RunResourceEntry }],
    ]);

    const before = JSON.stringify(msgs).length;
    const out = compactForWire(msgs, {
      keepRecentMessages: 12,
      toolResultHeadChars: 2000,
      resourceMarkers: markers,
    });
    const after = JSON.stringify(out).length;

    // The two fat downloads are old (far outside the recent 12) → truncated,
    // each keeping a dereferenceable URI.
    expect(after).toBeLessThan(before);
    expect(before - after).toBeGreaterThan(70_000); // ~ the two blobs minus heads
    expect(wireHasRunResourceUri(out)).toBe(true);
  });
});
