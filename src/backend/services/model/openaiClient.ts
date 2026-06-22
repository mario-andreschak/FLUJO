import http from 'node:http';
import https from 'node:https';
import OpenAI from 'openai';

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
  const { apiKey, baseURL, maxRetries = 2, timeout = 10 * 60 * 1000 } = opts;

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
  });
}
