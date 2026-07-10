import http from 'node:http';
import https from 'node:https';
import OpenAI from 'openai';
import { LLM_REQUEST_TIMEOUT_MS } from '@/shared/config/timeouts';

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

/**
 * App-attribution headers some routers accept/expect so requests are
 * identifiable as coming from FLUJO. Requesty asks for these two headers
 * (issue 88); OpenRouter honours the same pair, but is left unchanged here
 * to keep its existing wire behaviour untouched.
 */
export function getProviderDefaultHeaders(
  provider?: string
): Record<string, string> | undefined {
  if (provider === 'requesty') {
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
 * Root cause: the OpenAI SDK's default Node transport (node-fetch +
 * `agentkeepalive`, see `openai/_shims/node-runtime.js`) reuses keep-alive TCP
 * connections from a pool. When the provider — or an intermediate proxy / load
 * balancer — silently drops an idle pooled connection, the next request grabs
 * the dead socket and node-fetch surfaces the read as "Premature close" /
 * ECONNRESET. This is the same class of bug as the undici keep-alive issue
 * reported elsewhere; it is a transport/connection-reuse problem, NOT a network
 * MTU or provider problem.
 *
 * Fix: hand the SDK an http(s) Agent with `keepAlive: false` so every request
 * opens a fresh connection. We pick http vs https from the baseURL protocol
 * (a local provider such as Ollama uses http://). The cost is one extra TCP/TLS
 * handshake per call, which is negligible next to LLM latency, in exchange for
 * eliminating the stale-socket race. We also set a generous timeout and keep
 * SDK retries on so transient 429/5xx still get a second chance.
 */
export function createOpenAIClient(opts: CreateOpenAIClientOptions): OpenAI {
  const { apiKey, baseURL, maxRetries = 2, timeout = LLM_REQUEST_TIMEOUT_MS, defaultHeaders } = opts;

  const useHttps = !baseURL || baseURL.trim().toLowerCase().startsWith('https');
  const httpAgent = useHttps
    ? new https.Agent({ keepAlive: false })
    : new http.Agent({ keepAlive: false });

  return new OpenAI({
    apiKey,
    baseURL,
    httpAgent,
    maxRetries,
    timeout,
    ...(defaultHeaders ? { defaultHeaders } : {}),
  });
}
