import { isLegacyRequest } from '@modelcontextprotocol/server';

/** Body bound for classifying a request before any MCP parsing (same as the modern handlers). */
export const MODERN_MCP_BODY_LIMIT = 256 * 1024;

export type McpHttpEra = 'legacy' | 'modern' | 'too-large';

/**
 * Decide which protocol generation an inbound HTTP request speaks, using the
 * official SDK's body-first classification. Reads only a clone of the body,
 * bounded before the SDK clones or parses it, so the route can still read it.
 */
export async function classifyMcpHttpRequest(request: Request): Promise<McpHttpEra> {
  if (!await bodyFits(request)) return 'too-large';
  return await isLegacyRequest(request) ? 'legacy' : 'modern';
}

async function bodyFits(request: Request): Promise<boolean> {
  const length = request.headers.get('content-length');
  if (length && Number(length) > MODERN_MCP_BODY_LIMIT) return false;
  if (!request.body) return true;
  const reader = request.clone().body!.getReader();
  let bytes = 0;
  try {
    while (true) {
      request.signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) return true;
      bytes += chunk.value.byteLength;
      if (bytes > MODERN_MCP_BODY_LIMIT) {
        // Cancelling one tee branch alone waits for the other. Retire both,
        // without delaying the rejection on an uncooperative source stream.
        void reader.cancel().catch(() => undefined);
        void request.body.cancel().catch(() => undefined);
        return false;
      }
    }
  } finally { reader.releaseLock(); }
}
