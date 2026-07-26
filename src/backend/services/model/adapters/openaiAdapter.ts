import OpenAI from 'openai';
import { createLogger } from '@/utils/logger';
import { createOpenAIClient, getProviderDefaultHeaders } from '../openaiClient';
import { CompletionAdapter, CompletionInput, CompletionResult } from './types';
import { withTransientRetry } from '@/backend/utils/transientRetry';

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

const endpointKey = (provider?: string, baseUrl?: string) => `${provider ?? 'openai'}|${baseUrl ?? ''}`;

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
  async createCompletion({
    model,
    apiKey,
    messages,
    tools,
    temperature,
    maxTokens,
    signal,
    promptCacheKey,
  }: CompletionInput): Promise<CompletionResult> {
    const openai = createOpenAIClient({
      apiKey,
      baseURL: model.baseUrl,
      // Provider attribution (Requesty: HTTP-Referer / X-Title, issue 88).
      defaultHeaders: getProviderDefaultHeaders(model.provider),
    });

    const requestParams: OpenAI.Chat.ChatCompletionCreateParams = {
      model: model.name,
      messages,
      temperature,
    };
    // Only send a cap when one was resolved; omitting it preserves the previous
    // "no max_tokens" default behavior.
    if (typeof maxTokens === 'number') {
      requestParams.max_tokens = maxTokens;
    }
    if (tools && tools.length > 0) {
      requestParams.tools = tools;
    }

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

    log.debug('createCompletion via OpenAI-compatible API', {
      model: model.name,
      baseUrl: model.baseUrl,
      toolCount: tools?.length || 0,
      promptCacheKey: sendCacheKey ? promptCacheKey : undefined,
    });

    // No `stream: true`, so the SDK resolves to a ChatCompletion. The abort
    // signal (Stop button) cancels the in-flight HTTP request.
    // withTransientRetry re-issues the entire request when a transient
    // transport error (ECONNRESET, "Invalid response body", …) is detected
    // while reading the response body — after the provider has already sent
    // HTTP 200 OK, where the SDK's own maxRetries is no longer in the path.
    // Each attempt gets its own body object rather than mutating a shared one,
    // so the params already handed to the SDK are never rewritten underneath it.
    const send = (withCacheKey: boolean) => {
      const body = withCacheKey
        ? { ...requestParams, prompt_cache_key: promptCacheKey }
        : requestParams;
      return withTransientRetry(
        () =>
          openai.chat.completions.create(
            body as OpenAI.Chat.ChatCompletionCreateParams,
            signal ? { signal } : undefined
          ),
        { signal }
      ) as Promise<OpenAI.Chat.Completions.ChatCompletion>;
    };

    try {
      return { completion: await send(sendCacheKey) };
    } catch (error) {
      // A gateway that rejects `prompt_cache_key` must not break the call: drop
      // the parameter permanently for this endpoint and retry once without it.
      // Any other error propagates untouched.
      if (sendCacheKey && isPromptCacheKeyRejection(error)) {
        rejectedPromptCacheKey.add(endpoint);
        log.warn('Provider rejected prompt_cache_key; disabling it for this endpoint and retrying', {
          provider: model.provider,
          baseUrl: model.baseUrl,
        });
        return { completion: await send(false) };
      }
      throw error;
    }
  }
}
