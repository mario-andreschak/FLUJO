import axios, { AxiosError } from 'axios';
import OpenAI from 'openai';
import { createLogger } from '@/utils/logger';
import { ModelTestAttempt, ModelTestResult } from '@/shared/types/model/response';
import { Model } from '@/shared/types/model';
import { ModelAdapter } from '@/shared/types/model/provider';
import { createOpenAIClient } from './openaiClient';
import { getCompletionAdapter } from './adapters';

const log = createLogger('backend/services/model/testConnection');

// A deliberately tiny prompt: we only care about transport + auth, not output.
const TEST_MESSAGES = [
  { role: 'user' as const, content: "Reply with the single word: pong" },
];

// Errors whose message points at the keep-alive / connection-reuse transport
// bug rather than a genuine provider rejection.
const TRANSPORT_ERROR_PATTERNS = [
  'premature close',
  'econnreset',
  'socket hang up',
  'epipe',
  'und_err',
  'terminated',
  'network',
  'fetch failed',
];

function looksLikeTransportError(message: string | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return TRANSPORT_ERROR_PATTERNS.some(p => m.includes(p));
}

function pickHeaders(headers: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const keep = ['retry-after', 'x-ratelimit-reset', 'x-ratelimit-remaining', 'x-ratelimit-limit'];
  const out: Record<string, string> = {};
  for (const k of Object.keys(headers)) {
    if (keep.includes(k.toLowerCase())) out[k.toLowerCase()] = String(headers[k]);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Attempt the test request via the OpenAI SDK (the same hardened client the
 * flow engine uses). This is the authoritative "will my flows work" check.
 */
async function attemptViaSdk(modelName: string, baseUrl: string | undefined, apiKey: string): Promise<ModelTestAttempt> {
  const started = Date.now();
  try {
    // maxRetries: 0 here so the user sees the raw first-attempt outcome rather
    // than a silently-retried result; flows still use the default retries.
    const client = createOpenAIClient({ apiKey, baseURL: baseUrl, maxRetries: 0 });
    const completion = await client.chat.completions.create({
      model: modelName,
      messages: TEST_MESSAGES,
      temperature: 0,
    });
    const durationMs = Date.now() - started;

    // Some providers (OpenRouter) return 200 with an error object in the body.
    const maybeError = (completion as any)?.error;
    if (maybeError) {
      return {
        ok: false,
        durationMs,
        error: {
          message: maybeError.message || 'Provider returned an error in the response body',
          code: maybeError.code !== undefined ? String(maybeError.code) : undefined,
          type: maybeError.type,
          body: maybeError,
        },
      };
    }

    return {
      ok: true,
      status: 200,
      durationMs,
      content: completion.choices?.[0]?.message?.content?.slice(0, 500) ?? '',
      usage: completion.usage as unknown as Record<string, unknown> | undefined,
    };
  } catch (error) {
    const durationMs = Date.now() - started;
    if (error instanceof OpenAI.APIError) {
      const body = (error as any).error;
      const headers = pickHeaders(error.headers as Record<string, unknown> | undefined);
      return {
        ok: false,
        status: error.status,
        durationMs,
        error: {
          name: error.name,
          message: error.message,
          status: error.status,
          code: error.code ?? undefined,
          type: error.type ?? undefined,
          param: error.param ?? undefined,
          retryAfter: headers?.['retry-after'],
          headers,
          body,
          stack: error.stack,
        },
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      durationMs,
      error: {
        name: error instanceof Error ? error.name : undefined,
        message,
        code: (error as any)?.code,
        stack: error instanceof Error ? error.stack : undefined,
      },
    };
  }
}

/**
 * Attempt the same request via axios. axios uses Node's http(s) module directly
 * (no node-fetch/agentkeepalive layer), so if the SDK fails with a transport
 * error but axios succeeds, the failure is the keep-alive/transport bug, not
 * the provider or the key.
 */
async function attemptViaAxios(modelName: string, baseUrl: string | undefined, apiKey: string): Promise<ModelTestAttempt> {
  const started = Date.now();
  const base = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  try {
    const response = await axios.post(
      url,
      { model: modelName, messages: TEST_MESSAGES, temperature: 0 },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 10 * 60 * 1000,
        // Don't throw on non-2xx; we inspect the status ourselves below.
        validateStatus: () => true,
      }
    );
    const durationMs = Date.now() - started;
    const data = response.data;

    if (response.status < 200 || response.status >= 300 || data?.error) {
      const body = data?.error ?? data;
      return {
        ok: false,
        status: response.status,
        durationMs,
        error: {
          message: body?.message || `HTTP ${response.status}`,
          status: response.status,
          code: body?.code !== undefined ? String(body.code) : undefined,
          type: body?.type,
          headers: pickHeaders(response.headers as unknown as Record<string, unknown>),
          body,
        },
      };
    }

    return {
      ok: true,
      status: response.status,
      durationMs,
      content: data?.choices?.[0]?.message?.content?.slice(0, 500) ?? '',
      usage: data?.usage,
    };
  } catch (error) {
    const durationMs = Date.now() - started;
    const axErr = error as AxiosError;
    return {
      ok: false,
      status: axErr.response?.status,
      durationMs,
      error: {
        name: axErr.name,
        message: axErr.message,
        status: axErr.response?.status,
        code: (axErr.code as string | undefined),
        body: axErr.response?.data,
        stack: axErr.stack,
      },
    };
  }
}

/**
 * Native-adapter test: run a minimal completion through the model's adapter
 * (Anthropic / Gemini / Claude subscription). These providers don't speak the
 * OpenAI wire protocol, so the SDK+axios cross-check doesn't apply — a single
 * adapter round-trip is the authoritative check.
 */
async function attemptViaAdapter(model: Model, apiKey: string): Promise<ModelTestAttempt> {
  const started = Date.now();
  try {
    const adapter = getCompletionAdapter(model);
    const { completion } = await adapter.createCompletion({
      model,
      apiKey,
      messages: [...TEST_MESSAGES],
      temperature: 0,
    });
    const durationMs = Date.now() - started;

    const maybeError = (completion as { error?: { message?: string } } | undefined)?.error;
    if (maybeError) {
      return { ok: false, durationMs, error: { message: maybeError.message || 'Provider returned an error' } };
    }

    return {
      ok: true,
      status: 200,
      durationMs,
      content: completion.choices?.[0]?.message?.content?.slice(0, 500) ?? '',
      usage: completion.usage as unknown as Record<string, unknown> | undefined,
    };
  } catch (error) {
    const durationMs = Date.now() - started;
    return {
      ok: false,
      durationMs,
      error: {
        name: error instanceof Error ? error.name : undefined,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
    };
  }
}

function buildDiagnosis(sdk: ModelTestAttempt, axiosAttempt: ModelTestAttempt): string {
  if (sdk.ok && axiosAttempt.ok) {
    return 'Both the SDK and axios reached the provider successfully. The model, key, and base URL are working.';
  }
  if (sdk.ok && !axiosAttempt.ok) {
    return 'The SDK succeeded but the axios cross-check failed. This is unusual; the model is usable via flows. ' +
      `axios error: ${axiosAttempt.error?.message ?? 'unknown'}.`;
  }
  if (!sdk.ok && axiosAttempt.ok) {
    if (looksLikeTransportError(sdk.error?.message)) {
      return 'The SDK failed with a transport error ("' + (sdk.error?.message ?? '') +
        '") while axios succeeded against the same endpoint and key. This is the keep-alive / "Premature close" ' +
        'connection-reuse bug, not a provider or key problem. The flow engine now disables keep-alive to avoid it.';
    }
    return 'The SDK failed but axios succeeded. Likely an SDK/transport issue rather than the provider or key. ' +
      `SDK error: ${sdk.error?.message ?? 'unknown'}.`;
  }
  // Both failed.
  const status = sdk.error?.status ?? axiosAttempt.error?.status;
  if (status === 401 || status === 403) {
    return 'Both attempts failed with an auth error. The API key is missing, invalid, or lacks access to this model.';
  }
  if (status === 429) {
    const retry = sdk.error?.retryAfter ?? sdk.error?.headers?.['retry-after'];
    return 'Both attempts were rate-limited (429) by the provider' +
      (retry ? ` (retry after ${retry}s)` : '') +
      '. For OpenRouter ":free" models this is a hard daily/throughput limit — try a paid model or wait.';
  }
  if (status === 404) {
    return 'Both attempts returned 404. The model name is probably wrong for this provider/base URL.';
  }
  return 'Both the SDK and axios failed to reach the provider. ' +
    `SDK error: ${sdk.error?.message ?? 'unknown'}; axios error: ${axiosAttempt.error?.message ?? 'unknown'}. ` +
    'Check the base URL and network connectivity.';
}

/**
 * Run a direct, flow-engine-free connectivity test for a model. Performs a
 * minimal chat completion via the OpenAI SDK and via axios, then summarizes.
 *
 * The caller is responsible for resolving/decrypting the API key before calling
 * this (so secrets never round-trip through the wire to the browser).
 */
export async function testModelConnection(params: {
  modelName: string;
  baseUrl?: string;
  apiKey: string;
  provider?: string;
  adapter?: ModelAdapter;
  model?: Model;
}): Promise<ModelTestResult> {
  const { modelName, baseUrl, apiKey, provider, adapter, model } = params;
  log.info('Testing model connection', { modelName, baseUrl, provider, adapter, hasApiKey: Boolean(apiKey) });

  // Native adapters (Anthropic / Gemini / Claude subscription) don't speak the
  // OpenAI protocol, so run a single adapter round-trip instead of the
  // SDK+axios cross-check. Requires the stored Model object.
  if (adapter && adapter !== 'openai' && model) {
    const sdk = await attemptViaAdapter(model, apiKey);
    const naAxios: ModelTestAttempt = {
      ok: sdk.ok,
      durationMs: 0,
      content: 'n/a — native SDK adapter; the axios cross-check applies only to OpenAI-compatible endpoints.',
    };
    const diagnosis = sdk.ok
      ? `Connected successfully via the ${adapter} adapter (native SDK). The model and credentials are working.`
      : `The native ${adapter} adapter failed: ${sdk.error?.message ?? 'unknown error'}. ` +
        `Check the model name and the ${adapter === 'claude-cli' ? 'OAuth token (claude setup-token) and that the `claude` CLI is installed' : 'API key'}.`;
    return { ok: sdk.ok, model: modelName, baseUrl, provider, sdk, axios: naAxios, diagnosis };
  }

  // Run both transports in parallel — they are independent and this halves the
  // wait. Each fully captures its own outcome, so neither can fail the other.
  const [sdk, axiosAttempt] = await Promise.all([
    attemptViaSdk(modelName, baseUrl, apiKey),
    attemptViaAxios(modelName, baseUrl, apiKey),
  ]);

  const result: ModelTestResult = {
    ok: sdk.ok,
    model: modelName,
    baseUrl,
    provider,
    sdk,
    axios: axiosAttempt,
    diagnosis: buildDiagnosis(sdk, axiosAttempt),
  };

  log.info('Model connection test complete', { modelName, sdkOk: sdk.ok, axiosOk: axiosAttempt.ok });
  return result;
}
