import type OpenAI from 'openai';
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems';
import { inspectJson } from '@/backend/execution/flow/compaction/jsonInspection';
import { digestCanonicalJson } from '@/backend/execution/flow/compaction/digest';

export const MAX_RESPONSES_SESSION_CHARS = 1_048_576;

/** Bounded persisted JSON, detached in the current realm just like a reload. */
export const cloneResponsesJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export interface ResponsesReplayRecord {
  callId?: string;
  items: OpenAI.Responses.ResponseReasoningItem[];
  nativeOutput?: OpenAI.Responses.ResponseOutputItem[];
  nativeInputDigest?: string;
  retainedChars: number;
  inputLength: number;
  inputDigest: string;
  outputLength: number;
  outputDigest: string;
}

/** Derived replay state checkpointed with its canonical conversation.
 * Contains no credential bytes, remote handles or tool execution authority. */
export interface ResponsesSessionState {
  version: 1;
  workspace: string;
  conversationId: string;
  nodeId?: string;
  owner: string;
  recordsDigest: string;
  records: Array<[string, ResponsesReplayRecord]>;
}

const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

// A checkpoint contains provider output, never arbitrary input instructions or
// item references. Keep this exhaustive for the installed SDK's output union.
const outputTypes = {
  message: true, reasoning: true, compaction: true,
  function_call: true, function_call_output: true,
  file_search_call: true, web_search_call: true, image_generation_call: true,
  computer_call: true, computer_call_output: true, code_interpreter_call: true,
  program: true, program_output: true, tool_search_call: true, tool_search_output: true,
  additional_tools: true, local_shell_call: true, local_shell_call_output: true,
  shell_call: true, shell_call_output: true, apply_patch_call: true, apply_patch_call_output: true,
  mcp_call: true, mcp_list_tools: true, mcp_approval_request: true, mcp_approval_response: true,
  custom_tool_call: true, custom_tool_call_output: true,
} satisfies Record<OpenAI.Responses.ResponseOutputItem['type'], true>;

/** Normalize a disposable replay copy; stored output and opaque bytes stay exact.
 * The SDK removes output-only provenance/parsed fields and skips known items
 * that cannot be replayed without changing their meaning. */
export function responsesReplayInput(output: unknown): OpenAI.Responses.ResponseInputItem[] | undefined {
  if (!Array.isArray(output) || !output.length || output.some(item => !item || typeof item !== 'object'
    || typeof item.type !== 'string' || !Object.hasOwn(outputTypes, item.type))) return undefined;
  try {
    const input = toResponseInputItems(output);
    return input.length ? input : undefined;
  } catch {
    return undefined;
  }
}

/** Source/native prefix compatibility is checked again immediately before use. */
export function validateResponsesSession(
  value: unknown,
  scope: { workspace: string; conversationId: string; nodeId?: string; owner?: string },
): ResponsesSessionState | undefined {
  try {
    if (!value || typeof value !== 'object') return undefined;
    const state = value as ResponsesSessionState;
    if (state.version !== 1 || state.workspace !== scope.workspace
      || state.conversationId !== scope.conversationId || state.nodeId !== scope.nodeId
      || !digest(state.owner) || (scope.owner !== undefined && state.owner !== scope.owner)
      || !Array.isArray(state.records) || !state.records.length || state.records.length > 64
      || inspectJson(state) > MAX_RESPONSES_SESSION_CHARS
      || !digest(state.recordsDigest) || digestCanonicalJson(state.records) !== state.recordsDigest) return undefined;
    const anchors = new Set<string>();
    for (const entry of state.records) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string'
        || !entry[1] || typeof entry[1] !== 'object' || anchors.has(entry[0])) return undefined;
      anchors.add(entry[0]);
      const record = entry[1];
      if (!count(record.inputLength) || !count(record.outputLength) || !record.outputLength
        || !digest(record.inputDigest) || !digest(record.outputDigest)
        || !count(record.retainedChars) || !Array.isArray(record.items)
        || (record.callId !== undefined && typeof record.callId !== 'string')) return undefined;
      const output = record.nativeOutput ?? record.items;
      if (!responsesReplayInput(output)
        || inspectJson(output) !== record.retainedChars
        || (record.nativeOutput !== undefined && !digest(record.nativeInputDigest))
        || (record.nativeOutput === undefined && (!record.callId || record.items.some(item => item.type !== 'reasoning')))) return undefined;
    }
    return cloneResponsesJson(state);
  } catch {
    // Corrupt, cyclic and non-JSON metadata use canonical history.
    return undefined;
  }
}

/** Bound the aggregate checkpoint, including metadata, across Process nodes. */
export function replaceResponsesSession(
  previous: Record<string, ResponsesSessionState> | undefined,
  nodeId: string,
  next: ResponsesSessionState | undefined,
): Record<string, ResponsesSessionState> | undefined {
  const entries = Object.entries(previous ?? {}).filter(([key]) => key !== nodeId);
  if (next) entries.push([nodeId, next]);
  let size = 2;
  const retained: Array<[string, ResponsesSessionState]> = [];
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    let chars: number;
    try { chars = inspectJson(entry) + 1; } catch { continue; }
    if (retained.length >= 64 || size + chars > MAX_RESPONSES_SESSION_CHARS) continue;
    size += chars;
    retained.push(entry);
  }
  return retained.length ? Object.fromEntries(retained.reverse()) : undefined;
}

export function validateResponsesSessions(
  value: unknown,
  scope: { workspace: string; conversationId: string },
): Record<string, ResponsesSessionState> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  let sessions: Record<string, ResponsesSessionState> | undefined;
  for (const [nodeId, candidate] of Object.entries(value).slice(-64)) {
    const session = validateResponsesSession(candidate, { ...scope, nodeId });
    if (session) sessions = replaceResponsesSession(sessions, nodeId, session);
  }
  return sessions;
}
