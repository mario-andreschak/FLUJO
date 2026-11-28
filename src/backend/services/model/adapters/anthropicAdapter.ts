import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { contextUsageFromCompletion } from './contextUsage';
import { toAnthropicToolSchema } from './anthropicToolSchema';
import { createLogger } from '@/utils/logger';
import { CompletionAdapter, CompletionInput, CompletionResult, observeSdkRequest, assertReadOnlyAssessmentInput } from './types';
import {
  extractText,
  extractMediaParts,
  toAnthropicImageMediaType,
  parseToolArgs,
} from './messageUtils';
import { LLM_REQUEST_TIMEOUT_MS } from '@/shared/config/timeouts';
import { v4 as uuidv4 } from 'uuid';
import type { ModelMediaPart } from '@/shared/types/model/media';
import { mediaTypeFromMime } from '@/shared/types/model/media';
import { assertOwnerCredentialAdapterRoute } from '@/backend/execution/extensions';
import { ANTHROPIC_API_VERSION, ANTHROPIC_PREVIOUS_API_VERSION } from './anthropicApiVersion';
import type { AnthropicCompactionRecord, ModelProviderMetadata } from '@/shared/types/openai';
import type { Model } from '@/shared/types/model';
import {
  ANTHROPIC_COMPACTION_BETA,
  ANTHROPIC_COMPACTION_MAX_TOKENS,
  anthropicCompactionAvailable,
  AnthropicCompactionMissingError,
  compactionRecordOf,
  compactionRecordOfMessage,
  compactionUsage,
  isCompactionRefusal,
  isTransientCompactionFailure,
  markAnthropicCompactionRefused,
  placeCompactionBlock,
  textAfterCompaction,
} from './anthropicCompaction';

const log = createLogger('backend/services/model/adapters/anthropicAdapter');

// The Anthropic Messages API REQUIRES max_tokens, so this is a fallback-only
// default used solely when no cap was resolved (no request max_tokens and no
// per-model Model.maxTokens). It is no longer a silent ceiling: when a value is
// resolved it is used verbatim, so larger caps are honored (issue #173).
const DEFAULT_MAX_TOKENS = 8192;

// --- Prompt caching -------------------------------------------------------
//
// Unlike the OpenAI-compatible path, which gets an AUTOMATIC prefix cache (see
// openaiAdapter's prompt_cache_key), the Anthropic Messages API caches nothing
// unless the request marks explicit `cache_control` breakpoints. Before this,
// every native-Anthropic turn re-read the entire prefix — tool block, system
// prompt, whole history — at full input price, on every iteration of every
// agentic loop. Cache reads bill at ~0.1x, so on a long tool-using run this is
// the dominant line item.
//
// A request may carry at most 4 breakpoints; the render order is fixed at
// `tools` -> `system` -> `messages`, so each breakpoint's entry covers
// everything before it. We place three (see applyCacheBreakpoints), leaving one
// slot spare for future use.
const EPHEMERAL: Anthropic.CacheControlEphemeral = { type: 'ephemeral' };

/**
 * Content-block types that accept `cache_control`. A breakpoint anchors to the
 * LAST block of this kind in a message; a message with none is skipped rather
 * than risking a 400 on a block type that can't carry the marker.
 */
const CACHEABLE_BLOCK_TYPES = new Set(['text', 'image', 'tool_use', 'tool_result', 'document']);

/**
 * Endpoints (provider + baseURL) that rejected `cache_control` — an
 * Anthropic-compatible proxy that doesn't implement prompt caching. Populated at
 * runtime from a narrowly-matched 400, so the retry happens once per process per
 * endpoint instead of on every call. Mirrors openaiAdapter's
 * `rejectedPromptCacheKey`: a wrong guess costs one retried request, never a
 * broken provider. In-process only; a restart costs at most one more retry.
 */
const rejectedCacheControl = new Set<string>();

const endpointKey = (provider?: string, baseUrl?: string) => `${provider ?? 'anthropic'}|${baseUrl ?? ''}`;

/** Test seam: forget which endpoints rejected `cache_control`. */
export function __resetCacheControlSupport(): void {
  rejectedCacheControl.clear();
}

/**
 * True when a provider error is specifically "I don't know this field", naming
 * `cache_control`. Deliberately narrow: a 400 for any OTHER reason must
 * propagate unchanged rather than be masked by a silent retry.
 */
export function isCacheControlRejection(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status !== 400 && status !== 422) return false;
  const haystack = [
    (err as { message?: string })?.message,
    JSON.stringify((err as { error?: unknown })?.error ?? ''),
  ]
    .join(' ')
    .toLowerCase();
  if (!haystack.includes('cache_control')) return false;
  return (
    haystack.includes('unknown') ||
    haystack.includes('unrecognized') ||
    haystack.includes('unsupported') ||
    haystack.includes('not supported') ||
    haystack.includes('not allowed') ||
    haystack.includes('extra') ||
    haystack.includes('additional')
  );
}

/**
 * Endpoints (provider + baseURL) that refused {@link ANTHROPIC_API_VERSION}:
 * an Anthropic-compatible server that only knows the earlier version. They get
 * {@link ANTHROPIC_PREVIOUS_API_VERSION} instead, under which every request
 * FLUJO builds is equally valid. In-process only, like `rejectedCacheControl`:
 * a restart costs at most one more retry.
 */
const previousVersionEndpoints = new Set<string>();

/** Test seam: forget which endpoints refused the current API version. */
export function __resetApiVersionSupport(): void {
  previousVersionEndpoints.clear();
}

/**
 * True when a 400 names the `anthropic-version` header itself. Deliberately
 * narrow, like {@link isCacheControlRejection}: a 400 about the request body
 * (a field the version refuses, say) propagates unchanged instead of being
 * hidden by a quiet move to the older version.
 */
export function isApiVersionRejection(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status !== 400) return false;
  const haystack = [
    (err as { message?: string })?.message,
    JSON.stringify((err as { error?: unknown })?.error ?? ''),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes('anthropic-version');
}

/**
 * How many optional request features `complete()` can negotiate away
 * (`cache_control`, the current API version, a signed summary block) — the
 * retry bound for its attempt loop.
 */
const DROPPABLE_FEATURES = 3;

/** One request body; `beta` is set when it asks for or carries native compaction. */
type AnthropicRequest = {
  params: Anthropic.MessageCreateParamsNonStreaming;
  beta?: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
};

type AnthropicReply = Anthropic.Message | Anthropic.Beta.BetaMessage;

/**
 * Client options for one connection. A client holds exactly one credential in
 * SDK 1.x. An API key still goes out in `X-Api-Key`, as it did before 1.x:
 * the Claude API accepts it there, and gateways or Anthropic-compatible
 * servers behind a custom base URL (Microsoft Foundry among them) read it from
 * that header. OpenRouter expects its key as a bearer token.
 */
export function anthropicClientOptions(input: {
  provider?: string;
  apiKey: string;
  baseUrl?: string;
}): ConstructorParameters<typeof Anthropic>[0] {
  return {
    ...(input.provider === 'openrouter'
      ? { authToken: input.apiKey }
      : { apiKey: input.apiKey, defaultHeaders: { 'X-Api-Key': input.apiKey, Authorization: null } }),
    // Honour a custom base URL if one was configured; otherwise the SDK
    // default (api.anthropic.com) is used.
    ...(input.baseUrl ? { baseURL: input.baseUrl } : {}),
  };
}

/**
 * Convert OpenAI-format messages into Anthropic's shape:
 *   - system messages are hoisted into the top-level `system` string
 *   - assistant tool_calls become `tool_use` content blocks
 *   - tool results become `tool_result` blocks inside a user message
 *     (consecutive tool results are merged into one user message, as the API
 *     requires)
 */
export function toAnthropicMessages(
  messages: OpenAI.ChatCompletionMessageParam[],
  options: {
    /** Send a native summary as its signed block (#1091); false sends it as plain text. */
    compactionBlock?: boolean;
    /** A compaction request summarizes every message it gets, a final reply included. */
    keepTrailingAssistant?: boolean;
  } = {},
): {
  system?: string;
  messages: Anthropic.MessageParam[];
  /** The signed summary that goes first; `merged` means messages[0] holds the records after it. */
  compaction?: { record: AnthropicCompactionRecord; merged: boolean };
} {
  const systemParts: string[] = [];
  const out: Anthropic.MessageParam[] = [];
  let compaction: { record: AnthropicCompactionRecord; merged: boolean } | undefined;

  const pushToolResult = (toolUseId: string, content: string) => {
    const block: Anthropic.ToolResultBlockParam = {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content,
    };
    const last = out[out.length - 1];
    if (
      last &&
      last.role === 'user' &&
      Array.isArray(last.content) &&
      last.content.every(b => (b as { type?: string }).type === 'tool_result')
    ) {
      (last.content as Anthropic.ContentBlockParam[]).push(block);
    } else {
      out.push({ role: 'user', content: [block] });
    }
  };

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = extractText(msg.content);
      if (text) systemParts.push(text);
      continue;
    }

    if (msg.role === 'tool') {
      pushToolResult(msg.tool_call_id, extractText(msg.content));
      continue;
    }

    if (msg.role === 'user') {
      const text = extractText(msg.content);
      const media = extractMediaParts(msg.content);
      if (media.length === 0) {
        out.push({ role: 'user', content: text });
        continue;
      }
      // Multimodal user turn: a text block (when present) followed by image
      // blocks. Pasted screenshots arrive as base64 data URLs; remote URLs use
      // Anthropic's URL image source.
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (text) blocks.push({ type: 'text', text });
      for (const item of media) {
        if (item.type === 'image' && item.data) {
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: toAnthropicImageMediaType(item.mimeType),
              data: item.data,
            },
          });
        } else if (item.type === 'image' && item.url) {
          blocks.push({ type: 'image', source: { type: 'url', url: item.url } });
        } else if (item.type === 'file' && item.mimeType === 'application/pdf' && item.data) {
          blocks.push({
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: item.data,
            },
          } as Anthropic.ContentBlockParam);
        } else if (item.type === 'file' && item.mimeType === 'application/pdf' && item.url) {
          blocks.push({
            type: 'document',
            source: { type: 'url', url: item.url },
          } as Anthropic.ContentBlockParam);
        } else {
          blocks.push({
            type: 'text',
            text: `[Unsupported ${item.type} attachment${item.name ? `: ${item.name}` : ''}]`,
          });
        }
      }
      out.push({ role: 'user', content: blocks });
      continue;
    }

    if (msg.role === 'assistant') {
      const blocks: Anthropic.ContentBlockParam[] = [];
      const text = extractText(msg.content ?? '');
      // The signed block must open `messages`; anywhere else it is a 400.
      const record = options.compactionBlock !== false && !compaction && out.length === 0 && !msg.tool_calls?.length
        ? compactionRecordOfMessage(msg) : undefined;
      const after = record ? textAfterCompaction(text, record) : undefined;
      if (record && after !== undefined) {
        compaction = { record, merged: after.length > 0 };
        if (after) out.push({ role: 'assistant', content: [{ type: 'text', text: after }] });
        continue;
      }
      if (text) blocks.push({ type: 'text', text });

      for (const tc of msg.tool_calls ?? []) {
        if (tc.type !== 'function') continue;
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: parseToolArgs(tc.function.arguments),
        });
      }

      // Anthropic rejects an empty content array; fall back to a (possibly
      // empty) text string when there is nothing to send.
      out.push({ role: 'assistant', content: blocks.length > 0 ? blocks : text });
      continue;
    }
  }

  // Anthropic API requires the last message to be a user turn.
  // If the message list (after all processing) still ends with an assistant
  // turn, drop it. This prevents a 400 on models that don't support prefill.
  while (!options.keepTrailingAssistant && out.length > (compaction?.merged ? 1 : 0) && out[out.length - 1].role === 'assistant') {
    out.pop();
    log.warn('toAnthropicMessages: stripped trailing assistant message — Anthropic API requires user-last');
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages: out,
    ...(compaction ? { compaction } : {}),
  };
}

export function toAnthropicTools(
  tools?: OpenAI.ChatCompletionFunctionTool[]
): Anthropic.Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools
    .filter(t => t.type === 'function')
    .map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: toAnthropicToolSchema(t.function.parameters ?? {
        type: 'object',
        properties: {},
      }) as Anthropic.Tool.InputSchema,
    }));
}

/**
 * Return a copy of `message` with `cache_control` on its last cacheable content
 * block, or null when there is nothing to anchor to (an empty turn — Anthropic
 * rejects both an empty content array and an empty text block).
 *
 * A string `content` is promoted to a one-element block array, which is the only
 * shape that can carry the marker.
 */
function withCacheControl(message: Anthropic.MessageParam): Anthropic.MessageParam | null {
  if (message.role === 'system') return null;
  const { content } = message;

  if (typeof content === 'string') {
    if (content.length === 0) return null;
    return { ...message, content: [{ type: 'text', text: content, cache_control: EPHEMERAL }] };
  }
  if (!Array.isArray(content)) return null;

  // Anchor to the last block that can carry the marker. Marking an earlier block
  // simply caches a shorter prefix, which is still correct.
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (!CACHEABLE_BLOCK_TYPES.has((block as { type?: string }).type ?? '')) continue;
    const marked = { ...block, cache_control: EPHEMERAL } as Anthropic.ContentBlockParam;
    return { ...message, content: [...content.slice(0, i), marked, ...content.slice(i + 1)] };
  }
  return null;
}

/**
 * Mark the request's cacheable prefix with `cache_control` breakpoints. Pure —
 * returns new objects and never mutates the inputs, so a retry can rebuild the
 * request from the originals.
 *
 * Three breakpoints, in render order (`tools` -> `system` -> `messages`):
 *
 *  1. the last TOOL definition — so the (large) tool block keeps hitting even
 *     when the system prompt changes. That is the common FLUJO case: a handoff
 *     to another node re-renders the system prompt while the tool set is
 *     unchanged, and without this slot the whole prefix would go cold.
 *  2. the last SYSTEM block — covers tools + system together.
 *  3. the last content block of the last MESSAGE — the write point that the
 *     NEXT turn of the agentic loop reads back.
 *
 * Extra breakpoints are close to free: the spans are cumulative, so an unread
 * inner breakpoint does not re-write the prefix it shares with an outer one.
 *
 * Two provider behaviours worth knowing, neither of which this can fix:
 *  - The minimum cacheable prefix is model-dependent (512 tokens on the newest
 *    models, up to 4096 on some older ones) and a shorter prefix silently does
 *    not cache — no error, just `cache_creation_input_tokens: 0`. Marking
 *    unconditionally is therefore safe; on a short prompt it is a no-op.
 *  - A breakpoint walks back at most 20 content blocks looking for a warm
 *    entry. A normal tool-loop iteration appends 2-5 messages, so breakpoint 3
 *    is found again next turn; a single node visit that appends more than 20
 *    messages before the next model call will miss it and re-write instead.
 */
export function applyCacheBreakpoints(input: {
  system?: string;
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
}): {
  system?: string | Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  /** How many breakpoints were actually placed (0-3). For logging and tests. */
  breakpoints: number;
} {
  let breakpoints = 0;

  let tools = input.tools;
  if (tools && tools.length > 0) {
    const last = tools[tools.length - 1];
    tools = [...tools.slice(0, -1), { ...last, cache_control: EPHEMERAL }];
    breakpoints++;
  }

  let system: string | Anthropic.TextBlockParam[] | undefined = input.system;
  if (input.system) {
    system = [{ type: 'text', text: input.system, cache_control: EPHEMERAL }];
    breakpoints++;
  }

  let messages = input.messages;
  if (messages.length > 0) {
    const tailIndex = messages.length - 1;
    const marked = withCacheControl(messages[tailIndex]);
    if (marked) {
      messages = [...messages.slice(0, tailIndex), marked];
      breakpoints++;
    }
  }

  return {
    ...(system !== undefined ? { system } : {}),
    messages,
    ...(tools ? { tools } : {}),
    breakpoints,
  };
}

/** Map an Anthropic response back into an OpenAI-shaped ChatCompletion. */
function toChatCompletion(
  fallbackModel: string,
  resp: AnthropicReply
): { completion: OpenAI.Chat.Completions.ChatCompletion; media: ModelMediaPart[] } {
  let text = '';
  const toolCalls: OpenAI.ChatCompletionMessageFunctionToolCall[] = [];
  const media: ModelMediaPart[] = [];

  for (const block of resp.content) {
    if (block.type === 'text') {
      text += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    } else {
      const nativeBlock = block as unknown as Record<string, unknown>;
      const nativeType = typeof nativeBlock.type === 'string' ? nativeBlock.type : '';
      if (['image', 'audio', 'video', 'file', 'document'].includes(nativeType)) {
        const source = nativeBlock.source && typeof nativeBlock.source === 'object'
          ? nativeBlock.source as Record<string, unknown>
          : nativeBlock;
        const rawMimeType =
          source.media_type ??
          source.mime_type ??
          source.mimeType ??
          (nativeType === 'image' ? 'image/png' : undefined);
        const mimeType = typeof rawMimeType === 'string' ? rawMimeType : undefined;
        const data = source.data;
        const url = source.url;
        const name = typeof nativeBlock.name === 'string' ? nativeBlock.name : undefined;
        if (typeof data === 'string' || typeof url === 'string') {
          media.push({
            type: nativeType === 'document'
              ? 'file'
              : mediaTypeFromMime(mimeType),
            ...(typeof data === 'string' ? { data } : {}),
            ...(typeof url === 'string' ? { url } : {}),
            ...(mimeType ? { mimeType } : {}),
            ...(name ? { name } : {}),
          });
        }
      }
    }
  }

  // Anthropic splits input into three buckets and `input_tokens` counts only the
  // FRESH portion, so it under-reports the real context size once caching is on.
  // Report the FULL input context as prompt_tokens (keeping the context meter
  // accurate — identical semantics to mapSdkUsage and mapOpenAiUsage) and surface
  // the cheap re-read separately under prompt_tokens_details.cached_tokens, which
  // is the field mapOpenAiUsage and the prompt-cache metrics read. With no
  // caching both buckets are 0, so this is a no-op for uncached endpoints.
  const cacheCreation = resp.usage.cache_creation_input_tokens ?? 0;
  const cacheRead = resp.usage.cache_read_input_tokens ?? 0;
  const reportsCache =
    resp.usage.cache_creation_input_tokens != null || resp.usage.cache_read_input_tokens != null;
  const promptTokens = resp.usage.input_tokens + cacheCreation + cacheRead;

  const finishReason: OpenAI.Chat.Completions.ChatCompletion.Choice['finish_reason'] =
    resp.stop_reason === 'tool_use'
      ? 'tool_calls'
      : resp.stop_reason === 'max_tokens'
        ? 'length'
        : 'stop';

  const completion: OpenAI.Chat.Completions.ChatCompletion = {
    id: resp.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: resp.model || fallbackModel,
    choices: [
      {
        index: 0,
        finish_reason: finishReason,
        logprobs: null,
        message: {
          role: 'assistant',
          content: text || null,
          refusal: null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: resp.usage.output_tokens,
      total_tokens: promptTokens + resp.usage.output_tokens,
      // Only when the provider actually reported cache buckets, so consumers can
      // tell "0 cached" apart from "this endpoint doesn't cache at all" — the
      // same contract mapOpenAiUsage documents.
      ...(reportsCache
        ? {
            prompt_tokens_details: {
              cached_tokens: cacheRead,
              cache_write_tokens: cacheCreation,
            },
          }
        : {}),
    },
  };
  return { completion, media };
}

/**
 * The answer to a compaction request: the summary as the reply text and the
 * signed block in `providerMetadata`. Its tokens come from `usage.iterations`.
 */
function toCompactionResult(model: Model, resp: AnthropicReply): CompletionResult {
  const record = compactionRecordOf(resp, model.name);
  const usage = compactionUsage(resp.usage);
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  const providerMetadata: ModelProviderMetadata = { anthropicCompaction: record };
  return {
    completion: {
      id: resp.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: resp.model || model.name,
      choices: [{
        index: 0,
        finish_reason: 'stop',
        logprobs: null,
        message: { role: 'assistant', content: record.block.content, refusal: null },
      }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: usage.output,
        total_tokens: promptTokens + usage.output,
        prompt_tokens_details: { cached_tokens: usage.cacheRead, cache_write_tokens: usage.cacheWrite },
      },
    },
    providerMetadata,
    // The summary call's input is not the conversation's next request.
    contextUsage: null,
  };
}

/** Forwards streamed text and tool-call deltas as they arrive. */
async function relayStream(stream: object, input: CompletionInput, liveMessageId: string): Promise<void> {
  // The real SDK stream is async-iterable. Keeping the finalMessage-only
  // fallback also supports older SDK-compatible clients and test doubles.
  if (!(Symbol.asyncIterator in stream)) return;
  const toolIndexes = new Map<number, number>();
  let nextToolIndex = 0;
  for await (const rawEvent of stream as AsyncIterable<unknown>) {
    const event = rawEvent as Anthropic.RawMessageStreamEvent;
    if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
      const toolIndex = nextToolIndex++;
      toolIndexes.set(event.index, toolIndex);
      input.onModelDelta?.({
        messageId: liveMessageId,
        toolCallDelta: {
          index: toolIndex,
          id: event.content_block.id,
          nameDelta: event.content_block.name,
        },
      });
    } else if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta' && event.delta.text) {
        input.onModelDelta?.({ messageId: liveMessageId, contentDelta: event.delta.text });
      } else if (event.delta.type === 'input_json_delta' && event.delta.partial_json) {
        const toolIndex = toolIndexes.get(event.index);
        if (toolIndex != null) {
          input.onModelDelta?.({
            messageId: liveMessageId,
            toolCallDelta: {
              index: toolIndex,
              argumentsDelta: event.delta.partial_json,
            },
          });
        }
      }
    }
  }
}

/**
 * Native Anthropic adapter (using @anthropic-ai/sdk). Used by the
 * "Anthropic (Native)" provider profile. Supports tool calling: tools are
 * translated to Anthropic's tool schema and `tool_use` responses are mapped
 * back to OpenAI `tool_calls` so FLUJO's tool-execution loop drives them.
 */
export class AnthropicAdapter implements CompletionAdapter {
  async createCompletion(input: CompletionInput): Promise<CompletionResult> {
    return this.complete(input, 'createCompletion', async (client, request, options) => ({
      message: request.beta
        ? await client.beta.messages.create(request.beta, options)
        : await client.messages.create(request.params, options),
    }));
  }

  /**
   * Streaming variant of createCompletion: uses the Anthropic SDK's
   * client.messages.stream() helper to open a native streaming connection,
   * then collects the final assembled Message via stream.finalMessage().
   *
   * The interface contract is identical to createCompletion: callers receive a
   * CompletionResult containing an OpenAI-shaped ChatCompletion. Both paths
   * share `complete()` below, so the request body and the negotiated fallbacks
   * cannot diverge between them.
   */
  async createStreamCompletion(input: CompletionInput): Promise<CompletionResult> {
    if (input.readOnlyAssessment) throw new Error('Read-only assessment does not support streaming.');
    // A summary arrives whole, in one content_block_start, with no deltas.
    if (input.nativeCompaction) return this.createCompletion(input);
    const liveMessageId = `stream_${uuidv4()}`;
    return this.complete(input, 'createStreamCompletion', async (client, request, options) => {
      if (request.beta) {
        const stream = client.beta.messages.stream(request.beta, options);
        await relayStream(stream, input, liveMessageId);
        return { message: await stream.finalMessage(), liveMessageId };
      }
      const stream = client.messages.stream(
        request.params as Parameters<typeof client.messages.stream>[0],
        options
      );
      await relayStream(stream, input, liveMessageId);
      return { message: await stream.finalMessage(), liveMessageId };
    });
  }

  /**
   * The one request path, shared by the streaming and non-streaming entry points.
   *
   * The body follows API version 2026-10-21: it never carries `temperature`,
   * `top_p` or `top_k` (refused on every model), documents travel only in user
   * turns and user text never carries citations. A Creativity value saved on
   * the model is therefore ignored here; the model settings say so.
   *
   * Negotiates three optional-but-valuable request features, each detected
   * narrowly and each dropped at most once, so the loop cannot spin. The first
   * two are remembered per (provider, baseURL) for the rest of the process,
   * since the answer never changes mid-run:
   *   - `cache_control` breakpoints — absent from Anthropic-compatible proxies
   *     that don't implement prompt caching.
   *   - the current API version — an Anthropic-compatible server that only
   *     knows the earlier one gets that instead.
   *   - a signed native summary (#1091) — a server that refuses it gets the
   *     same summary as plain text, and the model gets FLUJO's own summaries
   *     for a while (see anthropicCompaction.ts).
   *
   * With `input.nativeCompaction` the request asks for a summary instead of a
   * reply (beta compact-2026-09-04). It never falls back to an ordinary reply:
   * a refusal or a missing summary throws, and the caller uses FLUJO's own.
   */
  private async complete(
    input: CompletionInput,
    label: string,
    send: (
      client: Anthropic,
      request: AnthropicRequest,
      options?: Anthropic.RequestOptions
    ) => Promise<{ message: AnthropicReply; liveMessageId?: string }>
  ): Promise<CompletionResult> {
    assertReadOnlyAssessmentInput(input);
    const { model, apiKey, messages, tools, maxTokens, signal, onSdkRequest, onSdkRequestResult, readOnlyAssessment, nativeCompaction } = input;
    assertOwnerCredentialAdapterRoute(model, 'anthropic');
    const client = new Anthropic({
      ...anthropicClientOptions({ provider: model.provider, apiKey, baseUrl: model.baseUrl }),
      // The SDK defaults to a ~10-minute per-request timeout; raise it so a slow
      // turn in a long flow isn't aborted (see shared timeouts config).
      timeout: LLM_REQUEST_TIMEOUT_MS,
      ...(readOnlyAssessment ? { maxRetries: 0, fetchOptions: { redirect: 'error' as const } } : {}),
    });

    const keepTrailingAssistant = Boolean(nativeCompaction);
    const withBlock = toAnthropicMessages(messages, { keepTrailingAssistant });
    const plain = withBlock.compaction ? toAnthropicMessages(messages, { compactionBlock: false, keepTrailingAssistant }) : withBlock;
    const anthropicTools = toAnthropicTools(tools);
    const endpoint = endpointKey(model.provider, model.baseUrl);

    // Each attempt builds its own body from the untouched translation output, so
    // the params already handed to the SDK are never rewritten underneath it.
    const build = (opts: { cache: boolean; block: boolean }): { request: AnthropicRequest; breakpoints: number } => {
      const translated = opts.block ? withBlock : plain;
      const shaped = opts.cache
        ? applyCacheBreakpoints({ system: translated.system, messages: translated.messages, tools: anthropicTools })
        : { system: translated.system, messages: translated.messages, tools: anthropicTools, breakpoints: 0 };
      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model: model.name,
        max_tokens: nativeCompaction
          ? Math.max(maxTokens ?? 0, ANTHROPIC_COMPACTION_MAX_TOKENS)
          : maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(model.reasoningEffort
          ? {
              output_config: {
                effort: model.reasoningEffort as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
              },
            }
          : {}),
        messages: shaped.messages,
        ...(shaped.system ? { system: shaped.system } : {}),
        ...(shaped.tools ? { tools: shaped.tools } : {}),
      };
      const compaction = opts.block ? translated.compaction : undefined;
      if (!nativeCompaction && !compaction) return { request: { params }, breakpoints: shaped.breakpoints };
      return {
        request: {
          params,
          beta: {
            ...params,
            messages: compaction ? placeCompactionBlock(shaped.messages, compaction, opts.cache) : shaped.messages,
            betas: [ANTHROPIC_COMPACTION_BETA],
            ...(nativeCompaction ? { compaction: { type: 'summarize' as const, instructions: nativeCompaction.instructions } } : {}),
          },
        },
        breakpoints: shaped.breakpoints + (compaction && opts.cache ? 1 : 0),
      };
    };

    let useCache = !readOnlyAssessment && !rejectedCacheControl.has(endpoint);
    let useCurrentVersion = !previousVersionEndpoints.has(endpoint);
    // A summary made before this model's endpoint refused one goes as text.
    let useBlock = Boolean(withBlock.compaction) && anthropicCompactionAvailable(model.id);

    // One attempt, plus at most one retry per droppable feature. Each retry
    // clears the flag its own guard tests, so the loop cannot spin; the bound
    // mirrors openaiResponsesAdapter's negotiation loop as a backstop.
    for (let attempt = 0; attempt <= DROPPABLE_FEATURES; attempt++) {
      const { request, breakpoints } = build({ cache: useCache, block: useBlock });
      // The abort signal (Stop button) cancels the in-flight HTTP request.
      const options: Anthropic.RequestOptions | undefined = signal || !useCurrentVersion
        ? {
            ...(signal ? { signal } : {}),
            ...(!useCurrentVersion ? { headers: { 'anthropic-version': ANTHROPIC_PREVIOUS_API_VERSION } } : {}),
          }
        : undefined;

      log.debug(`${label} via Anthropic SDK`, {
        model: model.name,
        toolCount: anthropicTools?.length ?? 0,
        hasSystem: Boolean(withBlock.system),
        cacheBreakpoints: breakpoints,
        apiVersion: useCurrentVersion ? ANTHROPIC_API_VERSION : ANTHROPIC_PREVIOUS_API_VERSION,
        nativeCompaction: nativeCompaction ? 'request' : useBlock ? 'replay' : undefined,
      });

      try {
        const result = await observeSdkRequest(
          { onSdkRequest, onSdkRequestResult, signal },
          {
            adapter: 'anthropic',
            operation: nativeCompaction ? 'beta.messages.create (compaction)'
              : `${request.beta ? 'beta.' : ''}${label === 'createStreamCompletion' ? 'messages.stream' : 'messages.create'}`,
            request: request.beta ?? request.params,
          },
          () => send(client, request, options),
        );
        if (nativeCompaction) return toCompactionResult(model, result.message);
        const translated = toChatCompletion(model.name, result.message);
        return {
          ...translated,
          contextUsage: contextUsageFromCompletion(translated.completion.usage, model.contextWindow),
          liveMessageId: result.liveMessageId,
        };
      } catch (err) {
        if (readOnlyAssessment) throw err;
        if (useCurrentVersion && isApiVersionRejection(err)) {
          previousVersionEndpoints.add(endpoint);
          log.warn(
            `Endpoint refused Anthropic API version ${ANTHROPIC_API_VERSION}; retrying with ${ANTHROPIC_PREVIOUS_API_VERSION} for it.`,
            { model: model.name, provider: model.provider, baseUrl: model.baseUrl }
          );
          useCurrentVersion = false;
          continue;
        }
        if (useCache && breakpoints > 0 && isCacheControlRejection(err)) {
          rejectedCacheControl.add(endpoint);
          log.warn(
            'Endpoint rejected cache_control; disabling prompt-cache breakpoints for it and retrying. ' +
              'Requests to this endpoint will be billed without the cached-input discount.',
            { model: model.name, provider: model.provider, baseUrl: model.baseUrl }
          );
          useCache = false;
          continue;
        }
        if (useBlock && isCompactionRefusal(err)) {
          markAnthropicCompactionRefused(model.id);
          log.warn(
            'Endpoint refused the signed Anthropic summary; sending the same summary as text and using FLUJO summaries for this model for a while.',
            { model: model.name, provider: model.provider, baseUrl: model.baseUrl }
          );
          useBlock = false;
          continue;
        }
        if (nativeCompaction && (err instanceof AnthropicCompactionMissingError || !isTransientCompactionFailure(err))) {
          markAnthropicCompactionRefused(model.id);
          log.warn('Anthropic native compaction gave no summary; FLUJO summarizes this model itself for a while.',
            { model: model.name, provider: model.provider, reason: err instanceof Error ? err.message : String(err) });
        }
        throw err;
      }
    }

    // Only reachable if every attempt was consumed by a fresh rejection.
    throw new Error('Anthropic API rejected every supported parameter combination');
  }
}
