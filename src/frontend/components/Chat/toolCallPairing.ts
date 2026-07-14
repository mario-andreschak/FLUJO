/**
 * Pure pairing of assistant tool calls with their matching tool-result messages
 * (issue #95). The chat wire/persistence model keeps an assistant turn's
 * `tool_calls[]` in one message and each result as a separate `role: 'tool'`
 * message keyed by `tool_call_id`. To render the two as a single expandable
 * timeline unit, the UI needs, per assistant message, the ordered list of its
 * (non-handoff) tool calls paired with the result that answered each one.
 *
 * This module is intentionally free of React/MUI so it can be unit-tested in
 * the node-env Jest harness and so `ChatMessages` can memoize one pairing pass
 * per `messages` change instead of recomputing inside every memoized bubble.
 *
 * Handoff tool calls (`handoff_to_*`) are excluded here — they keep their slim
 * "Handoff → Target" marker rendering and their `{handoff:true}` result blob is
 * suppressed elsewhere.
 */

import type OpenAI from 'openai';
import type { FlujoChatMessage } from '@/shared/types/chat';
import { HANDOFF_TOOL_PREFIX } from '@/shared/utils/handoffNaming';

/** A single assistant tool call paired with the tool result that answered it (if any yet). */
export interface ToolCallPair<TMessage extends FlujoChatMessage = FlujoChatMessage> {
  toolCall: OpenAI.ChatCompletionMessageToolCall;
  /** The matching `role: 'tool'` message, or undefined while the result is still pending. */
  result?: TMessage;
}

export interface ToolCallPairing<TMessage extends FlujoChatMessage = FlujoChatMessage> {
  /** For each assistant message id, its ordered non-handoff tool-call/result pairs. */
  pairsByMessageId: Map<string, ToolCallPair<TMessage>[]>;
  /**
   * `tool_call_id`s that belong to an assistant call rendered as a timeline in
   * this pass. Their standalone `role: 'tool'` bubbles must be skipped by the
   * list loop (the result is shown inside the timeline instead). A tool result
   * whose id is NOT in this set is an orphan (parent call outside the render
   * window / missing) and keeps its legacy standalone bubble.
   */
  consumedToolCallIds: Set<string>;
}

/** True when a tool function name is a handoff (matches the runtime prefix). */
function isHandoffToolName(name?: string): boolean {
  return !!name && (name.startsWith(HANDOFF_TOOL_PREFIX) || name === 'handoff');
}

/**
 * Pair every assistant message's non-handoff tool calls with their result
 * messages, matched by `tool_call_id`.
 *
 * - Pairing is order-independent: results that stream in later (or arrive out
 *   of order) are picked up on the next call because the whole `messages` array
 *   is re-scanned.
 * - A tool call with no result yet yields `{ toolCall, result: undefined }`
 *   (rendered as "pending").
 * - Every non-handoff tool call that has an id is added to
 *   `consumedToolCallIds` regardless of whether its result has arrived, so the
 *   result bubble is suppressed the moment it appears.
 */
export function pairToolCallsWithResults<TMessage extends FlujoChatMessage>(
  messages: TMessage[]
): ToolCallPairing<TMessage> {
  const pairsByMessageId = new Map<string, ToolCallPair<TMessage>[]>();
  const consumedToolCallIds = new Set<string>();

  if (!Array.isArray(messages)) {
    return { pairsByMessageId, consumedToolCallIds };
  }

  // 1. Index tool results by their tool_call_id (first result wins on the rare
  //    chance of a duplicate id).
  const resultByToolCallId = new Map<string, TMessage>();
  for (const message of messages) {
    if (
      message.role === 'tool' &&
      typeof message.tool_call_id === 'string' &&
      message.tool_call_id &&
      !resultByToolCallId.has(message.tool_call_id)
    ) {
      resultByToolCallId.set(message.tool_call_id, message);
    }
  }

  // 2. Build the per-assistant-message pairs.
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const toolCalls = message.tool_calls;
    if (!Array.isArray(toolCalls)) continue;

    const pairs: ToolCallPair<TMessage>[] = [];
    for (const toolCall of toolCalls) {
      // Only function tool calls carry a `.function.name`; skip handoffs.
      if (toolCall.type !== 'function' || isHandoffToolName(toolCall.function?.name)) {
        continue;
      }
      const id = toolCall.id;
      const result = id ? resultByToolCallId.get(id) : undefined;
      if (id) consumedToolCallIds.add(id);
      pairs.push({ toolCall, result });
    }

    if (pairs.length > 0) {
      pairsByMessageId.set(message.id, pairs);
    }
  }

  return { pairsByMessageId, consumedToolCallIds };
}
