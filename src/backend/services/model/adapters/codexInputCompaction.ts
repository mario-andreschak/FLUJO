import type OpenAI from 'openai';
import type { ToolResourceMarker } from './types';
import { normalizeMessageInput } from './messageNormalization';
import { emergencyRefitMessages } from '@/backend/execution/flow/handlers/emergencyContextRefit';

/** Codex Exec rejects turn/start above this many Unicode characters. */
export const CODEX_EXEC_MAX_INPUT_CHARS = 1_048_576;
/**
 * Leave room for SDK framing and small runtime differences. The refit is a
 * deterministic safety net; AI summarizing compaction normally runs earlier.
 */
export const CODEX_EXEC_TARGET_INPUT_CHARS = 980_000;

export const CODEX_EMERGENCY_COMPACTION_MARKER = '[FLUJO emergency context compaction]';

export interface CodexInputRefitResult {
  messages: OpenAI.ChatCompletionMessageParam[];
  /** Original input index for each returned message; undefined is the injected notice. */
  sourceMessageIndexes: Array<number | undefined>;
  compacted: boolean;
  originalCharacters: number;
  finalCharacters: number;
  omittedMessageIndexes: number[];
  truncatedMessageIndexes: number[];
  omitted: { assistant: number; tool: number; other: number };
  capacityExceeded: boolean;
}

function codePoints(value: string): number {
  // Count Unicode code points without allocating an array per large request.
  let count = 0;
  for (const point of value) { count += point.length > 0 ? 1 : 0; }
  return count;
}

export class CodexInputLimitError extends Error {
  readonly code = 'context_budget_exceeded';
  constructor(readonly inputCharacters: number) {
    super(`The next Codex request contains ${inputCharacters.toLocaleString('en-US')} characters after session selection, exceeding FLUJO's ${CODEX_EXEC_TARGET_INPUT_CHARS.toLocaleString('en-US')}-character transport budget. The full conversation is saved. Shorten this request or use a new chat with the relevant context; selecting a larger model window does not change this transport limit.`);
    this.name = 'CodexInputLimitError';
  }
}

/** Check the actual new turn, after a compatible resume/fork has selected its delta. */
export function assertCodexTransportInput(parts: readonly string[]): void {
  const characters = parts.reduce((sum, part) => sum + codePoints(part), 0) + parts.length;
  if (characters > CODEX_EXEC_TARGET_INPUT_CHARS) throw new CodexInputLimitError(characters);
}

/** Estimate the exact text contribution passed to Codex SDK run/runStreamed. */
export function estimateCodexInputCharacters(
  messages: readonly OpenAI.ChatCompletionMessageParam[],
  resourceMarkers?: Map<string, ToolResourceMarker>,
): number {
  const normalized = normalizeMessageInput(messages, resourceMarkers);
  const textItems: string[] = [];
  if (normalized.systemPrompt) {
    textItems.push(`<system_instructions>\n${normalized.systemPrompt}\n</system_instructions>`);
  }
  if (normalized.text) textItems.push(normalized.text);
  for (const image of normalized.images) {
    // Base64 images become short local_image paths. Remote images become this
    // exact text item in codexAdapter. Count a conservative path allowance for
    // local images so the preflight never lands on the hard boundary.
    textItems.push(image.base64 ? '[local image path]'.padEnd(256, ' ') : `[image: ${image.url}]`);
  }
  const framing = textItems.length > 1 ? textItems.length : 0;
  return textItems.reduce((sum, value) => sum + codePoints(value), 0) + framing;
}

/** Apply the same protected-message and complete-receipt policy as the generic
 * wire, measured against Codex's independent transport character ceiling. */
export function refitCodexMessagesForInputLimit(
  messages: readonly OpenAI.ChatCompletionMessageParam[],
  options: {
    resourceMarkers?: Map<string, ToolResourceMarker>;
    targetCharacters?: number;
    keepRecentMessages?: number;
  } = {},
): CodexInputRefitResult {
  const target = Math.min(CODEX_EXEC_MAX_INPUT_CHARS - 1,
    Math.max(8_192, Math.floor(options.targetCharacters ?? CODEX_EXEC_TARGET_INPUT_CHARS)));
  const result = emergencyRefitMessages(messages, {
    target,
    measure: candidate => estimateCodexInputCharacters(candidate, options.resourceMarkers),
    keepRecentMessages: options.keepRecentMessages ?? 12,
    resourceMarkers: options.resourceMarkers,
  });
  return {
    messages: result.messages,
    sourceMessageIndexes: result.sourceMessageIndexes,
    compacted: result.compacted,
    originalCharacters: result.before,
    finalCharacters: result.after,
    omittedMessageIndexes: result.omittedMessageIndexes,
    truncatedMessageIndexes: result.truncatedMessageIndexes,
    omitted: { assistant: result.omitted.assistant, tool: result.omitted.tool,
      other: result.omitted.user + result.omitted.other },
    capacityExceeded: result.capacityExceeded,
  };
}
