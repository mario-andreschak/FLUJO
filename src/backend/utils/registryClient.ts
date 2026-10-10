/**
 * HTTP client for the official MCP Registry (registry.modelcontextprotocol.io),
 * shared by the /api/mcp-registry proxy route and the Spotlight refresh service.
 *
 * Node-only (uses the built-in http2 module) — do not import from client code.
 */
import http2 from 'http2';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/utils/registryClient');

export interface RegistryRequestOptions {
  /** Optional hard bound on decompressed/raw UTF-8 response bytes. */
  maxBytes?: number;
  signal?: AbortSignal;
}

class RegistryResponseLimitError extends Error {
  constructor() { super('MCP Registry response exceeded its byte limit'); }
}

export const REGISTRY_ORIGIN = 'https://registry.modelcontextprotocol.io';

/**
 * GET a registry URL over HTTP/2.
 *
 * The registry's load balancer reliably answers HTTP/2 but lets HTTP/1.1
 * requests to the API paths stall until timeout (verified: `curl` succeeds in
 * ~0.5s while `curl --http1.1` and Node's HTTP/1.1-only `fetch` hang). Node's
 * built-in http2 client avoids that without extra dependencies.
 */
function http2GetJson(url: URL, timeoutMs: number, options: RegistryRequestOptions): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(options.signal.reason); return; }
    const client = http2.connect(url.origin);
    let settled = false;
    const deadline = setTimeout(() => finish(() => reject(new Error('MCP Registry request timed out'))), timeoutMs);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      options.signal?.removeEventListener('abort', onAbort);
      fn();
      client.destroy();
    };
    const onAbort = () => finish(() => reject(options.signal?.reason ?? new DOMException('Aborted', 'AbortError')));

    client.setTimeout(timeoutMs, () =>
      finish(() => reject(new Error(`HTTP/2 session timed out after ${timeoutMs}ms`)))
    );
    client.on('error', err => finish(() => reject(err)));

    const req = client.request({
      ':method': 'GET',
      ':path': url.pathname + url.search,
      accept: 'application/json'
    });
    req.setTimeout(timeoutMs, () =>
      finish(() => reject(new Error(`HTTP/2 request timed out after ${timeoutMs}ms`)))
    );
    req.on('error', err => finish(() => reject(err)));

    let status = 0;
    let body = '';
    let bytes = 0;
    req.setEncoding('utf8');
    req.on('response', headers => {
      status = Number(headers[':status'] || 0);
    });
    req.on('data', chunk => {
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (options.maxBytes !== undefined && bytes > options.maxBytes) {
        finish(() => reject(new RegistryResponseLimitError()));
        return;
      }
      body += chunk;
    });
    req.on('end', () => finish(() => resolve({ status, body })));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) { onAbort(); return; }
    req.end();
  });
}

/** HTTP/1.1 fallback for environments where HTTP/2 is blocked (e.g. some proxies). */
async function http1GetJson(url: URL, timeoutMs: number, options: RegistryRequestOptions): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal,
      cache: 'no-store',
      redirect: 'error',
    });
    if (options.maxBytes === undefined) return { status: response.status, body: await response.text() };
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      if (reader) while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > options.maxBytes) throw new RegistryResponseLimitError();
        chunks.push(value);
      }
    } finally {
      await reader?.cancel().catch(() => {});
    }
    return { status: response.status, body: Buffer.concat(chunks).toString('utf8') };
  } finally {
    clearTimeout(timeout);
  }
}

/** GET a registry URL, preferring HTTP/2 with an HTTP/1.1 fallback. */
export async function registryGetRaw(
  url: URL,
  timeoutMs: number,
  options: RegistryRequestOptions = {},
): Promise<{ status: number; body: string }> {
  const startedAt = Date.now();
  options.signal?.throwIfAborted();
  try {
    return await http2GetJson(url, timeoutMs, options);
  } catch (h2Error) {
    options.signal?.throwIfAborted();
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    // A large body or an exhausted deadline must not trigger a second download.
    if (h2Error instanceof RegistryResponseLimitError || remainingMs <= 0) throw h2Error;
    log.warn(
      'HTTP/2 request to registry failed, retrying over HTTP/1.1',
      h2Error instanceof Error ? h2Error.message : h2Error
    );
    return await http1GetJson(url, remainingMs, options);
  }
}

/** GET a registry URL and parse the JSON body; throws on non-2xx status. */
export async function registryGetJson(url: URL, timeoutMs: number, options: RegistryRequestOptions = {}): Promise<unknown> {
  const result = await registryGetRaw(url, timeoutMs, options);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`MCP Registry responded with status ${result.status}`);
  }
  return JSON.parse(result.body);
}
