import type OpenAI from 'openai';

export const EMERGENCY_CONTEXT_REFIT_MARKER = '[FLUJO emergency context compaction]';

export interface EmergencyContextRefitResult {
  messages: OpenAI.ChatCompletionMessageParam[];
  /** Original input index for each returned message; undefined is the injected notice. */
  sourceMessageIndexes: Array<number | undefined>;
  compacted: boolean;
  before: number;
  after: number;
  omittedMessageIndexes: number[];
  truncatedMessageIndexes: number[];
  omitted: { assistant: number; tool: number; user: number; other: number };
}

interface CandidateChunk {
  indexes: number[];
  priority: number;
}

function countOmitted(
  messages: readonly OpenAI.ChatCompletionMessageParam[],
  omitted: ReadonlySet<number>,
): EmergencyContextRefitResult['omitted'] {
  const counts = { assistant: 0, tool: 0, user: 0, other: 0 };
  for (const index of omitted) {
    const role = messages[index]?.role;
    if (role === 'assistant' || role === 'tool' || role === 'user') counts[role] += 1;
    else counts.other += 1;
  }
  return counts;
}

function notice(counts: EmergencyContextRefitResult['omitted']): OpenAI.ChatCompletionAssistantMessageParam {
  const total = counts.assistant + counts.tool + counts.user + counts.other;
  return {
    role: 'assistant',
    content: [
      EMERGENCY_CONTEXT_REFIT_MARKER,
      `${total} older wire messages were omitted to keep this model request inside its context limit.`,
      `Omitted: ${counts.tool} tool results, ${counts.assistant} assistant messages, ${counts.user} user messages, ${counts.other} other messages.`,
      'The canonical FLUJO conversation remains intact. This is a deterministic last-resort refit, not an AI-generated summary.',
      'Continue from the retained recent context.',
    ].join('\n'),
  };
}

function materialize(
  messages: readonly OpenAI.ChatCompletionMessageParam[],
  omitted: ReadonlySet<number>,
): OpenAI.ChatCompletionMessageParam[] {
  if (omitted.size === 0) return messages.slice();
  const leadingSystem: OpenAI.ChatCompletionMessageParam[] = [];
  let index = 0;
  while (index < messages.length && messages[index].role === 'system') {
    leadingSystem.push(messages[index]);
    index += 1;
  }
  return [
    ...leadingSystem,
    notice(countOmitted(messages, omitted)),
    ...messages.slice(index).filter((_message, messageIndex) => !omitted.has(messageIndex + index)),
  ];
}

function materializeSourceIndexes(
  messages: readonly OpenAI.ChatCompletionMessageParam[],
  omitted: ReadonlySet<number>,
): Array<number | undefined> {
  if (omitted.size === 0) return messages.map((_message, index) => index);
  let leadingSystemCount = 0;
  while (leadingSystemCount < messages.length && messages[leadingSystemCount].role === 'system') {
    leadingSystemCount += 1;
  }
  return [
    ...messages.slice(0, leadingSystemCount).map((_message, index) => index),
    undefined,
    ...messages
      .slice(leadingSystemCount)
      .map((_message, index) => index + leadingSystemCount)
      .filter(index => !omitted.has(index)),
  ];
}

function completeToolChunk(
  messages: readonly OpenAI.ChatCompletionMessageParam[],
  start: number,
  eligibleEnd: number,
): number[] | undefined {
  const message = messages[start];
  if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
    return undefined;
  }
  const ids = new Set(message.tool_calls.map(call => call.id));
  const found = new Set<string>();
  const indexes = [start];
  let index = start + 1;
  while (index < eligibleEnd && messages[index].role === 'tool') {
    const result = messages[index] as OpenAI.ChatCompletionToolMessageParam;
    indexes.push(index);
    if (ids.has(result.tool_call_id)) found.add(result.tool_call_id);
    index += 1;
  }
  return [...ids].every(id => found.has(id)) ? indexes : undefined;
}

function candidatesFor(
  messages: readonly OpenAI.ChatCompletionMessageParam[],
  keepRecentMessages: number,
): CandidateChunk[] {
  const eligibleEnd = Math.max(0, messages.length - keepRecentMessages);
  const chunks: CandidateChunk[] = [];
  const consumed = new Set<number>();

  // Complete old tool-call/result groups are the safest and highest-value units.
  for (let index = 0; index < eligibleEnd; index += 1) {
    const group = completeToolChunk(messages, index, eligibleEnd);
    if (!group) continue;
    chunks.push({ indexes: group, priority: 0 });
    group.forEach(value => consumed.add(value));
    index = group[group.length - 1];
  }
  // Then old standalone assistant prose. Never detach a tool result from a call.
  for (let index = 0; index < eligibleEnd; index += 1) {
    if (consumed.has(index)) continue;
    const message = messages[index];
    if (message.role === 'assistant' && (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0)) {
      chunks.push({ indexes: [index], priority: 1 });
      consumed.add(index);
    }
  }
  // Finally old user/other messages, preserving the most recent user task.
  let latestUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') { latestUser = index; break; }
  }
  for (let index = 0; index < eligibleEnd; index += 1) {
    if (consumed.has(index) || index === latestUser || messages[index].role === 'system' || messages[index].role === 'tool') continue;
    chunks.push({ indexes: [index], priority: 2 });
  }
  return chunks.sort((left, right) => left.priority - right.priority || left.indexes[0] - right.indexes[0]);
}

function textLength(message: OpenAI.ChatCompletionMessageParam): number {
  if (typeof message.content === 'string') return Array.from(message.content).length;
  if (!Array.isArray(message.content)) return 0;
  return message.content.reduce((sum, part) => sum + (
    part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
      ? Array.from(part.text).length
      : 0
  ), 0);
}

function truncateText(text: string, target: number): string {
  const points = Array.from(text);
  if (points.length <= target) return text;
  const removed = points.length - target;
  const marker = Array.from(`\n…[FLUJO truncated ${removed} characters during emergency context refit]…\n`);
  const payload = Math.max(0, target - marker.length);
  const head = Math.ceil(payload * 0.7);
  return [...points.slice(0, head), ...marker, ...points.slice(points.length - (payload - head))].join('');
}

function truncateMessage(
  message: OpenAI.ChatCompletionMessageParam,
  target: number,
): OpenAI.ChatCompletionMessageParam {
  if (typeof message.content === 'string') {
    return { ...message, content: truncateText(message.content, target) } as OpenAI.ChatCompletionMessageParam;
  }
  if (!Array.isArray(message.content)) return message;
  let remaining = target;
  return {
    ...message,
    content: message.content.map(part => {
      if (!part || typeof part !== 'object' || !('text' in part) || typeof part.text !== 'string') return part;
      const text = truncateText(part.text, Math.max(128, remaining));
      remaining = Math.max(0, remaining - Array.from(text).length);
      return { ...part, text };
    }),
  } as OpenAI.ChatCompletionMessageParam;
}

/**
 * Provider-neutral last-resort refit. Complete tool groups are removed as units,
 * so Chat Completions/Responses/Anthropic/Gemini wires remain structurally valid.
 * `measure` may be tokens, characters, or provider-specific weighted units.
 */
export function emergencyRefitMessages(
  messages: readonly OpenAI.ChatCompletionMessageParam[],
  options: {
    target: number;
    measure: (messages: readonly OpenAI.ChatCompletionMessageParam[]) => number;
    keepRecentMessages?: number;
  },
): EmergencyContextRefitResult {
  const target = Math.max(1, options.target);
  const before = options.measure(messages);
  if (before <= target) {
    return {
      messages: messages.slice(), compacted: false, before, after: before,
      sourceMessageIndexes: messages.map((_message, index) => index),
      omittedMessageIndexes: [], truncatedMessageIndexes: [],
      omitted: { assistant: 0, tool: 0, user: 0, other: 0 },
    };
  }
  const chunks = candidatesFor(messages, Math.max(2, Math.floor(options.keepRecentMessages ?? 6)));
  let omitted = new Set<number>();
  let fitted = messages.slice();
  for (const chunk of chunks) {
    chunk.indexes.forEach(index => omitted.add(index));
    fitted = materialize(messages, omitted);
    if (options.measure(fitted) <= target) break;
  }

  const truncated = new Set<number>();
  for (let pass = 0; options.measure(fitted) > target && pass < 24; pass += 1) {
    const over = options.measure(fitted) - target;
    let largest = -1;
    let length = 0;
    for (let index = 0; index < fitted.length; index += 1) {
      const candidateLength = textLength(fitted[index]);
      if (candidateLength > length) { largest = index; length = candidateLength; }
    }
    if (largest < 0 || length <= 128) break;
    const source = fitted[largest];
    const originalIndex = messages.findIndex((message, index) => !omitted.has(index) && message === source);
    if (originalIndex >= 0) truncated.add(originalIndex);
    fitted[largest] = truncateMessage(source, Math.max(128, length - Math.max(over * 4 + 2_048, Math.ceil(length / 3))));
  }

  // Absolute message-side guard for malformed wires (or an enormous current
  // user/system message). Keep the system contract and latest user task, mark
  // every other non-system message omitted, then bound retained text. A caller
  // may still have to shed an oversized tool-definition block, which is not
  // part of this message-only function.
  if (options.measure(fitted) > target) {
    let latestUser = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'user') { latestUser = index; break; }
    }
    omitted = new Set(messages
      .map((_message, index) => index)
      .filter(index => messages[index].role !== 'system' && index !== latestUser));
    fitted = materialize(messages, omitted);
    for (let pass = 0; options.measure(fitted) > target && pass < 32; pass += 1) {
      const over = options.measure(fitted) - target;
      let largest = -1;
      let length = 0;
      for (let index = 0; index < fitted.length; index += 1) {
        const candidateLength = textLength(fitted[index]);
        if (candidateLength > length) { largest = index; length = candidateLength; }
      }
      if (largest < 0 || length <= 128) break;
      const source = fitted[largest];
      const originalIndex = messages.findIndex((message, index) => !omitted.has(index) && message === source);
      if (originalIndex >= 0) truncated.add(originalIndex);
      fitted[largest] = truncateMessage(
        source,
        Math.max(128, length - Math.max(over * 4 + 2_048, Math.ceil(length / 2))),
      );
    }
  }

  return {
    messages: fitted,
    sourceMessageIndexes: materializeSourceIndexes(messages, omitted),
    compacted: fitted.length !== messages.length || truncated.size > 0,
    before,
    after: options.measure(fitted),
    omittedMessageIndexes: [...omitted].sort((left, right) => left - right),
    truncatedMessageIndexes: [...truncated].sort((left, right) => left - right),
    omitted: countOmitted(messages, omitted),
  };
}
