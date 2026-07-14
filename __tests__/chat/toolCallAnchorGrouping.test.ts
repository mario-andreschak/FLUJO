/**
 * Unit tests for groupToolCallsByAnchor (issue #95 follow-up).
 *
 * The first pass merged each tool call + its result into a per-message timeline,
 * which works for the single-message shape (narration and `tool_calls` in one
 * assistant message). But the Claude-subscription adapter records a tool-using
 * turn as SEPARATE messages: a narration message, then one `content: ''`
 * assistant message per tool call (each followed by its result). That made every
 * call render as its own standalone bubble.
 *
 * `groupToolCallsByAnchor` regroups those calls onto the run's narration anchor
 * so they render as one combined timeline. These tests lock in the grouping
 * behaviour the renderer relies on: hoisting onto narration, tools-first
 * anchoring, the untouched single-message path, run boundaries, handoff
 * aggregation, interleaving, and the "meaningful text" detection that decides
 * whether a bubble is suppressed.
 */

import {
  groupToolCallsByAnchor,
  hasMeaningfulTextContent,
} from '@/frontend/components/Chat/toolCallPairing';
import type { FlujoChatMessage } from '@/shared/types/chat';
import { HANDOFF_TOOL_PREFIX } from '@/shared/utils/handoffNaming';

let seq = 0;
const nextId = () => `msg-${++seq}`;

function narration(text: string, overrides: Partial<FlujoChatMessage> = {}): FlujoChatMessage {
  return {
    id: nextId(),
    timestamp: Date.now(),
    role: 'assistant',
    content: text,
    ...overrides,
  } as FlujoChatMessage;
}

function assistantToolMessage(
  calls: { id: string; name: string; args?: string }[],
  content: string | null = '',
  overrides: Partial<FlujoChatMessage> = {}
): FlujoChatMessage {
  return {
    id: nextId(),
    timestamp: Date.now(),
    role: 'assistant',
    content,
    tool_calls: calls.map((c) => ({
      id: c.id,
      type: 'function' as const,
      function: { name: c.name, arguments: c.args ?? '{}' },
    })),
    ...overrides,
  } as FlujoChatMessage;
}

function toolResult(toolCallId: string, content = '{"ok":true}'): FlujoChatMessage {
  return {
    id: nextId(),
    timestamp: Date.now(),
    role: 'tool',
    tool_call_id: toolCallId,
    content,
  } as FlujoChatMessage;
}

function userMessage(text = 'hi'): FlujoChatMessage {
  return { id: nextId(), timestamp: Date.now(), role: 'user', content: text } as FlujoChatMessage;
}

describe('hasMeaningfulTextContent', () => {
  it('treats a non-empty string as narration and empty/whitespace/null as not', () => {
    expect(hasMeaningfulTextContent(narration('hello'))).toBe(true);
    expect(hasMeaningfulTextContent(narration(''))).toBe(false);
    expect(hasMeaningfulTextContent(narration('   \n\t '))).toBe(false);
    expect(hasMeaningfulTextContent(narration(null as unknown as string))).toBe(false);
  });

  it('detects a non-empty text part or an image part in array content', () => {
    const withText = narration('', { content: [{ type: 'text', text: 'hi' }] as unknown as string });
    const withImage = narration('', {
      content: [{ type: 'image_url', image_url: { url: 'data:...' } }] as unknown as string,
    });
    const emptyParts = narration('', { content: [{ type: 'text', text: '  ' }] as unknown as string });
    expect(hasMeaningfulTextContent(withText)).toBe(true);
    expect(hasMeaningfulTextContent(withImage)).toBe(true);
    expect(hasMeaningfulTextContent(emptyParts)).toBe(false);
  });
});

describe('groupToolCallsByAnchor', () => {
  beforeEach(() => {
    seq = 0;
  });

  it('returns empty structures for a non-array / empty input', () => {
    const empty = groupToolCallsByAnchor([]);
    expect(empty.groups).toHaveLength(0);
    expect(empty.hoistedAssistantIds.size).toBe(0);
    // @ts-expect-error deliberately passing a bad value to exercise the guard
    const bad = groupToolCallsByAnchor(undefined);
    expect(bad.groups).toHaveLength(0);
    expect(bad.consumedToolCallIds.size).toBe(0);
  });

  it('hoists N following empty tool-call messages onto the narration anchor', () => {
    const anchor = narration('Let me look that up.');
    const call1 = assistantToolMessage([{ id: 'c1', name: 'search' }]);
    const res1 = toolResult('c1');
    const call2 = assistantToolMessage([{ id: 'c2', name: 'read' }]);
    const res2 = toolResult('c2');

    const g = groupToolCallsByAnchor([anchor, call1, res1, call2, res2]);

    const pairs = g.pairsByAnchorId.get(anchor.id)!;
    expect(pairs.map((p) => p.toolCall.id)).toEqual(['c1', 'c2']);
    expect(pairs[0].result).toBe(res1);
    expect(pairs[1].result).toBe(res2);
    // Both empty tool-call messages are suppressed.
    expect(g.hoistedAssistantIds.has(call1.id)).toBe(true);
    expect(g.hoistedAssistantIds.has(call2.id)).toBe(true);
    expect(g.hoistedAssistantIds.has(anchor.id)).toBe(false);
    // Result bubbles consumed.
    expect(g.consumedToolCallIds).toEqual(new Set(['c1', 'c2']));
    // One group whose members are anchor + both hoisted messages, in order.
    expect(g.groups).toHaveLength(1);
    expect(g.groups[0].anchorId).toBe(anchor.id);
    expect(g.groups[0].memberIds).toEqual([anchor.id, call1.id, call2.id]);
    expect(g.groups[0].hoistedIds).toEqual([call1.id, call2.id]);
  });

  it('anchors on the first tool-call message when the run has no narration (tools-first)', () => {
    const call1 = assistantToolMessage([{ id: 'c1', name: 'search' }]);
    const res1 = toolResult('c1');
    const call2 = assistantToolMessage([{ id: 'c2', name: 'read' }]);
    const res2 = toolResult('c2');

    const g = groupToolCallsByAnchor([call1, res1, call2, res2]);

    // First tool-call message becomes the anchor and hosts both calls.
    expect(g.pairsByAnchorId.get(call1.id)!.map((p) => p.toolCall.id)).toEqual(['c1', 'c2']);
    // The anchor itself is NOT hoisted (keeps its bubble); only the later one is.
    expect(g.hoistedAssistantIds.has(call1.id)).toBe(false);
    expect(g.hoistedAssistantIds.has(call2.id)).toBe(true);
    expect(g.groups[0].anchorId).toBe(call1.id);
    expect(g.groups[0].memberIds).toEqual([call1.id, call2.id]);
  });

  it('leaves the single-message shape (text + tool_calls together) untouched', () => {
    const combined = assistantToolMessage([{ id: 'c1', name: 'search' }], 'Working on it.');
    const res1 = toolResult('c1');

    const g = groupToolCallsByAnchor([combined, res1]);

    expect(g.pairsByAnchorId.get(combined.id)!.map((p) => p.toolCall.id)).toEqual(['c1']);
    // Its own bubble is never suppressed.
    expect(g.hoistedAssistantIds.size).toBe(0);
    expect(g.groups[0].memberIds).toEqual([combined.id]);
    expect(g.groups[0].hoistedIds).toEqual([]);
  });

  it('starts a fresh anchor group after a user message boundary', () => {
    const anchorA = narration('First answer.');
    const callA = assistantToolMessage([{ id: 'ca', name: 'tool_a' }]);
    const resA = toolResult('ca');
    const user = userMessage('now do this');
    const anchorB = narration('Second answer.');
    const callB = assistantToolMessage([{ id: 'cb', name: 'tool_b' }]);
    const resB = toolResult('cb');

    const g = groupToolCallsByAnchor([anchorA, callA, resA, user, anchorB, callB, resB]);

    expect(g.groups).toHaveLength(2);
    expect(g.pairsByAnchorId.get(anchorA.id)!.map((p) => p.toolCall.id)).toEqual(['ca']);
    expect(g.pairsByAnchorId.get(anchorB.id)!.map((p) => p.toolCall.id)).toEqual(['cb']);
    // The second run's call did NOT hoist onto the first run's anchor.
    expect(g.pairsByAnchorId.get(anchorA.id)!.map((p) => p.toolCall.id)).not.toContain('cb');
  });

  it('partitions interleaved narration/tool/narration/tool into two anchors', () => {
    const n1 = narration('Step one.');
    const c1 = assistantToolMessage([{ id: 'c1', name: 't1' }]);
    const r1 = toolResult('c1');
    const n2 = narration('Step two.');
    const c2 = assistantToolMessage([{ id: 'c2', name: 't2' }]);
    const r2 = toolResult('c2');

    const g = groupToolCallsByAnchor([n1, c1, r1, n2, c2, r2]);

    expect(g.groups.map((gr) => gr.anchorId)).toEqual([n1.id, n2.id]);
    expect(g.pairsByAnchorId.get(n1.id)!.map((p) => p.toolCall.id)).toEqual(['c1']);
    expect(g.pairsByAnchorId.get(n2.id)!.map((p) => p.toolCall.id)).toEqual(['c2']);
  });

  it('hoists handoff markers onto the anchor and does not consume their ids', () => {
    const anchor = narration('Routing you along.');
    const handoff = assistantToolMessage([
      { id: 'h1', name: `${HANDOFF_TOOL_PREFIX}finish_node` },
    ]);

    const g = groupToolCallsByAnchor([anchor, handoff]);

    const handoffs = g.handoffsByAnchorId.get(anchor.id)!;
    expect(handoffs.map((tc) => tc.id)).toEqual(['h1']);
    // Handoff-only message with no narration is suppressed (its marker moved up).
    expect(g.hoistedAssistantIds.has(handoff.id)).toBe(true);
    // Handoff ids are never consumed (their {handoff:true} result is suppressed elsewhere).
    expect(g.consumedToolCallIds.has('h1')).toBe(false);
    // No non-handoff pairs on the anchor.
    expect(g.pairsByAnchorId.get(anchor.id)).toEqual([]);
  });

  it('keeps a handoff+call mix on the same anchor and only consumes the real call', () => {
    const anchor = narration('Doing a thing then handing off.');
    const call = assistantToolMessage([{ id: 'c1', name: 'search' }]);
    const res = toolResult('c1');
    const handoff = assistantToolMessage([{ id: 'h1', name: `${HANDOFF_TOOL_PREFIX}next` }]);

    const g = groupToolCallsByAnchor([anchor, call, res, handoff]);

    expect(g.pairsByAnchorId.get(anchor.id)!.map((p) => p.toolCall.id)).toEqual(['c1']);
    expect(g.handoffsByAnchorId.get(anchor.id)!.map((tc) => tc.id)).toEqual(['h1']);
    expect(g.consumedToolCallIds).toEqual(new Set(['c1']));
    expect(g.groups[0].hoistedIds).toEqual([call.id, handoff.id]);
  });

  it('leaves a truly empty assistant bubble (no text, no tools) untouched', () => {
    const anchor = narration('Answer.');
    const emptyBubble = narration(''); // content '' and no tool_calls
    const g = groupToolCallsByAnchor([anchor, emptyBubble]);
    // No tool content anywhere → no groups and nothing suppressed.
    expect(g.groups).toHaveLength(0);
    expect(g.hoistedAssistantIds.size).toBe(0);
  });

  it('records pending (unanswered) hoisted calls with an undefined result', () => {
    const anchor = narration('Calling a slow tool.');
    const call = assistantToolMessage([{ id: 'c1', name: 'slow' }]); // no result yet
    const g = groupToolCallsByAnchor([anchor, call]);
    const pairs = g.pairsByAnchorId.get(anchor.id)!;
    expect(pairs).toHaveLength(1);
    expect(pairs[0].result).toBeUndefined();
    expect(g.consumedToolCallIds.has('c1')).toBe(true);
  });
});
