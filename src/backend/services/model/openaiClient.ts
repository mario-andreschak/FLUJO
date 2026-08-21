import OpenAI, { AzureOpenAI } from 'openai';
import { Agent, fetch as undiciFetch } from 'undici';
import { LLM_REQUEST_TIMEOUT_MS } from '@/shared/config/timeouts';
import { AZURE_OPENAI_DEFAULT_API_VERSION } from '@/shared/types/model/provider';

export { AZURE_OPENAI_DEFAULT_API_VERSION } from '@/shared/types/model/provider';

/**
 * OpenAI SDK 5+ uses Fetch instead of node-fetch's `httpAgent` option. Keep a
 * module-wide Undici dispatcher so client construction stays cheap while
 * `pipelining: 0` sends `Connection: close` and prevents stale socket reuse.
 */
const openAITransport = new Agent({
  pipelining: 0,
  // Undici otherwise applies its own 300-second header/body inactivity
  // timeouts. The OpenAI SDK retries those failures twice by default, turning
  // one slow local-model request into a misleading ~15-minute timeout even
  // though the SDK-level request ceiling below is five hours. Keep every
  // transport layer on the same budget so the SDK timeout remains authoritative.
  headersTimeout: LLM_REQUEST_TIMEOUT_MS,
  bodyTimeout: LLM_REQUEST_TIMEOUT_MS,
});

// The SDK's Fetch alias is expressed in terms of the DOM Request type while
// Undici adds Node-only fields such as `duplex`. The runtime signatures are
// compatible for the URL + RequestInit calls the SDK makes; keep the cast at
// this single transport boundary instead of leaking it into every client.
const openAIFetch = undiciFetch as unknown as typeof globalThis.fetch;

/**
 * Options for {@link createOpenAIClient}.
 */
export interface CreateOpenAIClientOptions {
  apiKey: string;
  baseURL?: string;
  /** SDK-level retries for transient failures (429 / 5xx / connection errors). */
  maxRetries?: number;
  /** Per-request timeout in milliseconds. */
  timeout?: number;
  /** Extra headers sent with every request (e.g. provider attribution headers). */
  defaultHeaders?: Record<string, string>;
}

export interface CreateAzureOpenAIClientOptions {
  apiKey: string;
  endpoint: string;
  deployment: string;
  apiVersion?: string;
  /** SDK-level retries for transient failures (429 / 5xx / connection errors). */
  maxRetries?: number;
  /** Per-request timeout in milliseconds. */
  timeout?: number;
}

/**
 * App-attribution headers some OpenAI-compatible routers accept so requests are
 * identifiable as coming from FLUJO. Requesty (issue 88) and OpenRouter
 * (issue 136) both honour this HTTP-Referer / X-Title pair and surface it in
 * their analytics dashboards. Other providers are left untouched to keep their
 * existing wire behaviour unchanged.
 */
export function getProviderDefaultHeaders(
  provider?: string
): Record<string, string> | undefined {
  if (provider === 'requesty' || provider === 'openrouter') {
    return {
      'HTTP-Referer': 'https://flujo.com.co',
      'X-Title': 'FLUJO',
    };
  }
  return undefined;
}

/**
 * Build an OpenAI SDK client with the Node transport tuned to avoid the
 * intermittent "Premature close" / socket hang-up failures seen against some
 * providers (notably OpenRouter) on fresh installs.
 *
 * Root cause: reusing keep-alive TCP connections can race a provider — or an
 * intermediate proxy / load balancer — silently dropping an idle pooled
 * connection. The next request grabs the dead socket and surfaces a premature
 * close / ECONNRESET. This is a transport/connection-reuse problem, not a
 * network MTU or provider problem.
 *
 * Fix: pair Undici's fetch implementation with an Undici dispatcher configured
 * with `pipelining: 0`. Undici documents that value as disabling keep-alive
 * connections, preserving the old SDK transport's `keepAlive: false` behavior.
 * The cost is one extra TCP/TLS handshake per call, which is negligible next to
 * LLM latency. We also set a generous timeout and keep SDK retries on so
 * transient 429/5xx still get a second chance.
 */
export function createOpenAIClient(opts: CreateOpenAIClientOptions): OpenAI {
  const { apiKey, baseURL, maxRetries = 2, timeout = LLM_REQUEST_TIMEOUT_MS, defaultHeaders } = opts;

  return new OpenAI({
    apiKey,
    baseURL,
    fetch: openAIFetch,
    fetchOptions: { dispatcher: openAITransport },
    maxRetries,
    timeout,
    ...(defaultHeaders ? { defaultHeaders } : {}),
  });
}

/** Build the deployment-aware Azure OpenAI SDK client on the shared transport. */
export function createAzureOpenAIClient(opts: CreateAzureOpenAIClientOptions): AzureOpenAI {
  const {
    apiKey,
    endpoint,
    deployment,
    apiVersion = AZURE_OPENAI_DEFAULT_API_VERSION,
    maxRetries = 2,
    timeout = LLM_REQUEST_TIMEOUT_MS,
  } = opts;

  return new AzureOpenAI({
    apiKey,
    endpoint,
    deployment,
    apiVersion,
    fetch: openAIFetch,
    fetchOptions: { dispatcher: openAITransport },
    maxRetries,
    timeout,
  });
}
