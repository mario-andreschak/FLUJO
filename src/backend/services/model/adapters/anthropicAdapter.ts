import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { createLogger } from '@/utils/logger';
import { CompletionAdapter, CompletionInput, CompletionResult } from './types';
import { extractText, extractImageParts, toAnthropicImageMediaType, parseToolArgs } from './messageUtils';
import { LLM_REQUEST_TIMEOUT_MS } from '@/shared/config/timeouts';

const log = createLogger('backend/services/model/adapters/anthropicAdapter');

// The Anthropic Messages API REQUIRES max_tokens, so this is a fallback-only
// default used solely when no cap was resolved (no request max_tokens and no
// per-model Model.maxTokens). It is no longer a silent ceiling: when a value is
// resolved it is used verbatim, so larger caps are honored (issue #173).
const DEFAULT_MAX_TOKENS = 8192;

const CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const modelCapabilityCache = new Map<string, { supportsTemperature: boolean; expiresAt: number }>();

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
      prompt_tokens: resp.usage.input_tokens,
      completion_tokens: resp.usage.output_tokens,
      total_tokens: resp.usage.input_tokens + resp.usage.output_tokens,
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
  async createCompletion({
    model,
    apiKey,
    messages,
    tools,
    temperature,
    maxTokens,
    signal,
  }: CompletionInput): Promise<CompletionResult> {
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
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: model.name,
      max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(includeTemperature ? { temperature } : {}),
      messages: anthropicMessages,
      ...(system ? { system } : {}),
      ...(anthropicTools ? { tools: anthropicTools } : {}),
    };

    log.debug('createCompletion via Anthropic SDK', {
      model: model.name,
      toolCount: anthropicTools?.length || 0,
      hasSystem: Boolean(system),
    });

    // The abort signal (Stop button) cancels the in-flight HTTP request.
    let resp: Anthropic.Message;
    try {
      resp = await client.messages.create(params, signal ? { signal } : undefined);
    } catch (err) {
      // Some models (e.g. claude-opus-4-7+) reject `temperature` with a 400.
      // When not yet covered by the static denylist, auto-retry without it.
      if (
        err instanceof Anthropic.BadRequestError &&
        err.message.includes('temperature') &&
        err.message.toLowerCase().includes('deprecated') &&
        'temperature' in params
      ) {
        log.warn(
          'Anthropic API rejected temperature for model; retrying without it. ' +
            'Consider adding this model to TEMPERATURE_DEPRECATED_SUBSTRINGS.',
          { model: model.name }
        );
        const paramsWithoutTemp = { ...params };
        delete (paramsWithoutTemp as Partial<typeof paramsWithoutTemp>).temperature;
        resp = await client.messages.create(paramsWithoutTemp, signal ? { signal } : undefined);
      } else {
        throw err;
      }
    }
    return { completion: toChatCompletion(model.name, resp) };
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
   * CompletionResult containing an OpenAI-shaped ChatCompletion.
   */
  async createStreamCompletion({
    model,
    apiKey,
    messages,
    tools,
    temperature,
    maxTokens,
    signal,
  }: CompletionInput): Promise<CompletionResult> {
    const client = new Anthropic({
      apiKey,
      ...(model.baseUrl ? { baseURL: model.baseUrl } : {}),
      timeout: LLM_REQUEST_TIMEOUT_MS,
    });

    const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
    const anthropicTools = toAnthropicTools(tools);

    // NOTE: anthropicModelSupportsTemperature is now async (changed by issue #275).
    const includeTemperature = await anthropicModelSupportsTemperature(model.name, client);
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: model.name,
      max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(includeTemperature ? { temperature } : {}),
      messages: anthropicMessages,
      ...(system ? { system } : {}),
      ...(anthropicTools ? { tools: anthropicTools } : {}),
    };

    log.debug('createStreamCompletion via Anthropic SDK', {
      model: model.name,
      toolCount: anthropicTools?.length ?? 0,
      hasSystem: Boolean(system),
    });

    let resp: Anthropic.Message;
    try {
      const stream = client.messages.stream(
        params as Parameters<typeof client.messages.stream>[0],
        signal ? { signal } : undefined
      );
      resp = await stream.finalMessage();
    } catch (err) {
      if (
        err instanceof Anthropic.BadRequestError &&
        err.message.includes('temperature') &&
        err.message.toLowerCase().includes('deprecated') &&
        'temperature' in params
      ) {
        log.warn(
          'Anthropic API (streaming) rejected temperature for model; retrying without it. ' +
            'Consider adding this model to TEMPERATURE_DEPRECATED_SUBSTRINGS.',
          { model: model.name }
        );
        const paramsWithoutTemp = { ...params };
        delete (paramsWithoutTemp as Partial<typeof paramsWithoutTemp>).temperature;
        const retryStream = client.messages.stream(
          paramsWithoutTemp as Parameters<typeof client.messages.stream>[0],
          signal ? { signal } : undefined
        );
        resp = await retryStream.finalMessage();
      } else {
        throw err;
      }
    }
    return { completion: toChatCompletion(model.name, resp) };
  }
}
