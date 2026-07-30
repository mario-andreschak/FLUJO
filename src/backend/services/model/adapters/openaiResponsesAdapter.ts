import OpenAI from 'openai';
import { createLogger } from '@/utils/logger';
import { createOpenAIClient, getProviderDefaultHeaders } from '../openaiClient';
import { CompletionAdapter, CompletionInput, CompletionResult } from './types';
import { withTransientRetry } from '@/backend/utils/transientRetry';
import { v4 as uuidv4 } from 'uuid';
import type { ModelMediaPart } from '@/shared/types/model/media';
import { mediaTypeFromMime } from '@/shared/types/model/media';
import { parseDataUrl } from './messageUtils';

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
 * longer stable prefix. That is the whole reason to pick this adapter, and it only
 * matters for reasoning models.
 *
 * Everything is translated to and from the OpenAI **Chat Completion** shape, so
 * ModelHandler, ToolHandler, the usage mapping and the tool-call plumbing are
 * untouched (the same contract every other adapter honours).
 */

// ---------------------------------------------------------------------------
// Reasoning-item carry-over
// ---------------------------------------------------------------------------

/**
 * Encrypted reasoning items from a prior response, so the next turn of the same
 * agentic loop can hand the model back its own reasoning.
 *
 * The anchor is the `tool_call_id`. With `store: false` OpenAI's guidance is to
 * append the previous response's whole `output` array to the next input verbatim,
 * which keeps reasoning items positioned correctly relative to the function calls
 * they preceded. FLUJO can't do that literally — its history is Chat-Completion
 * shaped and gets rewritten between turns — but `tool_call_id` SURVIVES every one
 * of those rewrites. So the items are stashed against the first tool call of the
 * response that produced them, and re-emitted immediately before that same call
 * when the input is rebuilt. If the history rewriting drops that tool call
 * entirely, the reasoning is simply not re-sent, which is correct: it belonged to
 * an exchange the model is no longer being shown.
 */
type ReasoningItem = OpenAI.Responses.ResponseReasoningItem;

/** Bounded LRU-ish store, keyed by `${conversationId}|${nodeId}`. */
const MAX_TRACKED_SESSIONS = 200;
const reasoningBySession = new Map<string, Map<string, ReasoningItem[]>>();

const sessionKey = (conversationId?: string, nodeId?: string): string | undefined =>
  conversationId ? `${conversationId}|${nodeId ?? ''}` : undefined;

function stashReasoning(key: string, callId: string, items: ReasoningItem[]): void {
  let forSession = reasoningBySession.get(key);
  if (!forSession) {
    // Refresh insertion order so active sessions are not evicted first.
    if (reasoningBySession.size >= MAX_TRACKED_SESSIONS) {
      const oldest = reasoningBySession.keys().next();
      if (!oldest.done) reasoningBySession.delete(oldest.value);
    }
    forSession = new Map();
    reasoningBySession.set(key, forSession);
  }
  forSession.set(callId, items);
  // A single node's loop can make many tool calls; keep the map from growing
  // without bound over a very long run.
  if (forSession.size > 64) {
    const oldest = forSession.keys().next();
    if (!oldest.done) forSession.delete(oldest.value);
  }
}

/** Drop a session's carried reasoning (housekeeping / tests). */
export function forgetReasoning(conversationId: string, nodeId?: string): void {
  const key = sessionKey(conversationId, nodeId);
  if (key) reasoningBySession.delete(key);
}

/** Test seam: clear all carried reasoning. */
export function __resetReasoningStore(): void {
  reasoningBySession.clear();
}

// ---------------------------------------------------------------------------
// Request translation: Chat Completions shape -> Responses input
// ---------------------------------------------------------------------------

type ResponseInputItem = OpenAI.Responses.ResponseInputItem;

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
          return {
            type: 'input_audio' as const,
            data: parsed.base64,
            format: parsed.mimeType === 'audio/mpeg' ? 'mp3' as const : 'wav' as const,
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
          (c): c is OpenAI.ChatCompletionMessageToolCall => (c as { type?: string }).type === 'function',
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
  tools: OpenAI.ChatCompletionTool[] | undefined,
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
  const textParts: string[] = [];
  const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = [];
  const reasoning: ReasoningItem[] = [];
  const media: ModelMediaPart[] = [];

  for (const item of response.output ?? []) {
    const nativeItem = item as unknown as Record<string, any>;
    if (nativeItem.type === 'message') {
      for (const part of nativeItem.content ?? []) {
        if (part.type === 'output_text' && typeof part.text === 'string') {
          textParts.push(part.text);
        } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
          textParts.push(part.refusal);
        } else if (part.type === 'output_audio' && typeof part.data === 'string') {
          media.push({
            type: 'audio',
            data: part.data,
            mimeType: part.mime_type ?? 'audio/mpeg',
            ...(typeof part.transcript === 'string' ? { transcript: part.transcript } : {}),
          });
        }
      }
    } else if (nativeItem.type === 'image_generation_call' && typeof nativeItem.result === 'string') {
      media.push({ type: 'image', data: nativeItem.result, mimeType: 'image/png' });
    } else if (nativeItem.type === 'video_generation_call') {
      const url = nativeItem.url ?? nativeItem.result?.url;
      const data = nativeItem.data ?? nativeItem.result?.data;
      if (typeof url === 'string' || typeof data === 'string') {
        media.push({
          type: 'video',
          ...(typeof url === 'string' ? { url } : {}),
          ...(typeof data === 'string' ? { data } : {}),
          mimeType: nativeItem.mime_type ?? nativeItem.result?.mime_type ?? 'video/mp4',
        });
      }
    } else if (nativeItem.type === 'file' || nativeItem.type === 'output_file') {
      const url = nativeItem.url ?? nativeItem.file_url;
      const data = nativeItem.data;
      const mimeType = nativeItem.mime_type ?? nativeItem.mimeType;
      if (typeof url === 'string' || typeof data === 'string') {
        media.push({
          type: mediaTypeFromMime(mimeType),
          ...(typeof url === 'string' ? { url } : {}),
          ...(typeof data === 'string' ? { data } : {}),
          ...(mimeType ? { mimeType } : {}),
          ...(nativeItem.filename ? { name: nativeItem.filename } : {}),
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
            total_tokens: usage.total_tokens ?? 0,
            ...(usage.input_tokens_details
              ? { prompt_tokens_details: { cached_tokens: usage.input_tokens_details.cached_tokens ?? 0 } }
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
const DROPPABLE = ['include', 'temperature', 'prompt_cache_key', 'parallel_tool_calls'] as const;
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
      (param === 'include' && haystack.includes('encrypted_content'));
    if (mentioned) return param;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class OpenAiResponsesAdapter implements CompletionAdapter {
  async createCompletion({
    model,
    apiKey,
    messages,
    tools,
    temperature,
    maxTokens,
    signal,
    conversationId,
    nodeId,
    promptCacheKey,
  }: CompletionInput): Promise<CompletionResult> {
    const openai = createOpenAIClient({
      apiKey,
      baseURL: model.baseUrl,
      defaultHeaders: getProviderDefaultHeaders(model.provider),
    });

    const key = sessionKey(conversationId, nodeId);
    const carried = key ? reasoningBySession.get(key) : undefined;

    const input = toResponsesInput(messages, carried);
    const responsesTools = toResponsesTools(tools);
    const wantsImage = (model.outputModalities ?? [])
      .some(modality => modality.toLowerCase() === 'image');
    const allTools: OpenAI.Responses.Tool[] = [
      ...(responsesTools ?? []),
      ...(wantsImage ? [{ type: 'image_generation' as const }] : []),
    ];
    const pk = paramKey(model);
    const dropped = unsupportedParams.get(pk) ?? new Set<Droppable>();

    const buildBody = (omit: Set<Droppable>): Record<string, unknown> => ({
      model: model.name,
      input,
      // Stateless by design — FLUJO owns the history and rewrites it every turn,
      // which an append-only server-side thread cannot represent.
      store: false,
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
      carriedReasoningAnchors: carried?.size ?? 0,
      droppedParams: Array.from(dropped),
    });

    const send = (omit: Set<Droppable>) =>
      withTransientRetry(
        () =>
          openai.responses.create(
            buildBody(omit) as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming,
            signal ? { signal } : undefined,
          ),
        { signal },
      ) as Promise<OpenAI.Responses.Response>;

    // Negotiate away unsupported optional parameters, one per rejection. Bounded
    // by the number of droppable parameters, so this cannot spin.
    const omit = new Set(dropped);
    let response: OpenAI.Responses.Response | undefined;
    for (let attempt = 0; attempt <= DROPPABLE.length; attempt++) {
      try {
        response = await send(omit);
        break;
      } catch (error) {
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

    const { completion, reasoning, media } = fromResponse(response, model.name);

    // Stash this turn's reasoning against its first tool call, so the next
    // iteration of the loop can hand it back. Nothing to carry when the turn made
    // no tool calls: the exchange is finished.
    const firstCallId = completion.choices[0]?.message?.tool_calls?.[0]?.id;
    if (key && firstCallId && reasoning.length > 0) {
      stashReasoning(key, firstCallId, reasoning);
      log.debug('Carrying encrypted reasoning items to the next turn', {
        anchor: firstCallId,
        items: reasoning.length,
      });
    }

    return { completion, media };
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
    promptCacheKey,
    onModelDelta,
  }: CompletionInput): Promise<CompletionResult> {
    const openai = createOpenAIClient({
      apiKey,
      baseURL: model.baseUrl,
      defaultHeaders: getProviderDefaultHeaders(model.provider),
    });
    const key = sessionKey(conversationId, nodeId);
    const carried = key ? reasoningBySession.get(key) : undefined;
    const input = toResponsesInput(messages, carried);
    const responsesTools = toResponsesTools(tools);
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

    const buildBody = (omit: Set<Droppable>): Record<string, unknown> => ({
      model: model.name,
      input,
      store: false,
      stream: true,
      ...(allTools.length ? { tools: allTools } : {}),
      ...(typeof maxTokens === 'number' ? { max_output_tokens: maxTokens } : {}),
      ...(omit.has('temperature') ? {} : { temperature }),
      ...(model.reasoningEffort ? { reasoning: { effort: model.reasoningEffort } } : {}),
      ...(omit.has('include') ? {} : { include: ['reasoning.encrypted_content'] }),
      ...(omit.has('prompt_cache_key') || !promptCacheKey ? {} : { prompt_cache_key: promptCacheKey }),
    });

    const consume = async (omit: Set<Droppable>): Promise<OpenAI.Responses.Response> => {
      const stream = await openai.responses.create(
        buildBody(omit) as unknown as OpenAI.Responses.ResponseCreateParamsStreaming,
        signal ? { signal } : undefined,
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
        } else if (event.type === 'response.completed') {
          response = event.response;
        } else if (event.type === 'response.failed') {
          response = event.response;
        }
      }
      if (!response) throw new Error('OpenAI Responses stream ended without a terminal response');
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

    const { completion, reasoning, media } = fromResponse(response, model.name);
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
    const firstCallId = completion.choices[0]?.message?.tool_calls?.[0]?.id;
    if (key && firstCallId && reasoning.length > 0) {
      stashReasoning(key, firstCallId, reasoning);
    }
    return { completion, liveMessageId, media };
  }
}
