import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { mcpService } from '@/backend/services/mcp';
import { formatErrorResponse } from '@/utils/mcp/utils';
import { json } from '../../../../_helpers';

const log = createLogger('app/api/mcp/servers/[name]/tools/[toolName]/route');

type RouteContext = { params: Promise<{ name: string; toolName: string }> };

/**
 * POST /api/mcp/servers/{name}/tools/{toolName}
 * Invoke a tool on an MCP server.
 *
 * Body: `{ args: Record<string, unknown>, timeout?: number }`.
 * The response carries the tool result and is given the tool's own status code when it
 * provides one (e.g. a timeout maps to 408), otherwise 200 on success / 500 on failure.
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { name, toolName } = await params;
    const body = await request.json();
    const args = body?.args;
    const timeout = body?.timeout;

    if (!args || typeof args !== 'object') {
      return json({ success: false, error: 'Missing tool arguments ("args")' }, 400);
    }

    const result = await mcpService.callTool(name, toolName, args, timeout);
    return json(result, result.statusCode || (result.success ? 200 : 500));
  } catch (error) {
    log.error('Error handling POST request', error);
    return json({ success: false, ...formatErrorResponse(error) }, 500);
  }
}
