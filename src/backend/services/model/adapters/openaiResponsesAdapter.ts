import OpenAI from 'openai';
import { contextUsageFromCompletion } from './contextUsage';
import { createLogger } from '@/utils/logger';
import { createOpenAIClient, getProviderDefaultHeaders } from '../openaiClient';
import { CompletionAdapter, CompletionInput, CompletionResult, observeSdkRequest, assertReadOnlyAssessmentInput } from './types';
import { withTransientRetry } from '@/backend/utils/transientRetry';
import { v4 as uuidv4 } from 'uuid';
import type { ModelMediaPart } from '@/shared/types/model/media';
import { mediaTypeFromMime } from '@/shared/types/model/media';
import { parseDataUrl } from './messageUtils';
import { supportsExplicitOpenAiPromptCaching } from './openaiPromptCaching';
import { getCurrentWorkspace } from '@/utils/workspace';
import { assertExecutionExtensionConcreteAdapter } from '@/backend/execution/extensions';
import { digestCanonicalJson } from '@/backend/execution/flow/compaction/digest';
import { inspectJson } from '@/backend/execution/flow/compaction/jsonInspection';
import { validateResponsesSession, cloneResponsesJson, responsesReplayInput, MAX_RESPONSES_SESSION_CHARS,
  type ResponsesReplayRecord, type ResponsesSessionState } from './responsesSessionState';
import {
  buildProviderToolNameTranslation,
  translateCompletionFromProvider,
  translateMessagesForProvider,
  translateToolsForProvider,
} from './providerToolNames';

const log = createLogger('backend/services/model/adapters/openaiResponsesAdapter');

/**
 * The OpenAI **Responses API** adapter — an ALTERNATIVE to OpenAiAdapter, not a
 * replacement for it.
 *
 * Why it exists, and why it is not the default:
 *
 * Responses is OpenAI's recommended surface for new work, but switching to it buys
 * no token saving on its own. Its headline feature — server-side conversation
 * state via `previous_response_id` / the Conversations API — saves BANDWIDTH, not
 * tokens: OpenAI still bills the full accumulated context as input on every turn.
 * The only real cost reduction is the cached-input discount, which is the same
 * automatic prefix cache the Chat Completions path already gets.
 *
 * Worse, server-side state is append-only, and FLUJO deliberately REWRITES its
 * wire history every turn: compactForWire rewrites old oversized tool results into
 * `flujo://run/...` pointers, collapseNodeOutputs drops other nodes' settled
 * exchanges, stripHandoffPlumbing removes handoff calls, and isolated /
 * latest-message input modes synthesize an entirely different history per node.
 * A `previous_response_id` chain would have to be abandoned and rebuilt on each of
 * those, which is strictly worse than sending the array. Note that FLUJO's own
 * compaction is the thing genuinely reducing tokens here — and it is exactly what
 * the server-side state model cannot accommodate.
 *
 * So this adapter is deliberately STATELESS: `store: false`, no
 * `previous_response_id`, full input array every turn — same as the Chat
 * Completions path. What it actually buys is **reasoning-item persistence**. On
 * gpt-5 / o-series models, Chat Completions discards the reasoning trace between
 * turns, so within one agentic tool loop the model re-derives its own reasoning on
 * every iteration. Responses can return encrypted reasoning items
 * (`include: ['reasoning.encrypted_content']`) which are fed back on the next
 * turn — better answers on multi-step tool use, fewer wasted output tokens, and a
 * longer stable prefix. Complete native output also retains assistant phases
 * and item ordering that the Chat Completion projection cannot represent.
 *
 * Everything is translated to and from the OpenAI **Chat Completion** shape, so
 * ModelHandler, ToolHandler, the usage mapping and the tool-call plumbing are
 * untouched (the same contract every other adapter honours).
 */

// ---------------------------------------------------------------------------
// Reasoning-item carry-over
// ---------------------------------------------------------------------------

/**
 * Preserve the complete output window, including interleaved reasoning, calls,
 * message IDs and phases. Its exact canonical prefix/assistant projection and
 * actual native input must still match before it replaces a reconstructed turn.
 * Tool IDs alone cannot establish that lineage. Final answers need no tool ID.
 * This bounded, disposable cache never replaces the canonical conversation.
 */
type ReasoningItem = OpenAI.Responses.ResponseReasoningItem;

type ReasoningRecord = ResponsesReplayRecord;
interface ReasoningSession {
  owner: string;
  anchors: Map<string, ReasoningRecord>;
}

/** Calls without a conversation checkpoint retain only this disposable cache. */
const MAX_TRACKED_SESSIONS = 200;
const MAX_SESSION_OUTPUT_CHARS = MAX_RESPONSES_SESSION_CHARS;
const reasoningByWorkspace = new Map<string, Map<string, ReasoningSession>>();

function reasoningBySession(): Map<string, ReasoningSession> {
  const workspace = getCurrentWorkspace();
  let value = reasoningByWorkspace.get(workspace);
  if (!value) {
    value = new Map();
    reasoningByWorkspace.set(workspace, value);
  }
  return value;
}

const sessionKey = (conversationId?: string, nodeId?: string): string | undefined =>
  conversationId ? JSON.stringify([conversationId, nodeId ?? null]) : undefined;

type ReasoningInput = Pick<CompletionInput, 'model' | 'apiKey' | 'messages' | 'tools'
  | 'conversationId' | 'nodeId' | 'toolNameMap' | 'responsesSession' | 'onResponsesSessionChange' | 'signal'>;

/** Capture ownership before dispatch so a late response cannot overwrite a
 * replacement route or a forgotten session. Only unchanged provider-visible
 * prefixes can carry opaque state; a call ID alone is not source lineage. */
export function prepareResponsesReasoning(input: ReasoningInput, adapter: string): {
  carried: Map<string, ReasoningItem[]> | undefined;
  replay: (translated: ResponseInputItem[]) => ResponseInputItem[];
  remember: (completion: OpenAI.Chat.Completions.ChatCompletion, items: ReasoningItem[],
    output?: OpenAI.Responses.ResponseOutputItem[]) => void;
} {
  const key = sessionKey(input.conversationId, input.nodeId);
  if (!key) return { carried: undefined, replay: translated => translated, remember: () => undefined };
  // Capture the workspace store now, rather than rereading async context when
  // the provider eventually finishes. Credential bytes are never retained.
  const sessions = reasoningBySession();
  const workspace = getCurrentWorkspace();
  const owner = digestCanonicalJson({ policy: 'responses-output-v2', adapter,
    connection: input.model.id, model: input.model.name, provider: input.model.provider,
    baseUrl: input.model.baseUrl, credential: input.apiKey,
    reasoningEffort: input.model.reasoningEffort, outputModalities: input.model.outputModalities,
    tools: input.tools ?? [], toolNameMap: input.toolNameMap ?? {} });
  let session = sessions.get(key);
  // A conversation checkpoint is authoritative over the disposable cache. A
  // reload/revert must never resurrect a newer process-local sibling, and each
  // admitted invocation fences late publications from an older checkpoint.
  if (input.onResponsesSessionChange || session?.owner !== owner) {
    const restored = input.onResponsesSessionChange ? validateResponsesSession(input.responsesSession, {
      workspace, conversationId: input.conversationId!, nodeId: input.nodeId, owner,
    }) : undefined;
    session = { owner, anchors: new Map(restored?.records) };
    sessions.delete(key);
    if (sessions.size >= MAX_TRACKED_SESSIONS) {
      const oldest = sessions.keys().next();
      if (!oldest.done) sessions.delete(oldest.value);
    }
    sessions.set(key, session);
  }
  // Refresh insertion order for an active unchanged owner too.
  sessions.delete(key);
  sessions.set(key, session);
  const current = toResponsesInput(input.messages);
  const inputDigest = digestCanonicalJson(current);
  let nativeInputDigest = inputDigest;
  const carried = new Map<string, ReasoningItem[]>();
  const windows = new Map<string, ReasoningRecord>();
  for (const [callId, record] of session.anchors) {
    const end = record.inputLength + record.outputLength;
    if ((record.nativeOutput && !responsesReplayInput(record.nativeOutput)) || current.length < end
      || digestCanonicalJson(current.slice(0, record.inputLength)) !== record.inputDigest
      || digestCanonicalJson(current.slice(record.inputLength, end)) !== record.outputDigest) {
      session.anchors.delete(callId);
    } else {
      windows.set(callId, record);
      const items = record.nativeOutput?.filter((item): item is ReasoningItem =>
        item.type === 'reasoning' && !!item.encrypted_content) ?? record.items;
      if (items.length && record.callId) carried.set(record.callId, structuredClone(items));
    }
  }
  const ownedSession = session;
  const publish = () => {
    if (!input.onResponsesSessionChange || input.signal?.aborted || sessions.get(key) !== ownedSession) return;
    const snapshot: ResponsesSessionState = { version: 1, workspace,
      conversationId: input.conversationId!, nodeId: input.nodeId, owner,
      recordsDigest: '0'.repeat(64), records: [...ownedSession.anchors] };
    // Include record metadata in the durable limit as well as native bytes.
    while (snapshot.records.length && inspectJson(snapshot) > MAX_SESSION_OUTPUT_CHARS) {
      const [oldest] = snapshot.records.shift()!;
      ownedSession.anchors.delete(oldest);
    }
    snapshot.recordsDigest = digestCanonicalJson(snapshot.records);
    input.onResponsesSessionChange(validateResponsesSession(snapshot, {
      workspace, conversationId: input.conversationId!, nodeId: input.nodeId, owner,
    }));
  };
  publish();
  return { carried, replay: translated => {
    if (!windows.size) {
      nativeInputDigest = digestCanonicalJson(translated);
      return translated;
    }
    const replayed: ResponseInputItem[] = [];
    const append = (items: ResponseInputItem[]) => { for (const item of items) replayed.push(item); };
    let cursor = 0;
    for (const [anchor, record] of [...windows].sort((a, b) => a[1].inputLength - b[1].inputLength)) {
      const start = record.inputLength;
      if (start < cursor) continue;
      append(translated.slice(cursor, start));
      const end = start + record.outputLength;
      // A previous native window can disappear or be replaced while its plain
      // text stays identical. Descendants must not replay against that new input.
      if (record.nativeInputDigest && digestCanonicalJson(replayed) !== record.nativeInputDigest) {
        if (sessions.get(key) === ownedSession) ownedSession.anchors.delete(anchor);
        append(translated.slice(start, end));
      } else if (record.nativeOutput) {
        append(responsesReplayInput(structuredClone(record.nativeOutput))!);
      } else {
        append(structuredClone(record.items));
        append(translated.slice(start, end));
      }
      cursor = end;
    }
    append(translated.slice(cursor));
    nativeInputDigest = digestCanonicalJson(replayed);
    publish();
    return replayed;
  }, remember: (completion, items, nativeOutput) => {
    const message = completion.choices[0]?.message;
    const callId = message?.tool_calls?.[0]?.id;
    if (!message || input.signal?.aborted || sessions.get(key) !== ownedSession) return;
    const output = toResponsesInput([message]);
    if (!output.length || (!nativeOutput?.length && (!callId || !items.length))) return;
    const outputDigest = digestCanonicalJson(output);
    const anchor = callId ? JSON.stringify(['call', callId]) : JSON.stringify(['turn', current.length, outputDigest]);
    ownedSession.anchors.delete(anchor);
    const retainedChars = inspectJson(nativeOutput ?? items);
    if (retainedChars > MAX_SESSION_OUTPUT_CHARS || (nativeOutput && !responsesReplayInput(nativeOutput))) { publish(); return; }
    ownedSession.anchors.set(anchor, { callId, items: nativeOutput ? [] : cloneResponsesJson(items),
      ...(nativeOutput ? { nativeOutput: cloneResponsesJson(nativeOutput), nativeInputDigest } : {}),
      retainedChars, inputLength: current.length, inputDigest, outputLength: output.length, outputDigest });
    let retained = [...ownedSession.anchors.values()].reduce((sum, record) => sum + record.retainedChars, 0);
    while (ownedSession.anchors.size > 64 || retained > MAX_SESSION_OUTPUT_CHARS) {
      const oldest = ownedSession.anchors.keys().next();
      if (oldest.done) break;
      retained -= ownedSession.anchors.get(oldest.value)!.retainedChars;
      ownedSession.anchors.delete(oldest.value);
    }
    publish();
  } };
}

/** Drop a session's carried reasoning (housekeeping / tests). */
export function forgetReasoning(conversationId: string, nodeId?: string): void {
  const key = sessionKey(conversationId, nodeId);
  if (key) reasoningBySession().delete(key);
}

/** Test seam: clear all carried reasoning. */
export function __resetReasoningStore(): void {
  reasoningBySession().clear();
}

// ---------------------------------------------------------------------------
// Request translation: Chat Completions shape -> Responses input
// ---------------------------------------------------------------------------

type ResponseInputItem = OpenAI.Responses.ResponseInputItem;

/** Mark the latest reusable history boundaries after wire translation. The
 * late node instruction stays unmarked, and encrypted reasoning stays intact. */
export function withResponsesCacheBreakpoints(input: ResponseInputItem[]): ResponseInputItem[] {
  const cacheableTypes = new Set(['input_text', 'input_image', 'input_file']);
  const candidates: number[] = [];
  input.forEach((item, index) => {
    const record = item as unknown as Record<string, unknown>;
    if (record.role === 'system' || record.role === 'developer') return;
    const content = record.type === 'function_call_output' ? record.output : record.content;
    if ((typeof content === 'string' && content.length > 0) || (Array.isArray(content) &&
      content.some(part => part && typeof part === 'object' && cacheableTypes.has(part.type)))) candidates.push(index);
  });
  const marked = new Set(candidates.slice(-4));
  return input.map((item, index) => {
    if (!marked.has(index)) return item;
    const record = item as unknown as Record<string, unknown>;
    const field = record.type === 'function_call_output' ? 'output' : 'content';
    const content = record[field];
    const parts = typeof content === 'string' ? [{ type: 'input_text', text: content }] : content as Record<string, unknown>[];
    const boundary = parts.findLastIndex(part => part && cacheableTypes.has(String(part.type)));
    return { ...record, [field]: parts.map((part, partIndex) => partIndex === boundary
      ? { ...part, prompt_cache_breakpoint: { mode: 'explicit' } } : part) } as unknown as ResponseInputItem;
  });
}

/** Flatten a Chat Completions `content` field to plain text. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const p = part as { type?: string; text?: string };
      return p?.type === 'text' && typeof p.text === 'string' ? p.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Translate a user turn, preserving images. Responses renames the multipart part
 * types (`text` -> `input_text`, `image_url` -> `input_image`) and takes the image
 * URL as a bare string rather than a nested object.
 */
function userContent(content: unknown): ResponseInputItem {
  if (typeof content === 'string' || !Array.isArray(content)) {
    return { role: 'user', content: textOf(content) };
  }
  const parts = content
    .map((part) => {
      const p = part as {
        type?: string;
        text?: string;
        image_url?: { url?: string; detail?: 'auto' | 'low' | 'high' };
        input_audio?: { data?: string; format?: string };
        audio_url?: { url?: string };
        video_url?: { url?: string };
        file?: {
          url?: string;
          file_data?: string;
          name?: string;
          filename?: string;
        };
      };
      if (p?.type === 'text' && typeof p.text === 'string') {
        return { type: 'input_text' as const, text: p.text };
      }
      if (p?.type === 'image_url' && typeof p.image_url?.url === 'string') {
        return {
          type: 'input_image' as const,
          image_url: p.image_url.url,
          detail: p.image_url.detail ?? ('auto' as const),
        };
      }
      if (p?.type === 'input_audio' && typeof p.input_audio?.data === 'string') {
        return {
          type: 'input_audio' as const,
          data: p.input_audio.data,
          format: p.input_audio.format === 'mp3' ? 'mp3' as const : 'wav' as const,
        };
      }
      if (p?.type === 'audio_url' && typeof p.audio_url?.url === 'string') {
        const parsed = parseDataUrl(p.audio_url.url);
        if (parsed) {
          const format = parsed.mimeType === 'audio/mpeg'
            ? 'mp3' as const
            : parsed.mimeType === 'audio/wav' || parsed.mimeType === 'audio/x-wav'
              ? 'wav' as const
              : undefined;
          if (format) {
            return {
              type: 'input_audio' as const,
              data: parsed.base64,
              format,
            };
          }
          return {
            type: 'input_text' as const,
            text: `[${parsed.mimeType} audio attachment omitted: OpenAI input_audio accepts only MP3 or WAV]`,
          };
        }
      }
      if (p?.type === 'file' || p?.type === 'video_url') {
        const source = p.type === 'file'
          ? p.file?.file_data ?? p.file?.url
          : p.video_url?.url;
        if (typeof source === 'string') {
          return {
            type: 'input_file' as const,
            file_data: source,
            filename:
              p.file?.filename ??
              p.file?.name ??
              (p.type === 'video_url' ? 'video' : 'attachment'),
          };
        }
      }
      return undefined;
    })
    .filter((p): p is NonNullable<typeof p> => p !== undefined);

  return {
    role: 'user',
    content: parts,
  } as unknown as ResponseInputItem;
}

/**
 * Translate FLUJO's Chat-Completions-shaped wire history into a Responses `input`
 * array, re-inserting any carried reasoning items ahead of the tool call they
 * belong to.
 *
 * Shape differences that matter:
 *  - an assistant turn's `tool_calls` become sibling `function_call` items rather
 *    than a field on the message;
 *  - a `role: 'tool'` message becomes a `function_call_output` item;
 *  - `tool_call_id` is spelled `call_id`.
 */
export function toResponsesInput(
  messages: OpenAI.ChatCompletionMessageParam[],
  carriedReasoning?: Map<string, ReasoningItem[]>,
): ResponseInputItem[] {
  const input: ResponseInputItem[] = [];
  // Re-emit each stashed reasoning group at most once per request, even if the
  // same anchor somehow appears twice.
  const emitted = new Set<string>();

  for (const message of messages) {
    switch (message.role) {
      case 'system':
      case 'developer':
        input.push({ role: 'system', content: textOf(message.content) });
        break;

      case 'user':
        input.push(userContent(message.content));
        break;

      case 'assistant': {
        const toolCalls = (message.tool_calls ?? []).filter(
          (c): c is OpenAI.ChatCompletionMessageFunctionToolCall => (c as { type?: string }).type === 'function',
        );

        // Reasoning must precede the function calls of the turn it belongs to.
        const anchor = toolCalls[0]?.id;
        if (anchor && carriedReasoning?.has(anchor) && !emitted.has(anchor)) {
          emitted.add(anchor);
          for (const item of carriedReasoning.get(anchor)!) {
            input.push(item as unknown as ResponseInputItem);
          }
        }

        const text = textOf(message.content);
        if (text) {
          input.push({ role: 'assistant', content: text });
        }
        for (const call of toolCalls) {
          input.push({
            type: 'function_call',
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          });
        }
        break;
      }

      case 'tool':
        input.push({
          type: 'function_call_output',
          call_id: message.tool_call_id,
          output: textOf(message.content),
        });
        break;

      default:
        // 'function' (long-deprecated) and anything future: fall back to text so a
        // stray message can never silently vanish from the model's view.
        input.push({ role: 'user', content: textOf((message as { content?: unknown }).content) });
    }
  }

  return input;
}

/**
 * Translate tool definitions. Responses flattens the nested `function` object of
 * the Chat Completions shape onto the tool itself.
 *
 * `strict: false` is explicit: strict mode requires every property to be required
 * and `additionalProperties: false` throughout, which arbitrary MCP server schemas
 * do not satisfy. Sending strict tools would 400 on a large share of real servers.
 */
export function toResponsesTools(
  tools: OpenAI.ChatCompletionFunctionTool[] | undefined,
): OpenAI.Responses.Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools
    .filter((t) => t.type === 'function')
    .map((t) => ({
      type: 'function' as const,
      name: t.function.name,
      description: t.function.description ?? `Tool: ${t.function.name}`,
      parameters: (t.function.parameters ?? { type: 'object', properties: {} }) as Record<string, unknown>,
      strict: false,
    }));
}

// ---------------------------------------------------------------------------
// Response translation: Responses output -> Chat Completion shape
// ---------------------------------------------------------------------------

/**
 * Map `finish_reason`. Responses reports completion differently: an `incomplete`
 * status with reason `max_output_tokens` is the equivalent of Chat Completions'
 * `length`, and the presence of function calls means `tool_calls`.
 */
function finishReasonOf(
  response: OpenAI.Responses.Response,
  hasToolCalls: boolean,
): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
  if (response.status === 'incomplete') {
    const reason = response.incomplete_details?.reason;
    if (reason === 'max_output_tokens') return 'length';
    if (reason === 'content_filter') return 'content_filter';
  }
  return hasToolCalls ? 'tool_calls' : 'stop';
}

/**
 * Convert a Responses result into the OpenAI ChatCompletion shape the rest of
 * FLUJO consumes, including a `usage` block in Chat Completions' spelling so
 * `mapOpenAiUsage` (and therefore the context meter and the cache metrics) works
 * unchanged. Responses names the fields `input_tokens` / `output_tokens` and nests
 * the cached count under `input_tokens_details`.
 */
export function fromResponse(
  response: OpenAI.Responses.Response,
  modelName: string,
): {
  completion: OpenAI.Chat.Completions.ChatCompletion;
  reasoning: ReasoningItem[];
  media: ModelMediaPart[];
} {
  if (response.error || response.status === 'failed' || response.status === 'cancelled'
    || response.status === 'queued' || response.status === 'in_progress') {
    // HTTP 200 and streamed partial output do not confirm a usable reply. Keep
    // both completion paths from exposing tool calls or advancing checkpoints.
    // This can be an HTTP 200 with a failed response envelope. Preserve the
    // upstream code and bounded metadata through ModelHandler's API-error path;
    // do not invent an HTTP status or retain partial output/tool arguments.
    throw new OpenAI.APIError(undefined, {
      ...response.error,
      message: 'The AI provider did not complete the reply'
        + (response.error?.message ? `: ${response.error.message}` : ` (${response.status})`),
      code: response.error?.code || 'provider_response_not_completed',
      type: 'provider_response_error',
      responseStatus: response.status,
      responseId: response.id,
      model: response.model || modelName,
      incompleteReason: response.incomplete_details?.reason,
    }, 'The AI provider did not complete the reply'
      + (response.error?.message ? `: ${response.error.message}` : ` (${response.status})`), undefined);
  }
  const textParts: string[] = [];
  const toolCalls: OpenAI.ChatCompletionMessageFunctionToolCall[] = [];
  const reasoning: ReasoningItem[] = [];
  const media: ModelMediaPart[] = [];

  for (const item of response.output ?? []) {
    const nativeItem = item as unknown as Record<string, unknown>;
    if (nativeItem.type === 'message') {
      const content = Array.isArray(nativeItem.content) ? nativeItem.content : [];
      for (const rawPart of content) {
        if (!rawPart || typeof rawPart !== 'object') continue;
        const part = rawPart as Record<string, unknown>;
        if (part.type === 'output_text' && typeof part.text === 'string') {
          textParts.push(part.text);
        } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
          textParts.push(part.refusal);
        } else if (part.type === 'output_audio' && typeof part.data === 'string') {
          const mimeType = typeof part.mime_type === 'string' ? part.mime_type : 'audio/mpeg';
          media.push({
            type: 'audio',
            data: part.data,
            mimeType,
            ...(typeof part.transcript === 'string' ? { transcript: part.transcript } : {}),
          });
        }
      }
    } else if (nativeItem.type === 'image_generation_call' && typeof nativeItem.result === 'string') {
      media.push({ type: 'image', data: nativeItem.result, mimeType: 'image/png' });
    } else if (nativeItem.type === 'video_generation_call') {
      const result = nativeItem.result && typeof nativeItem.result === 'object'
        ? nativeItem.result as Record<string, unknown>
        : undefined;
      const url = nativeItem.url ?? result?.url;
      const data = nativeItem.data ?? result?.data;
      if (typeof url === 'string' || typeof data === 'string') {
        const rawMimeType = nativeItem.mime_type ?? result?.mime_type;
        media.push({
          type: 'video',
          ...(typeof url === 'string' ? { url } : {}),
          ...(typeof data === 'string' ? { data } : {}),
          mimeType: typeof rawMimeType === 'string' ? rawMimeType : 'video/mp4',
        });
      }
    } else if (nativeItem.type === 'file' || nativeItem.type === 'output_file') {
      const url = nativeItem.url ?? nativeItem.file_url;
      const data = nativeItem.data;
      const rawMimeType = nativeItem.mime_type ?? nativeItem.mimeType;
      const mimeType = typeof rawMimeType === 'string' ? rawMimeType : undefined;
      const name = typeof nativeItem.filename === 'string' ? nativeItem.filename : undefined;
      if (typeof url === 'string' || typeof data === 'string') {
        media.push({
          type: mediaTypeFromMime(mimeType),
          ...(typeof url === 'string' ? { url } : {}),
          ...(typeof data === 'string' ? { data } : {}),
          ...(mimeType ? { mimeType } : {}),
          ...(name ? { name } : {}),
        });
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        // `call_id` is the id the follow-up function_call_output must reference;
        // `id` identifies the output item itself and is NOT interchangeable.
        id: item.call_id,
        type: 'function',
        function: { name: item.name, arguments: item.arguments },
      });
    } else if (item.type === 'reasoning') {
      // Only encrypted items are re-sendable; a summary-only item is not.
      if (item.encrypted_content) reasoning.push(item);
    }
  }

  const usage = response.usage;
  const completion: OpenAI.Chat.Completions.ChatCompletion = {
    id: response.id,
    object: 'chat.completion',
    created: response.created_at ?? 0,
    model: response.model ?? modelName,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: textParts.length > 0 ? textParts.join('') : null,
          refusal: null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReasonOf(response, toolCalls.length > 0),
        logprobs: null,
      },
    ],
    ...(usage
      ? {
          usage: {
            prompt_tokens: usage.input_tokens ?? 0,
            completion_tokens: usage.output_tokens ?? 0,
            total_tokens: usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
            ...(usage.input_tokens_details
              ? {
                  prompt_tokens_details: {
                    cached_tokens: usage.input_tokens_details.cached_tokens ?? 0,
                    cache_write_tokens: usage.input_tokens_details.cache_write_tokens ?? 0,
                  },
                }
              : {}),
            ...(usage.output_tokens_details
              ? {
                  completion_tokens_details: {
                    reasoning_tokens: usage.output_tokens_details.reasoning_tokens ?? 0,
                  },
                }
              : {}),
          },
        }
      : {}),
  };

  return { completion, reasoning, media };
}

// ---------------------------------------------------------------------------
// Optional-parameter negotiation
// ---------------------------------------------------------------------------

/**
 * Request parameters that are valuable but not universally accepted, and which
 * must never break a call:
 *  - `include`             — reasoning-item carry-over; rejected by non-reasoning models
 *  - `temperature`         — reasoning models reject anything other than the default
 *  - `prompt_cache_key`    — cache-shard routing; absent from older gateways
 *  - `parallel_tool_calls` — unsupported on some models
 *
 * Rather than guessing from model-name patterns (which go stale every release),
 * each is sent optimistically and dropped PERMANENTLY for that (endpoint, model)
 * the first time the provider rejects it by name. Costs at most one retried
 * request per parameter per model per process.
 */
const DROPPABLE = ['include', 'temperature', 'prompt_cache_key', 'prompt_cache_options', 'parallel_tool_calls'] as const;
type Droppable = (typeof DROPPABLE)[number];

const unsupportedParams = new Map<string, Set<Droppable>>();

const paramKey = (model: { provider?: string; baseUrl?: string; name: string }) =>
  `${model.provider ?? 'openai'}|${model.baseUrl ?? ''}|${model.name}`;

/** Test seam: clear negotiated parameter support. */
export function __resetParamNegotiation(): void {
  unsupportedParams.clear();
}

/**
 * Which droppable parameter (if any) a 400/422 is complaining about. Returns
 * undefined for errors that are not about an unsupported parameter, so genuine
 * failures propagate instead of being masked by retries.
 */
function rejectedParam(err: unknown, alreadyDropped: Set<Droppable>): Droppable | undefined {
  const status = (err as { status?: number })?.status;
  if (status !== 400 && status !== 422) return undefined;

  const haystack = [
    (err as { message?: string })?.message,
    JSON.stringify((err as { error?: unknown })?.error ?? ''),
  ]
    .join(' ')
    .toLowerCase();

  const looksUnsupported =
    haystack.includes('unsupported') ||
    haystack.includes('unknown') ||
    haystack.includes('unrecognized') ||
    haystack.includes('not supported') ||
    haystack.includes('does not support') ||
    haystack.includes('not allowed') ||
    haystack.includes('invalid_value') ||
    haystack.includes('additional') ||
    haystack.includes('extra');
  if (!looksUnsupported) return undefined;

  for (const param of DROPPABLE) {
    if (alreadyDropped.has(param)) continue;
    // `include` is also named via the value that triggered it.
    const mentioned =
      haystack.includes(param) ||
      (param === 'include' && haystack.includes('encrypted_content')) ||
      (param === 'prompt_cache_options' && haystack.includes('prompt_cache_breakpoint'));
    if (mentioned) return param;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class OpenAiResponsesAdapter implements CompletionAdapter {
  async createCompletion(assessmentInput: CompletionInput): Promise<CompletionResult> {
    assertReadOnlyAssessmentInput(assessmentInput);
    const {
    model,
    apiKey,
    messages,
    tools,
    temperature,
    maxTokens,
    signal,
    onProviderAttempt,
    onSdkRequest,
    onSdkRequestResult,
    conversationId,
    nodeId,
    responsesSession,
    onResponsesSessionChange,
    promptCacheKey,
    promptCacheMode,
    toolNameMap,
    executionExtensionContext,
    readOnlyAssessment,
    } = assessmentInput;
    await assertExecutionExtensionConcreteAdapter(executionExtensionContext, model, 'openai-responses');
    const openai = createOpenAIClient({
      apiKey,
      baseURL: model.baseUrl,
      defaultHeaders: getProviderDefaultHeaders(model.provider),
    });

    const reasoningState = prepareResponsesReasoning({ model, apiKey, messages, tools,
      conversationId, nodeId, toolNameMap, responsesSession, onResponsesSessionChange, signal }, 'openai-responses');

    const toolNames = buildProviderToolNameTranslation(tools, toolNameMap);
    const input = reasoningState.replay(toResponsesInput(translateMessagesForProvider(messages, toolNames)));
    const responsesTools = toResponsesTools(translateToolsForProvider(tools, toolNames));
    const wantsImage = (model.outputModalities ?? [])
      .some(modality => modality.toLowerCase() === 'image');
    const allTools: OpenAI.Responses.Tool[] = [
      ...(responsesTools ?? []),
      ...(wantsImage ? [{ type: 'image_generation' as const }] : []),
    ];
    const pk = paramKey(model);
    const dropped = unsupportedParams.get(pk) ?? new Set<Droppable>();
    const explicitCache = promptCacheMode === 'explicit' && supportsExplicitOpenAiPromptCaching(model);

    const buildBody = (omit: Set<Droppable>): Record<string, unknown> => ({
      model: model.name,
      input: explicitCache && !omit.has('prompt_cache_options')
        ? withResponsesCacheBreakpoints(input) : input,
      // Stateless by design — FLUJO owns the history and rewrites it every turn,
      // which an append-only server-side thread cannot represent.
      store: false,
      ...(explicitCache && !omit.has('prompt_cache_options')
        ? { prompt_cache_options: { mode: 'explicit' } } : {}),
      ...(allTools.length ? { tools: allTools } : {}),
      ...(typeof maxTokens === 'number' ? { max_output_tokens: maxTokens } : {}),
      ...(omit.has('temperature') ? {} : { temperature }),
      ...(model.reasoningEffort ? { reasoning: { effort: model.reasoningEffort } } : {}),
      // The point of this adapter: get the reasoning trace back so the next turn
      // of the loop doesn't re-derive it.
      ...(omit.has('include') ? {} : { include: ['reasoning.encrypted_content'] }),
      ...(omit.has('prompt_cache_key') || !promptCacheKey ? {} : { prompt_cache_key: promptCacheKey }),
    });

    log.debug('createCompletion via OpenAI Responses API', {
      model: model.name,
      baseUrl: model.baseUrl,
      inputItems: input.length,
      toolCount: responsesTools?.length ?? 0,
      carriedReasoningAnchors: reasoningState.carried?.size ?? 0,
      droppedParams: Array.from(dropped),
    });

    const send = (omit: Set<Droppable>) => {
      const body = buildBody(omit);
      return withTransientRetry(
        () => observeSdkRequest(
          { onSdkRequest, onSdkRequestResult, signal },
          { adapter: 'openai-responses', operation: 'responses.create', request: body },
          async () => {
            const response = await openai.responses.create(
              body as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming,
              readOnlyAssessment ? { signal, maxRetries: 0, fetchOptions: { redirect: 'error' as const } } : signal ? { signal } : undefined,
            );
            // Failed envelopes must also close the dispatch archive as errors.
            fromResponse(response, model.name);
            return response;
          },
        ),
        { signal, onAttempt: onProviderAttempt, ...(readOnlyAssessment ? { maxAttempts: 1 } : {}) },
      ) as Promise<OpenAI.Responses.Response>;
    };

    // Negotiate away unsupported optional parameters, one per rejection. Bounded
    // by the number of droppable parameters, so this cannot spin.
    const omit = new Set(dropped);
    let response: OpenAI.Responses.Response | undefined;
    for (let attempt = 0; attempt <= DROPPABLE.length; attempt++) {
      try {
        response = await send(omit);
        break;
      } catch (error) {
        if (readOnlyAssessment) throw error;
        const param = rejectedParam(error, omit);
        if (!param) throw error;
        omit.add(param);
        unsupportedParams.set(pk, new Set(omit));
        log.warn('Responses API rejected an optional parameter; dropping it and retrying', {
          param,
          model: model.name,
          provider: model.provider,
        });
      }
    }
    if (!response) {
      // Only reachable if every attempt was consumed by a fresh rejection.
      throw new Error('OpenAI Responses API rejected every supported parameter combination');
    }

    const translated = fromResponse(response, model.name);
    const completion = translateCompletionFromProvider(translated.completion, toolNames);
    const { reasoning, media } = translated;

    if (response.status === 'completed') reasoningState.remember(completion, reasoning, response.output);

    return { completion, media, contextUsage: contextUsageFromCompletion(completion.usage, model.contextWindow) };
  }

  async createStreamCompletion({
    model,
    apiKey,
    messages,
    tools,
    temperature,
    maxTokens,
    signal,
    conversationId,
    nodeId,
    responsesSession,
    onResponsesSessionChange,
    promptCacheKey,
    promptCacheMode,
    onModelDelta,
    onSdkRequest,
    onSdkRequestResult,
    toolNameMap,
    executionExtensionContext,
    readOnlyAssessment,
  }: CompletionInput): Promise<CompletionResult> {
    if (readOnlyAssessment) throw new Error('Read-only assessment does not support streaming.');
    await assertExecutionExtensionConcreteAdapter(executionExtensionContext, model, 'openai-responses');
    const openai = createOpenAIClient({
      apiKey,
      baseURL: model.baseUrl,
      defaultHeaders: getProviderDefaultHeaders(model.provider),
    });
    const reasoningState = prepareResponsesReasoning({ model, apiKey, messages, tools,
      conversationId, nodeId, toolNameMap, responsesSession, onResponsesSessionChange, signal }, 'openai-responses');
    const toolNames = buildProviderToolNameTranslation(tools, toolNameMap);
    const input = reasoningState.replay(toResponsesInput(translateMessagesForProvider(messages, toolNames)));
    const responsesTools = toResponsesTools(translateToolsForProvider(tools, toolNames));
    const wantsImage = (model.outputModalities ?? [])
      .some(modality => modality.toLowerCase() === 'image');
    const allTools: OpenAI.Responses.Tool[] = [
      ...(responsesTools ?? []),
      ...(wantsImage ? [{ type: 'image_generation' as const }] : []),
    ];
    const pk = paramKey(model);
    const dropped = unsupportedParams.get(pk) ?? new Set<Droppable>();
    const liveMessageId = `stream_${uuidv4()}`;
    let streamedMedia: ModelMediaPart[] = [];
    const explicitCache = promptCacheMode === 'explicit' && supportsExplicitOpenAiPromptCaching(model);

    const buildBody = (omit: Set<Droppable>): Record<string, unknown> => ({
      model: model.name,
      input: explicitCache && !omit.has('prompt_cache_options')
        ? withResponsesCacheBreakpoints(input) : input,
      store: false,
      ...(explicitCache && !omit.has('prompt_cache_options')
        ? { prompt_cache_options: { mode: 'explicit' } } : {}),
      stream: true,
      ...(allTools.length ? { tools: allTools } : {}),
      ...(typeof maxTokens === 'number' ? { max_output_tokens: maxTokens } : {}),
      ...(omit.has('temperature') ? {} : { temperature }),
      ...(model.reasoningEffort ? { reasoning: { effort: model.reasoningEffort } } : {}),
      ...(omit.has('include') ? {} : { include: ['reasoning.encrypted_content'] }),
      ...(omit.has('prompt_cache_key') || !promptCacheKey ? {} : { prompt_cache_key: promptCacheKey }),
    });

    const consume = async (omit: Set<Droppable>): Promise<OpenAI.Responses.Response> => {
      const body = buildBody(omit);
      const stream = await observeSdkRequest(
        { onSdkRequest, onSdkRequestResult, signal },
        { adapter: 'openai-responses', operation: 'responses.create(stream)', request: body },
        async () => {
          const stream = await openai.responses.create(
            body as unknown as OpenAI.Responses.ResponseCreateParamsStreaming,
            signal ? { signal } : undefined,
          );
          return (async function* () {
            let terminal = false;
            for await (const event of stream) {
              if (event.type === 'response.completed' || event.type === 'response.failed'
                || event.type === 'response.incomplete') {
                terminal = true;
                fromResponse(event.response, model.name);
              }
              yield event;
            }
            if (!terminal) throw new OpenAI.APIError(undefined, {
              code: 'provider_stream_incomplete', type: 'provider_response_error',
              message: 'OpenAI Responses stream ended without a terminal response',
            }, undefined, undefined);
          })();
        },
      );
      let response: OpenAI.Responses.Response | undefined;
      const toolIndexes = new Map<string, number>();
      let nextToolIndex = 0;
      const audioChunks: string[] = [];
      let audioTranscript = '';

      for await (const event of stream) {
        if (event.type === 'response.output_text.delta' && event.delta) {
          onModelDelta?.({ messageId: liveMessageId, contentDelta: event.delta });
        } else if (event.type === 'response.audio.delta') {
          audioChunks.push(event.delta);
        } else if (event.type === 'response.audio.transcript.delta') {
          audioTranscript += event.delta;
        } else if (
          event.type === 'response.output_item.added' &&
          event.item.type === 'function_call'
        ) {
          const index = nextToolIndex++;
          if (event.item.id) toolIndexes.set(event.item.id, index);
          onModelDelta?.({
            messageId: liveMessageId,
            toolCallDelta: {
              index,
              id: event.item.call_id,
              nameDelta: event.item.name,
            },
          });
        } else if (event.type === 'response.function_call_arguments.delta') {
          let index = toolIndexes.get(event.item_id);
          if (index == null) {
            index = event.output_index;
            toolIndexes.set(event.item_id, index);
            nextToolIndex = Math.max(nextToolIndex, index + 1);
          }
          if (event.delta) {
            onModelDelta?.({
              messageId: liveMessageId,
              toolCallDelta: { index, argumentsDelta: event.delta },
            });
          }
        } else if (event.type === 'response.completed' || event.type === 'response.failed'
          || event.type === 'response.incomplete') {
          response = event.response;
        }
      }
      if (!response) throw new OpenAI.APIError(undefined, {
        code: 'provider_stream_incomplete', type: 'provider_response_error', message: 'OpenAI Responses stream ended without a terminal response',
      }, 'OpenAI Responses stream ended without a terminal response', undefined);
      streamedMedia = audioChunks.length > 0
        ? [{
            type: 'audio',
            data: Buffer.concat(
              audioChunks.map(chunk => Buffer.from(chunk, 'base64')),
            ).toString('base64'),
            mimeType: 'audio/mpeg',
            ...(audioTranscript ? { transcript: audioTranscript } : {}),
          }]
        : [];
      return response;
    };

    const omit = new Set(dropped);
    let response: OpenAI.Responses.Response | undefined;
    for (let attempt = 0; attempt <= DROPPABLE.length; attempt++) {
      try {
        response = await consume(omit);
        break;
      } catch (error) {
        const param = rejectedParam(error, omit);
        if (!param) throw error;
        omit.add(param);
        unsupportedParams.set(pk, new Set(omit));
        log.warn('Responses streaming API rejected an optional parameter; dropping it and retrying', {
          param,
          model: model.name,
          provider: model.provider,
        });
      }
    }
    if (!response) {
      throw new Error('OpenAI Responses API rejected every supported parameter combination');
    }

    const translated = fromResponse(response, model.name);
    const completion = translateCompletionFromProvider(translated.completion, toolNames);
    const { reasoning, media } = translated;
    for (const part of streamedMedia) {
      if (!media.some(existing =>
        existing.type === part.type &&
        existing.data === part.data &&
        existing.url === part.url
      )) {
        media.push(part);
      }
    }
    for (const part of media) {
      onModelDelta?.({ messageId: liveMessageId, mediaPart: part });
    }
    if (response.status === 'completed') reasoningState.remember(completion, reasoning, response.output);
    return { completion, liveMessageId, media, contextUsage: contextUsageFromCompletion(completion.usage, model.contextWindow) };
  }
}
