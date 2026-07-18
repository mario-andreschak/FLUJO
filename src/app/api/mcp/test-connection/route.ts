import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { mcpService } from '@/backend/services/mcp';
import { MCPServerConfig } from '@/shared/types/mcp';
import { formatErrorResponse } from '@/utils/mcp/utils';
import { json } from '../_helpers';

const log = createLogger('app/api/mcp/test-connection/route');

/**
 * POST /api/mcp/test-connection
 * Run a real MCP handshake against a (possibly unsaved) server config without registering
 * it as a managed client. The request body is the server config to test.
 *
 * This runs in the Next.js server process, so it can reach servers behind custom CAs and
 * send the configured custom headers (Authorization, X-SAP-*), which a browser fetch cannot.
 */
export async function POST(request: NextRequest) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  log.debug('Entering POST method');
  try {
    // storedName (the pre-edit server name from the modal) travels as a sibling field so
    // the backend can hydrate masked secret headers from the saved config even after a
    // rename (#137). Strip it off before the rest of the body is treated as the config.
    const { storedName, ...config } = (await request.json()) as MCPServerConfig & { storedName?: string };

    if (!config || !config.transport) {
      return json({ success: false, error: 'Missing or invalid server config' }, 400);
    }

    const result = await mcpService.testConnection(config as MCPServerConfig, undefined, { storedName });
    return json(result, 200);
  } catch (error) {
    log.error('Error handling POST request', error);
    return json({ success: false, ...formatErrorResponse(error) }, 500);
  }
}
