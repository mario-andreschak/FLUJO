/**
 * Unit tests for pairToolCallsWithResults (issue #95).
 *
 * The chat UI pairs each assistant `tool_call` with its `role: 'tool'` result
 * by `tool_call_id` at render time so the two can be shown as one expandable
 * timeline unit. This pure helper is the pairing brain; these tests lock in the
 * behaviour the renderer relies on: correct pairing, pending (unanswered) calls,
 * out-of-order results, handoff exclusion, and orphan-result detection.
 */

import { pairToolCallsWithResults } from '@/frontend/components/Chat/toolCallPairing';
import type { FlujoChatMessage } from '@/shared/types/chat';
import { HANDOFF_TOOL_PREFIX } from '@/shared/utils/handoffNaming';

let seq = 0;
const nextId = () => `msg-${++seq}`;

function assistantWithToolCalls(
  calls: { id: string; name: string; args?: string }[],
  overrides: Partial<FlujoChatMessage> = {}
): FlujoChatMessage {
  return {
    id: nextId(),
    timestamp: Date.now(),
    role: 'assistant',
    content: null,
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

describe('pairToolCallsWithResults', () => {
  beforeEach(() => {
    seq = 0;
  });

  it('returns empty structures for a non-array / empty input', () => {
    expect(pairToolCallsWithResults([]).pairsByMessageId.size).toBe(0);
    // @ts-expect-error deliberately passing a bad value to exercise the guard
    const bad = pairToolCallsWithResults(undefined);
    expect(bad.pairsByMessageId.size).toBe(0);
    expect(bad.consumedToolCallIds.size).toBe(0);
  });

  it('pairs a single tool call with its result and marks the id consumed', () => {
    const assistant = assistantWithToolCalls([{ id: 'call_1', name: 'search' }]);
    const result = toolResult('call_1', '{"hits":3}');
    const messages = [assistant, result];

    const { pairsByMessageId, consumedToolCallIds } = pairToolCallsWithResults(messages);

    const pairs = pairsByMessageId.get(assistant.id);
    expect(pairs).toHaveLength(1);
    expect(pairs![0].toolCall.id).toBe('call_1');
    expect(pairs![0].result).toBe(result);
    expect(consumedToolCallIds.has('call_1')).toBe(true);
  });

  it('handles multiple tool calls in one assistant turn', () => {
    const assistant = assistantWithToolCalls([
      { id: 'call_a', name: 'read' },
      { id: 'call_b', name: 'write' },
    ]);
    const resA = toolResult('call_a');
    const resB = toolResult('call_b');

    const { pairsByMessageId, consumedToolCallIds } = pairToolCallsWithResults([
      assistant,
      resA,
      resB,
    ]);

    const pairs = pairsByMessageId.get(assistant.id)!;
    expect(pairs.map((p) => p.toolCall.id)).toEqual(['call_a', 'call_b']);
    expect(pairs[0].result).toBe(resA);
    expect(pairs[1].result).toBe(resB);
    expect(consumedToolCallIds).toEqual(new Set(['call_a', 'call_b']));
  });

  it('leaves a pending (unanswered) call with an undefined result but still consumes its id', () => {
    const assistant = assistantWithToolCalls([{ id: 'call_pending', name: 'slow_tool' }]);

    const { pairsByMessageId, consumedToolCallIds } = pairToolCallsWithResults([assistant]);

    const pairs = pairsByMessageId.get(assistant.id)!;
    expect(pairs).toHaveLength(1);
    expect(pairs[0].result).toBeUndefined();
    // Consumed even while pending so the standalone bubble is suppressed the
    // instant the result streams in.
    expect(consumedToolCallIds.has('call_pending')).toBe(true);
  });

  it('pairs results that appear out of order (result listed before the call)', () => {
    const assistant = assistantWithToolCalls([{ id: 'call_x', name: 'tool_x' }]);
    const result = toolResult('call_x');
    // Result physically precedes the assistant message in the array.
    const { pairsByMessageId } = pairToolCallsWithResults([result, assistant]);

    expect(pairsByMessageId.get(assistant.id)![0].result).toBe(result);
  });

  it('excludes handoff tool calls from the timeline pairs and does not consume their ids', () => {
    const assistant = assistantWithToolCalls([
      { id: 'call_real', name: 'search' },
      { id: 'call_handoff', name: `${HANDOFF_TOOL_PREFIX}finish_node` },
    ]);
    const realResult = toolResult('call_real');

    const { pairsByMessageId, consumedToolCallIds } = pairToolCallsWithResults([
      assistant,
      realResult,
    ]);

    const pairs = pairsByMessageId.get(assistant.id)!;
    expect(pairs).toHaveLength(1);
    expect(pairs[0].toolCall.id).toBe('call_real');
    expect(consumedToolCallIds.has('call_handoff')).toBe(false);
  });

  it('does not create a pairs entry for an assistant message with only handoff calls', () => {
    const assistant = assistantWithToolCalls([
      { id: 'call_handoff', name: `${HANDOFF_TOOL_PREFIX}next` },
    ]);

    const { pairsByMessageId } = pairToolCallsWithResults([assistant]);
    expect(pairsByMessageId.has(assistant.id)).toBe(false);
  });

  it('leaves an orphan tool result (no matching call in the window) unconsumed', () => {
    const orphan = toolResult('call_missing');

    const { consumedToolCallIds } = pairToolCallsWithResults([orphan]);
    // Not consumed => the list loop keeps rendering it as the legacy bubble.
    expect(consumedToolCallIds.has('call_missing')).toBe(false);
  });
});
