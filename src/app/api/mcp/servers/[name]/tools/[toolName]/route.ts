import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
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
 * Body: `{ args: Record<string, unknown>, timeout?: number, source?: "app", ownerScope?: string }`.
 * `source: "app"` and `ownerScope` are set by FLUJO's MCP App host bridge and route through
 * server-side visibility enforcement. The route path remains the authoritative
 * server identity; an app cannot select a different server in its request body.
 * The response carries the tool result and is given the tool's own status code when it
 * provides one (e.g. a timeout maps to 408), otherwise 200 on success / 500 on failure.
 */
async function POST_handler(request: NextRequest, { params }: RouteContext) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const { name, toolName } = await params;
    const body = await request.json();
    const args = body?.args;
    const timeout = body?.timeout;
    const source = body?.source;
    const rawOwnerScope = body?.ownerScope;

    if (!args || typeof args !== 'object') {
      return json({ success: false, error: 'Missing tool arguments ("args")' }, 400);
    }
    if (
      source === 'app'
      && rawOwnerScope !== undefined
      && (typeof rawOwnerScope !== 'string' || rawOwnerScope.trim().length === 0 || rawOwnerScope.length > 512)
    ) {
      return json({ success: false, error: 'Invalid MCP App owner scope' }, 400);
    }
    const ownerScope = typeof rawOwnerScope === 'string' ? rawOwnerScope.trim() : undefined;

    const result = source === 'app'
      ? await mcpService.callToolFromApp(name, toolName, args, timeout, request.signal, ownerScope)
      : await mcpService.callTool(name, toolName, args, timeout);
    return json(result, result.statusCode || (result.success ? 200 : 500));
  } catch (error) {
    log.error('Error handling POST request', error);
    return json({ success: false, ...formatErrorResponse(error) }, 500);
  }
}

export const POST = withWorkspaceRoute(POST_handler);
