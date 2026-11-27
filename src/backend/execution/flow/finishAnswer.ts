import type OpenAI from 'openai';
import type { FlujoChatMessage } from '@/shared/types/chat';

/**
 * A model can hand off to Finish without writing any answer: its last turn
 * holds only reasoning and the hand-off call (#1419). The run would then
 * return an empty reply although the reasoning tokens were counted, which
 * looks exactly like a lost answer. The run loop takes, in this order:
 *
 *  1. text the model put into the hand-off call's arguments,
 *  2. one more model request on the same step, without its tools and with
 *     `FINISH_ANSWER_INSTRUCTION` as the last message the model sees (only
 *     `read_resource` stays when the conversation points at a saved result,
 *     so the answer can still use it; the turn limit bounds those rounds),
 *  3. `NO_ANSWER_TEXT` as the reply, with the step's empty message marked
 *     `noAnswer` so the chat shows a note instead of nothing.
 *
 * It applies to every provider, as it sits in the shared hand-off path.
 */
export const FINISH_ANSWER_INSTRUCTION =
  'FLUJO NOTICE: you handed off to Finish without writing an answer, and the person only sees text you write. '
  + 'Write your final answer to them now, as plain text. Do not call any tool.';

/** The reply when the model still wrote nothing after that one extra request. */
export const NO_ANSWER_TEXT = 'The model finished without writing an answer. Please ask again.';

/** Argument names a model uses when it puts its answer into a hand-off call. */
const ANSWER_ARGUMENTS = ['answer', 'final_answer', 'response', 'reply', 'message', 'text', 'content', 'output', 'result', 'summary', 'prompt'];

function hasText(content: FlujoChatMessage['content'] | undefined): boolean {
  if (typeof content === 'string') return content.trim().length > 0;
  return Array.isArray(content) && content.some(part =>
    part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' && part.text.trim().length > 0);
}

/** The answer text the model passed as an argument of its hand-off call, if it did. */
export function answerFromHandoffArguments(
  calls: readonly OpenAI.ChatCompletionMessageFunctionToolCall[],
): string | undefined {
  for (const call of calls) {
    let args: unknown;
    try { args = JSON.parse(call.function.arguments || '{}'); } catch { continue; }
    if (!args || typeof args !== 'object' || Array.isArray(args)) continue;
    for (const name of ANSWER_ARGUMENTS) {
      const value = (args as Record<string, unknown>)[name];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return undefined;
}

/**
 * True when nothing the run would return answers the person: the reply text
 * is empty, the hand-off turn has no text, and no model message since the
 * person's latest message carries media.
 */
export function lacksFinishAnswer(
  reply: unknown,
  handoffTurn: FlujoChatMessage | undefined,
  messages: readonly FlujoChatMessage[],
): boolean {
  if (typeof reply === 'string' ? reply.trim() : reply != null) return false;
  if (hasText(handoffTurn?.content)) return false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.depth) continue;
    if (message.role === 'user') break;
    if (message.role === 'assistant' && message.media?.length) return false;
  }
  return true;
}

/** Marks the step's latest empty model message, so the chat explains why there is no answer. */
export function markNoAnswer(messages: readonly FlujoChatMessage[], nodeId: string | undefined): void {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.depth) continue;
    if (message.role === 'user') return;
    if (message.role !== 'assistant' || message.processNodeId !== nodeId) continue;
    if (!hasText(message.content) && !message.tool_calls?.length) message.noAnswer = true;
    return;
  }
}

/** True when the person's latest turn ended without an answer (see `markNoAnswer`). */
export function latestTurnHasNoAnswer(messages: readonly FlujoChatMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.depth) continue;
    if (message.role === 'user') return false;
    if (message.role === 'assistant' && message.noAnswer) return true;
  }
  return false;
}
