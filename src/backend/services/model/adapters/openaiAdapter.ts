import OpenAI from 'openai';
import { createLogger } from '@/utils/logger';
import { createOpenAIClient, getProviderDefaultHeaders } from '../openaiClient';
import { CompletionAdapter, CompletionInput, CompletionResult } from './types';
import { withTransientRetry } from '@/backend/utils/transientRetry';
import { v4 as uuidv4 } from 'uuid';
import { extractAssistantMedia } from './messageUtils';
import type { ModelMediaPart } from '@/shared/types/model/media';
import { stripOpenAiPromptCacheBreakpoints } from './openaiPromptCaching';
import type { Model } from '@/shared/types/model';

const log = createLogger('backend/services/model/adapters/openaiAdapter');

/**
 * Providers known to accept OpenAI's `prompt_cache_key` cache-routing parameter.
 *
 * Kept as an allowlist rather than sent everywhere because this codebase has
 * already been bitten by strict OpenAI-compatible gateways 400-ing on parameters
 * they don't recognise (the Requesty investigation). The allowlist is only the
 * first gate though — `rejectedPromptCacheKey` below permanently disables the
 * parameter for any endpoint that turns out to reject it anyway, so a wrong guess
 * here costs one retried request, not a broken provider.
 */
const PROMPT_CACHE_KEY_PROVIDERS = new Set(['openai', 'openrouter']);

/**
 * Endpoints (provider + baseURL) that rejected `prompt_cache_key`. Populated at
 * runtime from a 400 naming the parameter, so the retry happens once per process
 * per endpoint instead of on every call. In-process only: a restart costs at most
 * one more retried request.
 */
const rejectedPromptCacheKey = new Set<string>();
/** Endpoints/models that rejected GPT-5.6 explicit cache controls. */
const rejectedPromptCacheControls = new Set<string>();

const endpointKey = (provider?: string, baseUrl?: string) => `${provider ?? 'openai'}|${baseUrl ?? ''}`;

function applyRequestedOutputModalities(
  body: Record<string, unknown>,
  outputModalities?: string[],
): void {
  const requested = (outputModalities ?? [])
    .map(modality => modality.toLowerCase())
    .filter(modality => ['text', 'image', 'audio', 'video'].includes(modality));
  if (!requested.some(modality => modality !== 'text')) return;

  // OpenRouter image models require `modalities: ["image", "text"]`; OpenAI
  // audio Chat Completions require audio configuration. Keep this duck-typed
  // because the installed OpenAI SDK's union intentionally knows only the
  // modalities supported by OpenAI's own Chat endpoint.
  body.modalities = Array.from(new Set(requested));
  if (requested.includes('audio')) {
    body.audio = { voice: 'alloy', format: 'mp3' };
  }
}

/**
 * True when a provider error is specifically "I don't know this parameter",
 * naming `prompt_cache_key`. Deliberately narrow: a 400 for any OTHER reason must
 * propagate unchanged rather than be masked by a silent retry.
 */
function isPromptCacheKeyRejection(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status !== 400 && status !== 422) return false;
  const haystack = [
    (err as { message?: string })?.message,
    JSON.stringify((err as { error?: unknown })?.error ?? ''),
  ]
    .join(' ')
    .toLowerCase();
  if (!haystack.includes('prompt_cache_key')) return false;
  return (
    haystack.includes('unknown') ||
    haystack.includes('unrecognized') ||
    haystack.includes('unsupported') ||
    haystack.includes('not allowed') ||
    haystack.includes('extra') ||
    haystack.includes('additional')
  );
}

/** True only for an unsupported explicit cache option/content marker. */
function isPromptCacheControlsRejection(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status !== 400 && status !== 422) return false;
  const haystack = [
    (err as { message?: string })?.message,
    JSON.stringify((err as { error?: unknown })?.error ?? ''),
  ]
    .join(' ')
    .toLowerCase();
  if (!haystack.includes('prompt_cache_options') && !haystack.includes('prompt_cache_breakpoint')) {
    return false;
  }
  return (
    haystack.includes('unknown') ||
    haystack.includes('unrecognized') ||
    haystack.includes('unsupported') ||
    haystack.includes('not allowed') ||
    haystack.includes('extra') ||
    haystack.includes('additional') ||
    haystack.includes('invalid')
  );
}

/**
 * The OpenAI-compatible adapter — FLUJO's original completion path. Used by
 * OpenAI, OpenRouter, X.ai, Ollama, and the "OpenAI Format" variants of Gemini
 * and Anthropic. Uses the shared hardened client (keep-alive disabled) to avoid
 * the intermittent "Premature close" transport bug.
 *
 * A thin `withTransientRetry` wrapper re-issues the HTTP request (up to 3
 * total attempts, 500 ms → 1 s back-off) when the provider resets the
 * connection while reading the response body — the ECONNRESET / "Invalid
 * response body" window that the OpenAI SDK's own `maxRetries` cannot cover.
 */
export class OpenAiAdapter implements CompletionAdapter {
  protected createClient(model: Model, apiKey: string): OpenAI {
    return createOpenAIClient({
      apiKey,
      baseURL: model.baseUrl,
      // Provider attribution (Requesty: HTTP-Referer / X-Title, issue 88).
      defaultHeaders: getProviderDefaultHeaders(model.provider),
    });
  }

  async createCompletion({
    model,
    apiKey,
    messages,
    tools,
    temperature,
    maxTokens,
    signal,
    onProviderAttempt,
    promptCacheKey,
    promptCacheMode,
  }: CompletionInput): Promise<CompletionResult> {
    const openai = this.createClient(model, apiKey);

    const requestParams: OpenAI.Chat.ChatCompletionCreateParams = {
      model: model.name,
      messages,
      temperature,
    };
    if (model.reasoningEffort) {
      requestParams.reasoning_effort =
        model.reasoningEffort as 'low' | 'medium' | 'high';
    }
    // Only send a cap when one was resolved; omitting it preserves the previous
    // "no max_tokens" default behavior.
    if (typeof maxTokens === 'number') {
      requestParams.max_tokens = maxTokens;
    }
    if (tools && tools.length > 0) {
      requestParams.tools = tools;
    }
    applyRequestedOutputModalities(
      requestParams as unknown as Record<string, unknown>,
      model.outputModalities,
    );

    // Cache-routing hint. OpenAI's automatic prompt cache is sharded, and without
    // this the routing hash comes from the prefix alone — so concurrent requests
    // sharing a prefix can scatter across cold machines and miss a cache that is
    // in fact warm. Not in the installed SDK's param type (added after 4.x), so
    // it is attached through a cast; it travels as a plain JSON body field.
    const endpoint = endpointKey(model.provider, model.baseUrl);
    const sendCacheKey =
      !!promptCacheKey &&
      PROMPT_CACHE_KEY_PROVIDERS.has(model.provider ?? 'openai') &&
      !rejectedPromptCacheKey.has(endpoint);
    const cacheControlsKey = `${endpoint}|${model.name}`;
    const sendCacheControls =
      promptCacheMode === 'explicit' &&
      model.provider === 'openai' &&
      !rejectedPromptCacheControls.has(cacheControlsKey);

    log.debug('createCompletion via OpenAI-compatible API', {
      model: model.name,
      baseUrl: model.baseUrl,
      toolCount: tools?.length || 0,
      promptCacheKey: sendCacheKey ? promptCacheKey : undefined,
      promptCacheMode: sendCacheControls ? promptCacheMode : undefined,
    });

    // No `stream: true`, so the SDK resolves to a ChatCompletion. The abort
    // signal (Stop button) cancels the in-flight HTTP request.
    // withTransientRetry re-issues the entire request when a transient
    // transport error (ECONNRESET, "Invalid response body", …) is detected
    // while reading the response body — after the provider has already sent
    // HTTP 200 OK, where the SDK's own maxRetries is no longer in the path.
    // Each attempt gets its own body object rather than mutating a shared one,
    // so the params already handed to the SDK are never rewritten underneath it.
    const send = (withCacheKey: boolean, withCacheControls: boolean) => {
      const baseParams = withCacheControls
        ? requestParams
        : {
            ...requestParams,
            messages: stripOpenAiPromptCacheBreakpoints(requestParams.messages),
          };
      const body = {
        ...baseParams,
        ...(withCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
        ...(withCacheControls ? { prompt_cache_options: { mode: 'explicit' as const } } : {}),
      };
      return withTransientRetry(
        () =>
          openai.chat.completions.create(
            body as OpenAI.Chat.ChatCompletionCreateParams,
            signal ? { signal } : undefined
          ),
        { signal, onAttempt: onProviderAttempt }
      ) as Promise<OpenAI.Chat.Completions.ChatCompletion>;
    };

    let useCacheKey = sendCacheKey;
    let useCacheControls = sendCacheControls;
    while (true) {
      try {
        const completion = await send(useCacheKey, useCacheControls);
        return {
          completion,
          media: extractAssistantMedia(completion.choices?.[0]?.message),
        };
      } catch (error) {
        // Negotiate the two cache capabilities independently. An endpoint may
        // support the routing key but not GPT-5.6 breakpoint controls (or vice
        // versa), so each rejected feature is removed once and the request is
        // retried with the remaining supported feature.
        if (useCacheControls && isPromptCacheControlsRejection(error)) {
          rejectedPromptCacheControls.add(cacheControlsKey);
          useCacheControls = false;
          log.warn('Provider rejected explicit prompt-cache controls; retrying without them', {
            provider: model.provider,
            model: model.name,
            baseUrl: model.baseUrl,
          });
          continue;
        }
        if (useCacheKey && isPromptCacheKeyRejection(error)) {
          rejectedPromptCacheKey.add(endpoint);
          useCacheKey = false;
          log.warn('Provider rejected prompt_cache_key; disabling it for this endpoint and retrying', {
            provider: model.provider,
            baseUrl: model.baseUrl,
          });
          continue;
        }
        throw error;
      }
    }
  }

  async createStreamCompletion({
    model,
    apiKey,
    messages,
    tools,
    temperature,
    maxTokens,
    signal,
    promptCacheKey,
    promptCacheMode,
    onModelDelta,
  }: CompletionInput): Promise<CompletionResult> {
    const openai = this.createClient(model, apiKey);
    const requestParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model: model.name,
      messages,
      temperature,
      stream: true,
      ...(model.reasoningEffort
        ? { reasoning_effort: model.reasoningEffort as 'low' | 'medium' | 'high' }
        : {}),
      ...(typeof maxTokens === 'number' ? { max_tokens: maxTokens } : {}),
      ...(tools?.length ? { tools } : {}),
      ...(['openai', 'openrouter'].includes(model.provider ?? 'openai')
        ? { stream_options: { include_usage: true } }
        : {}),
    };
    applyRequestedOutputModalities(
      requestParams as unknown as Record<string, unknown>,
      model.outputModalities,
    );
    const endpoint = endpointKey(model.provider, model.baseUrl);
    const sendCacheKey =
      !!promptCacheKey &&
      PROMPT_CACHE_KEY_PROVIDERS.has(model.provider ?? 'openai') &&
      !rejectedPromptCacheKey.has(endpoint);
    const cacheControlsKey = `${endpoint}|${model.name}`;
    const sendCacheControls =
      promptCacheMode === 'explicit' &&
      model.provider === 'openai' &&
      !rejectedPromptCacheControls.has(cacheControlsKey);
    const liveMessageId = `stream_${uuidv4()}`;

    const consume = async (
      withCacheKey: boolean,
      withCacheControls: boolean,
    ): Promise<CompletionResult> => {
      const baseParams = withCacheControls
        ? requestParams
        : {
            ...requestParams,
            messages: stripOpenAiPromptCacheBreakpoints(requestParams.messages),
          };
      const body = {
        ...baseParams,
        ...(withCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
        ...(withCacheControls ? { prompt_cache_options: { mode: 'explicit' as const } } : {}),
      };
      const stream = await openai.chat.completions.create(
        body as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
        signal ? { signal } : undefined,
      );

      let completionId = `chatcmpl_${uuidv4()}`;
      let created = Math.floor(Date.now() / 1000);
      let responseModel = model.name;
      let finishReason: OpenAI.Chat.Completions.ChatCompletion.Choice['finish_reason'] = 'stop';
      let content = '';
      let usage: OpenAI.Completions.CompletionUsage | undefined;
      const calls: OpenAI.ChatCompletionMessageFunctionToolCall[] = [];
      const media: ModelMediaPart[] = [];
      const seenMedia = new Set<string>();
      const streamedAudioChunks: string[] = [];
      let streamedAudioTranscript = '';

      const appendMedia = (part: ModelMediaPart) => {
        const key = `${part.type}|${part.url ?? ''}|${part.data ?? ''}|${part.mimeType ?? ''}`;
        if (seenMedia.has(key)) return;
        seenMedia.add(key);
        media.push(part);
        onModelDelta?.({ messageId: liveMessageId, mediaPart: part });
      };

      for await (const chunk of stream) {
        completionId = chunk.id || completionId;
        created = chunk.created || created;
        responseModel = chunk.model || responseModel;
        usage = chunk.usage ?? usage;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const deltaContent = choice.delta.content as unknown;
        if (typeof deltaContent === 'string' && deltaContent) {
          content += deltaContent;
          onModelDelta?.({ messageId: liveMessageId, contentDelta: deltaContent });
        } else if (Array.isArray(deltaContent)) {
          const textDelta = deltaContent
            .filter((part): part is { type: 'text'; text: string } =>
              part?.type === 'text' && typeof part.text === 'string'
            )
            .map(part => part.text)
            .join('');
          if (textDelta) {
            content += textDelta;
            onModelDelta?.({ messageId: liveMessageId, contentDelta: textDelta });
          }
        }
        const rawDelta = choice.delta as unknown as {
          audio?: { data?: string; transcript?: string; mime_type?: string; mimeType?: string };
        };
        if (rawDelta.audio?.data) streamedAudioChunks.push(rawDelta.audio.data);
        if (rawDelta.audio?.transcript) streamedAudioTranscript += rawDelta.audio.transcript;
        for (const part of extractAssistantMedia(choice.delta)) {
          // Chat audio arrives as append-only base64 deltas and must be joined
          // before it becomes a playable item. Other provider extensions (for
          // example OpenRouter `images`) are complete items.
          if (part.type !== 'audio' || !rawDelta.audio) appendMedia(part);
        }
        for (const part of extractAssistantMedia(chunk)) appendMedia(part);
        for (const part of choice.delta.tool_calls ?? []) {
          const index = part.index;
          const prior = calls[index];
          const id = part.id ?? prior?.id ?? `call_${uuidv4()}`;
          const nameDelta = part.function?.name ?? '';
          const argumentsDelta = part.function?.arguments ?? '';
          calls[index] = {
            id,
            type: 'function',
            function: {
              name: `${prior?.function.name ?? ''}${nameDelta}`,
              arguments: `${prior?.function.arguments ?? ''}${argumentsDelta}`,
            },
          };
          onModelDelta?.({
            messageId: liveMessageId,
            toolCallDelta: {
              index,
              ...(part.id ? { id: part.id } : {}),
              ...(nameDelta ? { nameDelta } : {}),
              ...(argumentsDelta ? { argumentsDelta } : {}),
            },
          });
        }
      }

      if (streamedAudioChunks.length > 0) {
        appendMedia({
          type: 'audio',
          data: Buffer.concat(
            streamedAudioChunks.map(chunk => Buffer.from(chunk, 'base64')),
          ).toString('base64'),
          mimeType: 'audio/mpeg',
          ...(streamedAudioTranscript ? { transcript: streamedAudioTranscript } : {}),
        });
      }

      return {
        liveMessageId,
        media,
        completion: {
          id: completionId,
          object: 'chat.completion',
          created,
          model: responseModel,
          choices: [{
            index: 0,
            finish_reason: finishReason,
            logprobs: null,
            message: {
              role: 'assistant',
              content: content || null,
              refusal: null,
              ...(calls.length ? { tool_calls: calls } : {}),
            },
          }],
          ...(usage ? { usage } : {}),
        },
      };
    };

    let useCacheKey = sendCacheKey;
    let useCacheControls = sendCacheControls;
    while (true) {
      try {
        return await consume(useCacheKey, useCacheControls);
      } catch (error) {
        if (useCacheControls && isPromptCacheControlsRejection(error)) {
          rejectedPromptCacheControls.add(cacheControlsKey);
          useCacheControls = false;
          log.warn('Provider rejected explicit prompt-cache controls while streaming; retrying without them', {
            provider: model.provider,
            model: model.name,
            baseUrl: model.baseUrl,
          });
          continue;
        }
        if (useCacheKey && isPromptCacheKeyRejection(error)) {
          rejectedPromptCacheKey.add(endpoint);
          useCacheKey = false;
          log.warn('Provider rejected prompt_cache_key while streaming; retrying without it', {
            provider: model.provider,
            baseUrl: model.baseUrl,
          });
          continue;
        }
        throw error;
      }
    }
  }
}
