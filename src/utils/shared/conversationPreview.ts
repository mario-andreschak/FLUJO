/**
 * Latest-displayable-message extraction for the Chain Chat projection.
 *
 * The result is deliberately small: one whitespace-collapsed user, assistant,
 * or tool activity message, bounded to the shared character cap. System
 * plumbing and disabled messages are skipped. Assistant turns that only call
 * tools become compact tool activity so the map never looks idle mid-run.
 */

import type { ConversationChainMessagePreview } from '@/shared/types/conversationChain';
import { CHAIN_MESSAGE_PREVIEW_MAX_CHARS } from '@/shared/types/conversationChain';

const TEXT_PART_TYPES = new Set(['text', 'input_text', 'output_text']);
const TOOL_NAME_MAX_CHARS = 120;

function normalizeToolName(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, TOOL_NAME_MAX_CHARS) : '';
}

/** Flatten OpenAI-compatible text content. Binary/media parts are omitted. */
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
    if (
      candidate.type !== undefined
      && typeof candidate.type === 'string'
      && !TEXT_PART_TYPES.has(candidate.type)
    ) {
      continue;
    }
    parts.push(candidate.text);
  }
  return parts.join(' ').trim();
}

/** Return the newest visible user/assistant/tool activity, safely bounded. */
export function extractLatestDisplayableMessage(
  messages: unknown,
  maxChars: number = CHAIN_MESSAGE_PREVIEW_MAX_CHARS,
): ConversationChainMessagePreview | null {
  if (!Array.isArray(messages)) return null;

  const limit = Math.max(1, Math.trunc(maxChars) || CHAIN_MESSAGE_PREVIEW_MAX_CHARS);

  const toolNameFor = (callId: string, beforeIndex: number): string | undefined => {
    for (let index = beforeIndex; index >= 0; index--) {
      const candidate = messages[index] as
        | { role?: unknown; tool_calls?: unknown }
        | null
        | undefined;
      if (!candidate || candidate.role !== 'assistant' || !Array.isArray(candidate.tool_calls)) continue;
      for (const rawCall of candidate.tool_calls) {
        if (!rawCall || typeof rawCall !== 'object') continue;
        const call = rawCall as { id?: unknown; function?: { name?: unknown } };
        if (call.id === callId) {
          const name = normalizeToolName(call.function?.name);
          if (name) return name;
        }
      }
    }
    return undefined;
  };

  const project = (
    role: ConversationChainMessagePreview['role'],
    rawText: string,
    timestamp: unknown,
    toolName?: string,
    toolKind?: 'call' | 'result',
  ): ConversationChainMessagePreview | null => {
    const collapsed = rawText.replace(/\s+/g, ' ').trim();
    if (!collapsed) return null;
    const truncated = collapsed.length > limit;
    return {
      role,
      text: truncated ? `${collapsed.slice(0, Math.max(0, limit - 1))}…` : collapsed,
      timestamp:
        typeof timestamp === 'number' && Number.isFinite(timestamp)
          ? timestamp
          : 0,
      truncated,
      ...(toolName ? { toolName } : {}),
      ...(toolKind ? { toolKind } : {}),
    };
  };

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as
      | {
          role?: unknown;
          content?: unknown;
          timestamp?: unknown;
          disabled?: unknown;
          name?: unknown;
          tool_call_id?: unknown;
          tool_calls?: unknown;
        }
      | null
      | undefined;
    if (!message || typeof message !== 'object' || message.disabled === true) continue;

    const role = message.role;
    if (role === 'user' || role === 'assistant') {
      const visible = project(role, extractMessageText(message.content), message.timestamp);
      if (visible) return visible;

      if (role === 'assistant' && Array.isArray(message.tool_calls)) {
        const names = message.tool_calls
          .map((rawCall) => {
            if (!rawCall || typeof rawCall !== 'object') return '';
            const call = rawCall as { function?: { name?: unknown } };
            return normalizeToolName(call.function?.name);
          })
          .filter(Boolean);
        if (names.length > 0) {
          return project(
            'tool',
            names.join(' · '),
            message.timestamp,
            names.length === 1 ? names[0] : undefined,
            'call',
          );
        }
      }
      continue;
    }

    if (role === 'tool') {
      const callId = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
      const namedTool = normalizeToolName(message.name);
      const toolName = namedTool || (callId ? toolNameFor(callId, index - 1) : undefined);
      const visible = project(
        'tool',
        toolName || 'tool',
        message.timestamp,
        toolName,
        'result',
      );
      if (visible) return visible;
    }
  }

  return null;
}
