import OpenAI from 'openai';
import type { ToolResourceMarker } from './types';
import { extractImageParts, extractText, type ImagePart, truncateForPrompt } from './messageUtils';

const TOOL_RESULT_MAX_CHARS = 4000;
const TOOL_ARGS_MAX_CHARS = 2000;
const ENTRY_SEPARATOR = '\n===\n';
const HISTORY_OPEN = '<conversation_history>';
const HISTORY_CLOSE = '</conversation_history>';
const HISTORY_PREAMBLE =
  'This is a RECORD of the conversation so far, including actions already taken and their ' +
  'results. It is reference material, NOT a template to continue: never write `[prior action]` ' +
  'lines, `Human:`/`Assistant:` prefixes, or any other tool-call notation as text in your ' +
  'reply. To take a new action, call the tool through your normal tool interface.';

export interface NormalizedMessageInput {
  systemPrompt?: string;
  text: string;
  images: ImagePart[];
}

function wrapHistory(body: string): string {
  return `${HISTORY_OPEN}\n${HISTORY_PREAMBLE}\n\n${body}\n${HISTORY_CLOSE}`;
}

/** Omit persisted assistant entries that contain a failed, invocation-like tool call. */
export function isMalformedToolCallProse(text: string): boolean {
  const parseFailure = /(?:tool call could not be parsed|failed to parse (?:the )?tool call)/i.test(text);
  if (!parseFailure) return false;
  return (
    /\[tool call\]/i.test(text) ||
    /\bmcp__flujo__[a-z0-9_-]+\b/i.test(text) ||
    /<(?:invoke|function_calls?|tool_use)\b/i.test(text) ||
    /\b(?:assistant\s+to|invoke)\s*=\s*[a-z0-9_.:-]+/i.test(text)
  );
}

/** Normalize FLUJO/OpenAI-format history without introducing an SDK wire format. */
export function normalizeMessageInput(
  messages: readonly OpenAI.ChatCompletionMessageParam[],
  resourceMarkers?: Map<string, ToolResourceMarker>,
): NormalizedMessageInput {
  const systemParts: string[] = [];
  const lines: string[] = [];
  const images: ImagePart[] = [];
  let toolActivity = false;
  let plainTurns = 0;
  let firstPlainText = '';

  const callNames = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc.type === 'function') callNames.set(tc.id, tc.function.name);
      }
    }
  }

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = extractText(msg.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (msg.role === 'tool') {
      toolActivity = true;
      const name = callNames.get(msg.tool_call_id) ?? msg.tool_call_id;
      const fullResult = extractText(msg.content ?? '');
      const entry = resourceMarkers?.get(msg.tool_call_id)?.result;
      if (entry && fullResult.length > TOOL_RESULT_MAX_CHARS) {
        lines.push(
          `[prior action result] ${name}\n${fullResult.slice(0, TOOL_RESULT_MAX_CHARS)}\n…\n` +
            `[full content stored as run resource ${entry.uri} — call read_resource with this uri to read it]`,
        );
      } else {
        lines.push(`[prior action result] ${name}\n${truncateForPrompt(fullResult, TOOL_RESULT_MAX_CHARS)}`);
      }
      continue;
    }
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;

    const text = extractText(msg.content ?? '');
    const safeText = msg.role === 'assistant' && isMalformedToolCallProse(text) ? '' : text;
    if (safeText) {
      plainTurns++;
      if (plainTurns === 1) firstPlainText = safeText;
      lines.push(`${msg.role === 'assistant' ? 'Assistant' : 'Human'}: ${safeText}`);
    }
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc.type !== 'function') continue;
        toolActivity = true;
        const fullArgs = tc.function.arguments ?? '';
        const argsEntry = resourceMarkers?.get(tc.id)?.args;
        if (argsEntry && fullArgs.length > TOOL_ARGS_MAX_CHARS) {
          lines.push(
            `[prior action] ${tc.function.name}\narguments: ${fullArgs.slice(0, TOOL_ARGS_MAX_CHARS)}\n…\n` +
              `[full arguments stored as run resource ${argsEntry.uri} — call read_resource with this uri to read them]`,
          );
        } else {
          lines.push(
            `[prior action] ${tc.function.name}\narguments: ${truncateForPrompt(fullArgs, TOOL_ARGS_MAX_CHARS)}`,
          );
        }
      }
    }
    if (msg.role === 'user') images.push(...extractImageParts(msg.content));
  }

  return {
    systemPrompt: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    text: toolActivity
      ? wrapHistory(lines.join(ENTRY_SEPARATOR))
      : plainTurns <= 1
        ? firstPlainText
        : lines.join('\n\n'),
    images,
  };
}
