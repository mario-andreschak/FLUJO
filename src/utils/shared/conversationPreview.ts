/**
 * Latest-displayable-message extraction for the chain-chat projection (#405).
 *
 * "Displayable" is deliberately narrow: the most recent USER or ASSISTANT
 * message that carries visible text. System prompts, tool results and
 * assistant turns that only carry tool calls are skipped, as are disabled
 * (reverted) messages. The result is whitespace-collapsed plain text bounded
 * to a character cap, so a preview can never leak a whole conversation.
 *
 * Pure and dependency-free: shared by the API route and unit-testable alone.
 */

import type { ConversationChainMessagePreview } from '@/shared/types/conversationChain';
import { CHAIN_MESSAGE_PREVIEW_MAX_CHARS } from '@/shared/types/conversationChain';

/** Text-bearing part types of the OpenAI multimodal content array. */
const TEXT_PART_TYPES = new Set(['text', 'input_text', 'output_text']);

/**
 * Flatten OpenAI-compatible message content (string or multimodal array) into
 * plain text. Image/audio/file parts contribute nothing.
 */
export function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    const candidate = part as { type?: unknown; text?: unknown };
    if (typeof candidate.text !== 'string') continue;
    if (candidate.type !== undefined && typeof candidate.type === 'string' && !TEXT_PART_TYPES.has(candidate.type)) {
      continue;
    }
    parts.push(candidate.text);
  }
  return parts.join(' ').trim();
}

/**
 * Return the newest user/assistant message with visible text, bounded to
 * `maxChars`. Returns null for empty, missing, malformed, system-only or
 * tool-only histories — callers render a neutral fallback instead.
 */
export function extractLatestDisplayableMessage(
  messages: unknown,
  maxChars: number = CHAIN_MESSAGE_PREVIEW_MAX_CHARS
): ConversationChainMessagePreview | null {
  if (!Array.isArray(messages)) return null;

  const limit = Math.max(1, Math.trunc(maxChars) || CHAIN_MESSAGE_PREVIEW_MAX_CHARS);

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as
      | { role?: unknown; content?: unknown; timestamp?: unknown; disabled?: unknown }
      | null
      | undefined;
    if (!message || typeof message !== 'object') continue;
    if (message.disabled === true) continue;

    const role = message.role;
    if (role !== 'user' && role !== 'assistant') continue;

    const collapsed = extractMessageText(message.content).replace(/\s+/g, ' ').trim();
    if (!collapsed) continue;

    const truncated = collapsed.length > limit;
    return {
      role,
      text: truncated ? `${collapsed.slice(0, limit)}…` : collapsed,
      timestamp:
        typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
          ? message.timestamp
          : 0,
      truncated,
    };
  }

  return null;
}
