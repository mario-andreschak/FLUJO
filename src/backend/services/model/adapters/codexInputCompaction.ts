import type OpenAI from 'openai';
import type { ToolResourceMarker } from './types';
import { normalizeMessageInput } from './messageNormalization';

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
}

function codePoints(value: string): number {
  return Array.from(value).length;
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

function emergencyNotice(omitted: CodexInputRefitResult['omitted']): OpenAI.ChatCompletionAssistantMessageParam {
  const total = omitted.assistant + omitted.tool + omitted.other;
  return {
    role: 'assistant',
    content: [
      CODEX_EMERGENCY_COMPACTION_MARKER,
      `${total} older messages were omitted from this provider request before it reached Codex Exec's input limit.`,
      `Omitted: ${omitted.tool} tool results, ${omitted.assistant} assistant messages, ${omitted.other} other messages.`,
      'The canonical FLUJO conversation remains intact. This is a deterministic last-resort refit, not an AI-generated summary.',
      'Continue from the retained user messages and recent context.',
    ].join('\n'),
  };
}

function omittedCounts(
  messages: readonly OpenAI.ChatCompletionMessageParam[],
  omittedIndexes: ReadonlySet<number>,
): CodexInputRefitResult['omitted'] {
  const out = { assistant: 0, tool: 0, other: 0 };
  for (const index of omittedIndexes) {
    const role = messages[index]?.role;
    if (role === 'assistant') out.assistant += 1;
    else if (role === 'tool') out.tool += 1;
    else out.other += 1;
  }
  return out;
}

function materialize(
  messages: readonly OpenAI.ChatCompletionMessageParam[],
  omittedIndexes: ReadonlySet<number>,
): OpenAI.ChatCompletionMessageParam[] {
  const omitted = omittedCounts(messages, omittedIndexes);
  if (omittedIndexes.size === 0) return messages.slice();
  const system = messages.filter(message => message.role === 'system');
  const retained = messages.filter((message, index) => message.role !== 'system' && !omittedIndexes.has(index));
  return [...system, emergencyNotice(omitted), ...retained];
}

function materializeSourceIndexes(
  messages: readonly OpenAI.ChatCompletionMessageParam[],
  omittedIndexes: ReadonlySet<number>,
): Array<number | undefined> {
  if (omittedIndexes.size === 0) return messages.map((_message, index) => index);
  const system = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === 'system')
    .map(({ index }) => index);
  const retained = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message, index }) => message.role !== 'system' && !omittedIndexes.has(index))
    .map(({ index }) => index);
  return [...system, undefined, ...retained];
}

function truncateMiddle(text: string, targetCharacters: number): string {
  const points = Array.from(text);
  if (points.length <= targetCharacters) return text;
  const removed = points.length - targetCharacters;
  const marker = Array.from(`\n…[FLUJO truncated ${removed} characters to fit Codex input]…\n`);
  const payload = Math.max(0, targetCharacters - marker.length);
  const head = Math.ceil(payload * 0.7);
  return [...points.slice(0, head), ...marker, ...points.slice(points.length - (payload - head))].join('');
}

function truncateMessageContent(
  message: OpenAI.ChatCompletionMessageParam,
  targetCharacters: number,
): OpenAI.ChatCompletionMessageParam {
  if (typeof message.content === 'string') {
    return { ...message, content: truncateMiddle(message.content, targetCharacters) } as OpenAI.ChatCompletionMessageParam;
  }
  if (!Array.isArray(message.content)) return message;
  let remaining = targetCharacters;
  const content = message.content.map(part => {
    if (!part || typeof part !== 'object' || !('text' in part) || typeof part.text !== 'string') return part;
    const next = truncateMiddle(part.text, Math.max(256, remaining));
    remaining = Math.max(0, remaining - codePoints(next));
    return { ...part, text: next };
  });
  return { ...message, content } as OpenAI.ChatCompletionMessageParam;
}

function minimumPrefixToFit(
  candidates: readonly number[],
  build: (count: number) => OpenAI.ChatCompletionMessageParam[],
  fits: (messages: readonly OpenAI.ChatCompletionMessageParam[]) => boolean,
): number | undefined {
  let low = 1;
  let high = candidates.length;
  let answer: number | undefined;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (fits(build(mid))) {
      answer = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return answer;
}

/**
 * Deterministically refit a Codex request before the CLI can reject it.
 *
 * Order of sacrifice:
 *   1. oldest assistant/tool messages outside the recent tail;
 *   2. other old messages, while retaining the latest user task and recent tail;
 *   3. exceptionally-large retained text, with an explicit inline marker.
 *
 * Canonical history is never touched. The returned indexes let the model-turn
 * archive annotate exactly which canonical wire messages were omitted.
 */
export function refitCodexMessagesForInputLimit(
  messages: readonly OpenAI.ChatCompletionMessageParam[],
  options: {
    resourceMarkers?: Map<string, ToolResourceMarker>;
    targetCharacters?: number;
    keepRecentMessages?: number;
  } = {},
): CodexInputRefitResult {
  const target = Math.min(
    CODEX_EXEC_MAX_INPUT_CHARS - 1,
    Math.max(8_192, Math.floor(options.targetCharacters ?? CODEX_EXEC_TARGET_INPUT_CHARS)),
  );
  const originalCharacters = estimateCodexInputCharacters(messages, options.resourceMarkers);
  if (originalCharacters <= target) {
    return {
      messages: messages.slice(),
      sourceMessageIndexes: messages.map((_message, index) => index),
      compacted: false,
      originalCharacters,
      finalCharacters: originalCharacters,
      omittedMessageIndexes: [],
      truncatedMessageIndexes: [],
      omitted: { assistant: 0, tool: 0, other: 0 },
    };
  }

  const keepRecent = Math.max(2, Math.floor(options.keepRecentMessages ?? 12));
  const recentStart = Math.max(0, messages.length - keepRecent);
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      latestUserIndex = index;
      break;
    }
  }

  const primary = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message, index }) => index < recentStart && (message.role === 'assistant' || message.role === 'tool'))
    .map(({ index }) => index);
  const secondary = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message, index }) => (
      message.role !== 'system'
      && index < recentStart
      && index !== latestUserIndex
      && !primary.includes(index)
    ))
    .map(({ index }) => index);
  const candidates = [...primary, ...secondary];
  const fits = (candidate: readonly OpenAI.ChatCompletionMessageParam[]) =>
    estimateCodexInputCharacters(candidate, options.resourceMarkers) <= target;
  const build = (count: number) => materialize(messages, new Set(candidates.slice(0, count)));
  const count = minimumPrefixToFit(candidates, build, fits);

  let omittedIndexes = new Set<number>(count === undefined ? candidates : candidates.slice(0, count));
  let fitted = materialize(messages, omittedIndexes);
  const truncatedOriginalIndexes = new Set<number>();
  let absoluteGuardUsed = false;

  // Pathological single-message/system prompts can still exceed the aggregate
  // limit after every safe old message is gone. Reduce the largest retained text
  // explicitly until the request fits; never hand an oversized turn to Codex.
  for (let pass = 0; !fits(fitted) && pass < 24; pass += 1) {
    const overBy = estimateCodexInputCharacters(fitted, options.resourceMarkers) - target;
    let largestIndex = -1;
    let largestLength = 0;
    for (let index = 0; index < fitted.length; index += 1) {
      const content = fitted[index].content;
      const length = typeof content === 'string'
        ? codePoints(content)
        : Array.isArray(content)
          ? content.reduce((sum, part) => sum + (
              part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
                ? codePoints(part.text)
                : 0
            ), 0)
          : 0;
      if (length > largestLength) {
        largestLength = length;
        largestIndex = index;
      }
    }
    if (largestIndex < 0 || largestLength <= 256) break;
    const targetLength = Math.max(256, largestLength - Math.max(overBy + 4_096, Math.ceil(largestLength / 3)));
    const fittedMessage = fitted[largestIndex];
    // Map by identity before replacing the retained message with a clone.
    if (!(fittedMessage.role === 'assistant' && typeof fittedMessage.content === 'string'
      && fittedMessage.content.startsWith(CODEX_EMERGENCY_COMPACTION_MARKER))) {
      const originalIndex = messages.findIndex((message, index) => !omittedIndexes.has(index) && message === fittedMessage);
      if (originalIndex >= 0) truncatedOriginalIndexes.add(originalIndex);
    }
    fitted[largestIndex] = truncateMessageContent(fittedMessage, targetLength);
  }

  // Absolute final guard. Keeping only bounded system/latest-user text is much
  // better than turning a long-running conversation into a terminal error.
  if (!fits(fitted)) {
    absoluteGuardUsed = true;
    const systemMessages = messages.filter(message => message.role === 'system');
    const perSystemBudget = Math.max(128, Math.floor((target * 0.35) / Math.max(1, systemMessages.length)));
    const system = systemMessages.map(message => truncateMessageContent(message, perSystemBudget));
    const latestUser = latestUserIndex >= 0
      ? truncateMessageContent(messages[latestUserIndex], Math.max(256, Math.floor(target * 0.45)))
      : ({ role: 'user', content: 'Continue from the retained FLUJO context.' } as OpenAI.ChatCompletionUserMessageParam);
    omittedIndexes = new Set(messages.map((_message, index) => index).filter(index => (
      messages[index].role !== 'system' && index !== latestUserIndex
    )));
    fitted = [...system, emergencyNotice(omittedCounts(messages, omittedIndexes)), latestUser];
    for (let pass = 0; !fits(fitted) && pass < 16; pass += 1) {
      const overBy = estimateCodexInputCharacters(fitted, options.resourceMarkers) - target;
      let largestIndex = -1;
      let largestLength = 0;
      for (let index = 0; index < fitted.length; index += 1) {
        const length = typeof fitted[index].content === 'string'
          ? codePoints(fitted[index].content as string)
          : 0;
        if (length > largestLength) { largestLength = length; largestIndex = index; }
      }
      if (largestIndex < 0 || largestLength <= 128) break;
      fitted[largestIndex] = truncateMessageContent(
        fitted[largestIndex],
        Math.max(128, largestLength - overBy - 256),
      );
    }
  }

  const omitted = omittedCounts(messages, omittedIndexes);
  const sourceMessageIndexes = absoluteGuardUsed
    ? [
        ...messages
          .map((message, index) => ({ message, index }))
          .filter(({ message }) => message.role === 'system')
          .map(({ index }) => index),
        undefined,
        latestUserIndex >= 0 ? latestUserIndex : undefined,
      ]
    : materializeSourceIndexes(messages, omittedIndexes);
  return {
    messages: fitted,
    sourceMessageIndexes,
    compacted: true,
    originalCharacters,
    finalCharacters: estimateCodexInputCharacters(fitted, options.resourceMarkers),
    omittedMessageIndexes: [...omittedIndexes].sort((left, right) => left - right),
    truncatedMessageIndexes: [...truncatedOriginalIndexes].sort((left, right) => left - right),
    omitted,
  };
}
