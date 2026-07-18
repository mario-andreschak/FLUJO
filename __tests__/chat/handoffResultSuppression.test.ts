/**
 * Unit tests for collectHandoffToolCallIds (issue #134, item 5).
 *
 * A handoff renders as a slim "Handoff → Target" chip on the assistant call; its
 * `role:'tool'` result must never appear as its own bubble. The renderer used to
 * suppress the result ONLY when the body was the exact `{handoff:true}` blob, so
 * a result with extra fields, a non-JSON payload, or a plain string slipped
 * through and cluttered the transcript. Matching by the paired handoff tool
 * call's id suppresses the result regardless of its body shape. These tests lock
 * in which ids are collected (and which are NOT).
 */

import { collectHandoffToolCallIds } from '@/frontend/components/Chat/toolCallPairing';
import type { FlujoChatMessage } from '@/shared/types/chat';
import { HANDOFF_TOOL_PREFIX } from '@/shared/utils/handoffNaming';

let seq = 0;
const nextId = () => `msg-${++seq}`;

function assistantWithToolCalls(
  calls: { id: string; name: string }[]
): FlujoChatMessage {
  return {
    id: nextId(),
    timestamp: Date.now(),
    role: 'assistant',
    content: null,
    tool_calls: calls.map((c) => ({
      id: c.id,
      type: 'function' as const,
      function: { name: c.name, arguments: '{}' },
    })),
  } as FlujoChatMessage;
}

describe('collectHandoffToolCallIds', () => {
  beforeEach(() => {
    seq = 0;
  });

  it('returns an empty set for empty / non-array input', () => {
    expect(collectHandoffToolCallIds([]).size).toBe(0);
    // @ts-expect-error deliberately passing a bad value to exercise the guard
    expect(collectHandoffToolCallIds(undefined).size).toBe(0);
  });

  it('collects ids of prefixed and bare handoff tool calls only', () => {
    const messages = [
      assistantWithToolCalls([
        { id: 'call_handoff', name: `${HANDOFF_TOOL_PREFIX}finish_node` },
        { id: 'call_bare', name: 'handoff' },
        { id: 'call_search', name: 'search' },
      ]),
    ];
    const ids = collectHandoffToolCallIds(messages);
    expect(ids.has('call_handoff')).toBe(true);
    expect(ids.has('call_bare')).toBe(true);
    // A regular tool call is NOT a handoff and must keep its result bubble.
    expect(ids.has('call_search')).toBe(false);
    expect(ids.size).toBe(2);
  });

  it('captures handoff ids across multiple assistant messages', () => {
    const messages = [
      assistantWithToolCalls([{ id: 'h1', name: `${HANDOFF_TOOL_PREFIX}a` }]),
      assistantWithToolCalls([{ id: 't1', name: 'read_file' }]),
      assistantWithToolCalls([{ id: 'h2', name: `${HANDOFF_TOOL_PREFIX}b` }]),
    ];
    const ids = collectHandoffToolCallIds(messages);
    expect([...ids].sort()).toEqual(['h1', 'h2']);
  });
});
