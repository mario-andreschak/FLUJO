import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { mcpService } from '@/backend/services/mcp';
import { formatErrorResponse } from '@/utils/mcp/utils';
import { json } from '../../../_helpers';

const log = createLogger('app/api/mcp/servers/[name]/tools/route');

type RouteContext = { params: Promise<{ name: string }> };

/**
 * GET /api/mcp/servers/{name}/tools
 * List the tools exposed by a connected MCP server.
 *
 * Responds 200 with `{ tools, error? }`. A disconnected server yields an empty tool
 * list plus an `error` message rather than a non-2xx status, matching how the client
 * surfaces "server not connected yet".
 */
export async function GET(_request: NextRequest, { params }: RouteContext) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const { name } = await params;
    const result = await mcpService.listServerTools(name);
    return json(result, 200);
  } catch (error) {
    log.error('Error handling GET request', error);
    return json({ tools: [], ...formatErrorResponse(error) }, 500);
  }
}
