import type OpenAI from 'openai';
import type { Model } from '@/shared/types/model';
import { isOfficialOpenAiChatCompletion } from './openaiPromptCaching';

type WireMessage = OpenAI.ChatCompletionMessageParam;

const isInstruction = (message: WireMessage) => message.role === 'system' || message.role === 'developer';

function textParts(content: unknown): OpenAI.ChatCompletionContentPartText[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return Array.isArray(content) ? content as OpenAI.ChatCompletionContentPartText[] : [];
}

function oneSystemMessage(instructions: WireMessage[]): WireMessage {
  const contents = instructions.map(message => (message as { content?: unknown }).content);
  if (contents.every(content => typeof content === 'string')) {
    return { role: 'system', content: (contents as string[]).filter(Boolean).join('\n\n') };
  }
  return { role: 'system', content: contents.flatMap(textParts) };
}

const asUser = (message: WireMessage): WireMessage => ({ ...message, role: 'user' } as WireMessage);

/**
 * The messages in the shape every chat template accepts (issue #1367).
 * Servers that run the model's own template, such as vLLM, llama.cpp and
 * LM Studio serving Qwen 3.5, refuse a system message anywhere but first
 * ("System message must be at the beginning.") and a request without a user
 * turn ("No user query found in messages."). FLUJO writes such messages for
 * compaction and for runs started without input, so:
 *
 *  1. The system messages before the conversation become one system message.
 *  2. A later system message becomes a user message in the same place.
 *  3. A request with no user message sends its instructions as the user turn.
 *
 * Everything else, including the text and order of every message, is kept.
 */
export function toChatTemplateWire(messages: WireMessage[]): WireMessage[] {
  let leading = 0;
  while (leading < messages.length && isInstruction(messages[leading])) leading++;
  const later = messages.slice(leading);
  const reshaped = leading > 1 || messages[0]?.role === 'developer' || later.some(isInstruction)
    || (messages.length > 0 && !messages.some(message => message.role === 'user'));
  if (!reshaped) return messages;

  const head = leading > 0 ? [oneSystemMessage(messages.slice(0, leading))] : [];
  const wire = [...head, ...later.map(message => isInstruction(message) ? asUser(message) : message)];
  if (!wire.some(message => message.role === 'user') && head.length > 0) wire[0] = asUser(wire[0]);
  return wire;
}

/** OpenAI's own servers get the messages as written; every other Chat Completions server gets them in template order. */
export function chatTemplateWireFor(
  model: Pick<Model, 'provider' | 'adapter' | 'name' | 'baseUrl'>,
  messages: WireMessage[],
): WireMessage[] {
  return isOfficialOpenAiChatCompletion(model) ? messages : toChatTemplateWire(messages);
}
