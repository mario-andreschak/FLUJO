import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { mcpService } from '@/backend/services/mcp';
import { formatErrorResponse } from '@/utils/mcp/utils';
import { json } from '../../../../_helpers';

const log = createLogger('app/api/mcp/servers/[name]/resources/read/route');

type RouteContext = { params: Promise<{ name: string }> };

/**
 * GET /api/mcp/servers/{name}/resources/read?uri=<uri>
 * Read a single resource's contents.
 *
 * The resource URI is opaque (often a custom scheme like `file://` or `db://...`) and may
 * contain characters awkward in a path segment, so it travels as a query parameter.
 * Responds 200 with `{ success, data, error? }` (data = the MCP ReadResourceResult).
 */
export async function GET(request: NextRequest, { params }: RouteContext) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const { name } = await params;
    const uri = request.nextUrl.searchParams.get('uri');
    if (!uri) {
      return json({ success: false, error: 'A "uri" query parameter is required' }, 400);
    }
    const result = await mcpService.readResource(name, uri);
    return json(result, result.success ? 200 : result.statusCode || 500);
  } catch (error) {
    log.error('Error handling GET request', error);
    return json({ success: false, ...formatErrorResponse(error) }, 500);
  }
}
