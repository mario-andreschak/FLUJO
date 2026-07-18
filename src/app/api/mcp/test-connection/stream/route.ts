import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
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
  // Local-only: testConnection spawns child processes from a caller-supplied
  // command, so reject cross-origin / DNS-rebinding callers before any stream
  // setup or spawn (#141).
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  log.debug('Entering POST method');

  let config: MCPServerConfig;
  let storedName: string | undefined;
  try {
    // storedName (the pre-edit server name from the modal) travels as a sibling field so the
    // backend can hydrate masked secret headers from the saved config even after a rename
    // (#137). Strip it off before the rest of the body is treated as the config.
    const { storedName: incomingStoredName, ...rest } = (await request.json()) as MCPServerConfig & { storedName?: string };
    storedName = incomingStoredName;
    config = rest as MCPServerConfig;
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
    await mcpService.testConnection(config, emit, { storedName });
  }, { signal: request.signal });
}
