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
export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    const { name } = await params;
    const status = await mcpService.getServerStatus(name);
    return json(status, 200);
  } catch (error) {
    log.error('Error handling GET request', error);
    return json(formatErrorResponse(error), 500);
  }
}
