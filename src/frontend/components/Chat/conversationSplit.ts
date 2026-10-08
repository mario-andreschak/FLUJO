import type { ChatMessage } from './index';

/** Which side of a message-level split is carried into the new conversation. */
export type SplitHalf = 'head' | 'tail';

/**
 * Build the "start -> picked message" half of a split (inclusive).
 *
 * This is the original split behaviour, kept as a function so both directions
 * live side by side.
 */
export function buildHeadSplitMessages(
  messages: ChatMessage[],
  endIndex: number,
): ChatMessage[] {
  return messages.slice(0, endIndex + 1);
}

/**
 * Build the "picked message -> end" half of a split.
 *
 * A tail slice starts in the middle of a thread, so two things need care that
 * the head slice gets for free:
 *  - System messages from the dropped head are carried over, so the new
 *    conversation keeps the standing instructions it was produced under.
 *  - A `tool` message whose parent assistant `tool_calls` entry stayed behind
 *    in the head is an orphan. Providers reject a tool result that answers no
 *    visible call, so those are dropped instead of poisoning the first run.
 */
export function buildTailSplitMessages(
  messages: ChatMessage[],
  startIndex: number,
): ChatMessage[] {
  const carriedSystem = messages.slice(0, startIndex).filter(msg => msg.role === 'system');

  const availableToolCallIds = new Set<string>();
  const kept: ChatMessage[] = [];
  for (const msg of messages.slice(startIndex)) {
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        if (call?.id) availableToolCallIds.add(call.id);
      }
    }
    if (msg.role === 'tool' && msg.tool_call_id && !availableToolCallIds.has(msg.tool_call_id)) {
      continue;
    }
    kept.push(msg);
  }

  return [...carriedSystem, ...kept];
}

/** Slice the half of `messages` a split at `index` should keep. */
export function buildSplitMessages(
  messages: ChatMessage[],
  index: number,
  half: SplitHalf,
): ChatMessage[] {
  return half === 'head'
    ? buildHeadSplitMessages(messages, index)
    : buildTailSplitMessages(messages, index);
}
