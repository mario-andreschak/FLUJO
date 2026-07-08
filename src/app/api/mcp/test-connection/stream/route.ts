import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { mcpService } from '@/backend/services/mcp';
import { MCPServerConfig } from '@/shared/types/mcp';
import { formatErrorResponse } from '@/utils/mcp/utils';
import { createNdjsonStreamResponse } from '@/backend/utils/ndjsonStream';
import { json } from '../../_helpers';

const log = createLogger('app/api/mcp/test-connection/stream/route');

// Node runtime: testConnection spawns child processes / uses Node TLS trust, which the
// edge runtime cannot do.
export const runtime = 'nodejs';

/**
 * POST /api/mcp/test-connection/stream
 *
 * Streaming variant of POST /api/mcp/test-connection (issue #64). Runs the same real MCP
 * handshake probe, but forwards the server's stderr and lifecycle markers to the browser
 * as NDJSON lines while the handshake is in progress, so a slow cold `npx`/`uvx` start
 * fills the console live instead of looking frozen. The non-streaming route is preserved
 * unchanged for backward compatibility.
 *
 * The body is the server config to test. The response body is a stream of
 * {@link import('@/shared/types/streaming').TestConnectionEvent} objects, one per line,
 * terminated by a single `{ type: 'result', ... }` event.
 */
export async function POST(request: NextRequest) {
  log.debug('Entering POST method');

  let config: MCPServerConfig;
  try {
    config = (await request.json()) as MCPServerConfig;
  } catch (error) {
    log.error('Failed to parse request body', error);
    return json({ success: false, ...formatErrorResponse(error) }, 400);
  }

  if (!config || !config.transport) {
    return json({ success: false, error: 'Missing or invalid server config' }, 400);
  }

  return createNdjsonStreamResponse(async (emit) => {
    // testConnection emits status/stderr live via onOutput and also emits the final
    // `result` event itself, so we simply forward everything it produces.
    await mcpService.testConnection(config, emit);
  }, { signal: request.signal });
}
