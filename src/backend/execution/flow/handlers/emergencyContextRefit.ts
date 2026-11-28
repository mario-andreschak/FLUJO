import type OpenAI from 'openai';
import type { ToolResourceMarker } from '@/backend/services/model/adapters/types';

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
  /** Protected instructions/receipts cannot fit; the caller must refuse dispatch. */
  capacityExceeded: boolean;
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

function notice(
  counts: EmergencyContextRefitResult['omitted'],
  receipts: string[],
  sourceArchiveUri?: string,
): OpenAI.ChatCompletionAssistantMessageParam {
  const total = counts.assistant + counts.tool + counts.user + counts.other;
  return {
    role: 'assistant',
    content: [
      EMERGENCY_CONTEXT_REFIT_MARKER,
      `${total} older wire messages were omitted to keep this model request inside its context limit.`,
      `Omitted: ${counts.tool} tool results, ${counts.assistant} assistant messages, ${counts.user} user messages, ${counts.other} other messages.`,
      'The canonical FLUJO conversation remains intact. This is a deterministic last-resort refit, not an AI-generated summary.',
      'Continue from the retained recent context.',
      ...(sourceArchiveUri ? [
        `Exact pre-refit context is archived at ${sourceArchiveUri}. Use read_resource with search_text or bounded ranges to recover earlier decisions and observations before acting; do not repeat past actions to reconstruct them.`,
      ] : []),
      ...receipts,
    ].join('\n'),
  };
}

function materialize(
  messages: readonly OpenAI.ChatCompletionMessageParam[],
  omitted: ReadonlySet<number>,
  resourceMarkers?: Map<string, ToolResourceMarker>,
  sourceArchiveUri?: string,
): OpenAI.ChatCompletionMessageParam[] {
  if (omitted.size === 0) return messages.slice();
  const leadingSystem: OpenAI.ChatCompletionMessageParam[] = [];
  let index = 0;
  while (index < messages.length && (messages[index].role === 'system' || messages[index].role === 'developer')) {
    leadingSystem.push(messages[index]);
    index += 1;
  }
  return [
    ...leadingSystem,
    notice(countOmitted(messages, omitted), omittedReceipts(messages, omitted, resourceMarkers), sourceArchiveUri),
    ...messages.slice(index).filter((_message, messageIndex) => !omitted.has(messageIndex + index)),
  ];
}

function materializeSourceIndexes(
  messages: readonly OpenAI.ChatCompletionMessageParam[],
  omitted: ReadonlySet<number>,
): Array<number | undefined> {
  if (omitted.size === 0) return messages.map((_message, index) => index);
  let leadingSystemCount = 0;
  while (leadingSystemCount < messages.length && (messages[leadingSystemCount].role === 'system' || messages[leadingSystemCount].role === 'developer')) {
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

/** Exact execution identifiers come from actual call/result messages, never
 * from the summarizer. Only resource-backed completed groups may leave the
 * wire; unresolved calls and observations without an archive remain intact. */
function resourceUris(message: OpenAI.ChatCompletionMessageParam): string[] {
  const texts = typeof message.content === 'string' ? [message.content]
    : Array.isArray(message.content) ? message.content.flatMap(part => part && typeof part === 'object'
      && 'text' in part && typeof part.text === 'string' ? [part.text] : []) : [];
  return [...new Set(texts.flatMap(text => text.match(/flujo:\/\/run\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+/g) ?? []))];
}

export function isRecoveryAnchor(message: OpenAI.ChatCompletionMessageParam): boolean {
  const content = message.content;
  return resourceUris(message).length > 0 || (typeof content === 'string'
    && [EMERGENCY_CONTEXT_REFIT_MARKER, '[FLUJO conversation summary]', '[Visual context archive']
      .some(marker => content.startsWith(marker)));
}

function capturedResultUri(message: OpenAI.ChatCompletionMessageParam, markers?: Map<string, ToolResourceMarker>): string | undefined {
  if (message.role !== 'tool') return undefined;
  const entry = markers?.get(message.tool_call_id)?.result;
  return entry?.producedBy?.toolCallId === message.tool_call_id ? entry.uri : undefined;
}

function omittedReceipts(
  messages: readonly OpenAI.ChatCompletionMessageParam[],
  omitted: ReadonlySet<number>,
  resourceMarkers?: Map<string, ToolResourceMarker>,
): string[] {
  const receipts: string[] = [];
  const resultsByCall = new Map<string, OpenAI.ChatCompletionToolMessageParam[]>();
  for (const index of omitted) {
    const result = messages[index];
    if (result.role !== 'tool') continue;
    const results = resultsByCall.get(result.tool_call_id) ?? [];
    results.push(result); resultsByCall.set(result.tool_call_id, results);
  }
  for (const index of omitted) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    for (const call of message.tool_calls ?? []) {
      const tool = call.type === 'function' ? call.function.name : call.custom.name;
      const args = call.type === 'function' ? call.function.arguments : call.custom.input;
      const results = resultsByCall.get(call.id) ?? [];
      const argsEntry = resourceMarkers?.get(call.id)?.args;
      const argsResource = argsEntry?.producedBy?.toolCallId === call.id ? argsEntry.uri : undefined;
      receipts.push(JSON.stringify({ call_id: call.id, tool, state: 'result-observed',
        ...(argsResource ? { arguments_resource: argsResource } : { arguments: args }),
        resources: results.map(result => capturedResultUri(result, resourceMarkers)) }));
    }
  }
  return receipts.length ? [
    'Recorded tool calls below already have observed results. This does not assert that a side effect succeeded. Read the archived result before deciding how to recover; do not repeat a call because its detail was compacted.',
    ...receipts,
  ] : [];
}

function completeToolChunk(
  messages: readonly OpenAI.ChatCompletionMessageParam[],
  start: number,
  eligibleEnd: number,
  resourceMarkers?: Map<string, ToolResourceMarker>,
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
  return [...ids].every(id => found.has(id))
    && indexes.length === ids.size + 1
    && indexes.slice(1).every(index => {
      const result = messages[index];
      return result.role === 'tool' && ids.has(result.tool_call_id) && Boolean(capturedResultUri(result, resourceMarkers));
    })
    ? indexes : undefined;
}

function candidatesFor(
  messages: readonly OpenAI.ChatCompletionMessageParam[],
  keepRecentMessages: number,
  resourceMarkers?: Map<string, ToolResourceMarker>,
): CandidateChunk[] {
  const eligibleEnd = Math.max(0, messages.length - keepRecentMessages);
  const chunks: CandidateChunk[] = [];
  const consumed = new Set<number>();

  // Complete old tool-call/result groups are the safest and highest-value units.
  for (let index = 0; index < eligibleEnd; index += 1) {
    const group = completeToolChunk(messages, index, eligibleEnd, resourceMarkers);
    if (!group) continue;
    chunks.push({ indexes: group, priority: 0 });
    group.forEach(value => consumed.add(value));
    index = group[group.length - 1];
  }
  // Then old standalone assistant prose. Never detach a tool result from a call.
  for (let index = 0; index < eligibleEnd; index += 1) {
    if (consumed.has(index)) continue;
    const message = messages[index];
    if (message.role === 'assistant' && !isRecoveryAnchor(message)
      && (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0)) {
      chunks.push({ indexes: [index], priority: 1 });
      consumed.add(index);
    }
  }
  // User corrections and system/developer instructions remain verbatim, even
  // when old. Relevance or age cannot decide whether they are still binding.
  return chunks.sort((left, right) => left.priority - right.priority || left.indexes[0] - right.indexes[0]);
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
    resourceMarkers?: Map<string, ToolResourceMarker>;
    /** Exact durable pre-refit source, including omitted assistant decisions. */
    sourceArchiveUri?: string;
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
      capacityExceeded: false,
    };
  }
  const chunks = candidatesFor(messages, Math.max(2, Math.floor(options.keepRecentMessages ?? 6)), options.resourceMarkers);
  const omitted = new Set<number>();
  let fitted = messages.slice();
  // Re-measuring the entire history after EACH removed message was quadratic
  // and could freeze a 200,000-message run for minutes. Exponential batches
  // bound full-wire measurements logarithmically; all protected units stay.
  for (let offset = 0, batch = 1; offset < chunks.length; batch *= 2) {
    const end = Math.min(chunks.length, offset + batch);
    for (; offset < end; offset++) chunks[offset].indexes.forEach(index => omitted.add(index));
    fitted = materialize(messages, omitted, options.resourceMarkers, options.sourceArchiveUri);
    if (options.measure(fitted) <= target) break;
  }

  // No text truncation or absolute guard may weaken the protected contract.
  // A caller can withhold tool schemas and retry this calculation, or surface
  // an actionable capacity error. It must not dispatch an infeasible request.
  const after = options.measure(fitted);

  return {
    messages: fitted,
    sourceMessageIndexes: materializeSourceIndexes(messages, omitted),
    compacted: omitted.size > 0,
    before,
    after,
    omittedMessageIndexes: [...omitted].sort((left, right) => left - right),
    truncatedMessageIndexes: [],
    omitted: countOmitted(messages, omitted),
    capacityExceeded: after > target,
  };
}
