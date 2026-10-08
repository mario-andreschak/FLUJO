import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { mcpService } from '@/backend/services/mcp';
import { formatErrorResponse } from '@/utils/mcp/utils';
import { json } from '../../../_helpers';

const log = createLogger('app/api/mcp/servers/[name]/status/route');

type RouteContext = { params: Promise<{ name: string }> };

/**
 * GET /api/mcp/servers/{name}/status
 * Get the live connection status of a server.
 *
 * Always responds 200 (even when the server is in an error state) so the client can
 * distinguish "server is down" from "the status request itself failed".
 */
async function GET_handler(_request: NextRequest, { params }: RouteContext) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const { name } = await params;
    const status = await mcpService.getServerStatus(name);
    // Attach the resource list version counter so the frontend can detect a stale
    // listing and auto-refresh the MCP Capabilities Manager without user intervention.
    const statusWithVersion = {
      ...status,
      resourceListVersion: mcpService.getResourceListVersion(name),
    };
    return json(statusWithVersion, 200);
  } catch (error) {
    log.error('Error handling GET request', error);
    return json(formatErrorResponse(error), 500);
  }
}

export const GET = withWorkspaceRoute(GET_handler);
