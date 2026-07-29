import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { createLogger } from '@/utils/logger';
import { CompletionAdapter, CompletionInput, CompletionResult } from './types';
import { extractText, extractImageParts, toAnthropicImageMediaType, parseToolArgs } from './messageUtils';
import { LLM_REQUEST_TIMEOUT_MS } from '@/shared/config/timeouts';
import { v4 as uuidv4 } from 'uuid';

const log = createLogger('backend/services/model/adapters/anthropicAdapter');

// The Anthropic Messages API REQUIRES max_tokens, so this is a fallback-only
// default used solely when no cap was resolved (no request max_tokens and no
// per-model Model.maxTokens). It is no longer a silent ceiling: when a value is
// resolved it is used verbatim, so larger caps are honored (issue #173).
const DEFAULT_MAX_TOKENS = 8192;

const CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const modelCapabilityCache = new Map<string, { supportsTemperature: boolean; expiresAt: number }>();

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
 * How many optional request features `complete()` can negotiate away
 * (`cache_control`, `temperature`) — the retry bound for its attempt loop.
 */
const DROPPABLE_FEATURES = 2;

/** True when a 400 is Anthropic telling us `temperature` is gone on this model. */
function isTemperatureDeprecated(err: unknown): boolean {
  return (
    err instanceof Anthropic.BadRequestError &&
    err.message.includes('temperature') &&
    err.message.toLowerCase().includes('deprecated')
  );
}

/** Clears the capability cache. Call in tests between cases. */
export function clearModelCapabilityCache(): void {
  modelCapabilityCache.clear();
}

/**
 * Static denylist of model-name substrings that no longer accept the
 * `temperature` sampling parameter (Anthropic deprecated it for adaptive-
 * thinking models starting with claude-opus-4-7).
 *
 * Rules:
 * - Match is case-insensitive substring; we use lowercase model names.
 * - Prefer false-negatives (include temperature) over false-positives (break
 *   the call) for unknown models: an unsupported temperature produces a 400
 *   that the retry path catches; a missing temperature on a model that wants it
 *   would silently change behaviour.
 */
export const TEMPERATURE_DEPRECATED_SUBSTRINGS = [
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-4-9',
  'claude-fable-4',
  'claude-fable-5',
  'claude-sonnet-5',
  'claude-haiku-5',
] as const;

async function fetchTemperatureSupportFromApi(
  client: Anthropic,
  modelName: string
): Promise<boolean | null> {
  try {
    const model = await client.models.retrieve(modelName);
    const caps = (model as unknown as Record<string, unknown>)['capabilities'] as Record<string, unknown> | undefined;
    const thinking = caps?.['thinking'] as Record<string, unknown> | undefined;
    const types = thinking?.['types'] as Record<string, unknown> | undefined;
    const adaptive = types?.['adaptive'] as Record<string, unknown> | undefined;
    if (typeof adaptive?.['supported'] === 'boolean') {
      // adaptive.supported === true → model uses only adaptive thinking → no temperature
      return !adaptive['supported'];
    }
    return null; // capability field absent — unknown
  } catch {
    return null; // API unavailable or model not returned — fall back to static list
  }
}

/**
 * Returns true when the Anthropic model is expected to accept the `temperature`
 * parameter; false for models that reject it with a 400.
 *
 * Resolution order:
 * 1. Cache hit (keyed by lowercase model name, TTL 5 min).
 * 2. Live API lookup via client.models.retrieve (when client is provided).
 * 3. Static denylist fallback (TEMPERATURE_DEPRECATED_SUBSTRINGS).
 */
export async function anthropicModelSupportsTemperature(
  modelName: string,
  client?: Anthropic
): Promise<boolean> {
  const key = modelName.toLowerCase();

  // 1. Cache hit
  const cached = modelCapabilityCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.supportsTemperature;
  }

  // 2. Live API lookup
  if (client) {
    const apiResult = await fetchTemperatureSupportFromApi(client, modelName);
    if (apiResult !== null) {
      modelCapabilityCache.set(key, {
        supportsTemperature: apiResult,
        expiresAt: Date.now() + CAPABILITY_CACHE_TTL_MS,
      });
      return apiResult;
    }
    log.debug(
      'Anthropic Models API returned no temperature capability info; using static denylist',
      { model: modelName }
    );
  }

  // 3. Static denylist fallback
  const staticResult = !TEMPERATURE_DEPRECATED_SUBSTRINGS.some(s => key.includes(s));
  if (client) {
    modelCapabilityCache.set(key, {
      supportsTemperature: staticResult,
      expiresAt: Date.now() + CAPABILITY_CACHE_TTL_MS,
    });
  }
  return staticResult;
}

/**
 * Convert OpenAI-format messages into Anthropic's shape:
 *   - system messages are hoisted into the top-level `system` string
 *   - assistant tool_calls become `tool_use` content blocks
 *   - tool results become `tool_result` blocks inside a user message
 *     (consecutive tool results are merged into one user message, as the API
 *     requires)
 */
export function toAnthropicMessages(messages: OpenAI.ChatCompletionMessageParam[]): {
  system?: string;
  messages: Anthropic.MessageParam[];
} {
  const systemParts: string[] = [];
  const out: Anthropic.MessageParam[] = [];

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
      const images = extractImageParts(msg.content);
      if (images.length === 0) {
        out.push({ role: 'user', content: text });
        continue;
      }
      // Multimodal user turn: a text block (when present) followed by image
      // blocks. Pasted screenshots arrive as base64 data URLs; remote URLs use
      // Anthropic's URL image source.
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (text) blocks.push({ type: 'text', text });
      for (const img of images) {
        if (img.base64) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: toAnthropicImageMediaType(img.mimeType), data: img.base64 },
          });
        } else {
          blocks.push({ type: 'image', source: { type: 'url', url: img.url } });
        }
      }
      out.push({ role: 'user', content: blocks });
      continue;
    }

    if (msg.role === 'assistant') {
      const blocks: Anthropic.ContentBlockParam[] = [];
      const text = extractText(msg.content ?? '');
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
  while (out.length > 0 && out[out.length - 1].role === 'assistant') {
    out.pop();
    log.warn('toAnthropicMessages: stripped trailing assistant message — Anthropic API requires user-last');
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages: out,
  };
}

export function toAnthropicTools(
  tools?: OpenAI.ChatCompletionTool[]
): Anthropic.Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools
    .filter(t => t.type === 'function')
    .map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: (t.function.parameters as Anthropic.Tool.InputSchema) ?? {
        type: 'object',
        properties: {},
      },
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
  resp: Anthropic.Message
): OpenAI.Chat.Completions.ChatCompletion {
  let text = '';
  const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = [];

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

  return {
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
      ...(reportsCache ? { prompt_tokens_details: { cached_tokens: cacheRead } } : {}),
    },
  };
}

/**
 * Native Anthropic adapter (using @anthropic-ai/sdk). Used by the
 * "Anthropic (Native)" provider profile. Supports tool calling: tools are
 * translated to Anthropic's tool schema and `tool_use` responses are mapped
 * back to OpenAI `tool_calls` so FLUJO's tool-execution loop drives them.
 */
export class AnthropicAdapter implements CompletionAdapter {
  async createCompletion(input: CompletionInput): Promise<CompletionResult> {
    return this.complete(input, 'createCompletion', async (client, params, options) => ({
      message: await client.messages.create(params, options),
    }));
  }

  /**
   * Streaming variant of createCompletion: uses the Anthropic SDK's
   * client.messages.stream() helper to open a native streaming connection,
   * then collects the final assembled Message via stream.finalMessage().
   *
   * AUDIT NOTE (issue #274): As of the audit at baseSha
   * 18dbcbbbf7223aba499f4bc8f5489e5a52010ef8 there was no streaming branch in
   * this adapter. This method adds one proactively so that the same temperature
   * guard and catch-and-retry applied to createCompletion cannot be bypassed by
   * callers that prefer native SDK streaming.
   *
   * The interface contract is identical to createCompletion: callers receive a
   * CompletionResult containing an OpenAI-shaped ChatCompletion. Both paths now
   * share `complete()` below, so the parameter fallbacks cannot diverge between
   * them — which was the whole point of adding this method.
   */
  async createStreamCompletion(input: CompletionInput): Promise<CompletionResult> {
    const liveMessageId = `stream_${uuidv4()}`;
    return this.complete(input, 'createStreamCompletion', async (client, params, options) => {
      const stream = client.messages.stream(
        params as Parameters<typeof client.messages.stream>[0],
        options
      );
      const toolIndexes = new Map<number, number>();
      let nextToolIndex = 0;
      // The real SDK stream is async-iterable. Keeping the finalMessage-only
      // fallback also supports older SDK-compatible clients and test doubles.
      if (Symbol.asyncIterator in Object(stream)) {
        for await (const rawEvent of stream) {
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
      return { message: await stream.finalMessage(), liveMessageId };
    });
  }

  /**
   * The one request path, shared by the streaming and non-streaming entry points.
   *
   * Negotiates away two optional-but-valuable request features, each detected
   * narrowly and each dropped at most once, so the loop cannot spin:
   *   - `cache_control` breakpoints — absent from Anthropic-compatible proxies
   *     that don't implement prompt caching. Disabled per (provider, baseURL) for
   *     the rest of the process, since the answer never changes mid-run.
   *   - `temperature` — rejected by adaptive-thinking models (claude-opus-4-7+)
   *     that aren't yet on the static denylist. NOT remembered: the capability
   *     cache and Models API lookup already handle that per model.
   */
  private async complete(
    { model, apiKey, messages, tools, temperature, maxTokens, signal }: CompletionInput,
    label: string,
    send: (
      client: Anthropic,
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: { signal: AbortSignal }
    ) => Promise<{ message: Anthropic.Message; liveMessageId?: string }>
  ): Promise<CompletionResult> {
    const client = new Anthropic({
      apiKey,
      // Honour a custom base URL if one was configured; otherwise the SDK
      // default (api.anthropic.com) is used.
      ...(model.baseUrl ? { baseURL: model.baseUrl } : {}),
      // The SDK defaults to a ~10-minute per-request timeout; raise it so a slow
      // turn in a long flow isn't aborted (see shared timeouts config).
      timeout: LLM_REQUEST_TIMEOUT_MS,
    });

    const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
    const anthropicTools = toAnthropicTools(tools);

    // NOTE: anthropicModelSupportsTemperature is now async (issue #275): it first
    // checks a short-lived cache, then queries the Anthropic Models API for
    // live capability data, and finally falls back to the static denylist.
    const includeTemperature = await anthropicModelSupportsTemperature(model.name, client);
    const endpoint = endpointKey(model.provider, model.baseUrl);

    // Each attempt builds its own body from the untouched translation output, so
    // the params already handed to the SDK are never rewritten underneath it.
    const build = (opts: { cache: boolean; temperature: boolean }) => {
      const shaped = opts.cache
        ? applyCacheBreakpoints({ system, messages: anthropicMessages, tools: anthropicTools })
        : { system, messages: anthropicMessages, tools: anthropicTools, breakpoints: 0 };
      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model: model.name,
        max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(opts.temperature ? { temperature } : {}),
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
      return { params, breakpoints: shaped.breakpoints };
    };

    let useCache = !rejectedCacheControl.has(endpoint);
    let useTemperature = includeTemperature;
    // The abort signal (Stop button) cancels the in-flight HTTP request.
    const options = signal ? { signal } : undefined;

    // One attempt, plus at most one retry per droppable feature. Each retry
    // clears the flag its own guard tests, so the loop cannot spin; the bound
    // mirrors openaiResponsesAdapter's negotiation loop as a backstop.
    for (let attempt = 0; attempt <= DROPPABLE_FEATURES; attempt++) {
      const { params, breakpoints } = build({ cache: useCache, temperature: useTemperature });

      log.debug(`${label} via Anthropic SDK`, {
        model: model.name,
        toolCount: anthropicTools?.length ?? 0,
        hasSystem: Boolean(system),
        cacheBreakpoints: breakpoints,
      });

      try {
        const result = await send(client, params, options);
        return {
          completion: toChatCompletion(model.name, result.message),
          liveMessageId: result.liveMessageId,
        };
      } catch (err) {
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
        // Some models (e.g. claude-opus-4-7+) reject `temperature` with a 400.
        // When not yet covered by the static denylist, auto-retry without it.
        if (useTemperature && isTemperatureDeprecated(err)) {
          log.warn(
            'Anthropic API rejected temperature for model; retrying without it. ' +
              'Consider adding this model to TEMPERATURE_DEPRECATED_SUBSTRINGS.',
            { model: model.name }
          );
          useTemperature = false;
          continue;
        }
        throw err;
      }
    }

    // Only reachable if every attempt was consumed by a fresh rejection.
    throw new Error('Anthropic API rejected every supported parameter combination');
  }
}
