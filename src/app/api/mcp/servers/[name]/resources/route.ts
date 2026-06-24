import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { mcpService } from '@/backend/services/mcp';
import { formatErrorResponse } from '@/utils/mcp/utils';
import { json } from '../../../_helpers';

const log = createLogger('app/api/mcp/servers/[name]/resources/route');

type RouteContext = { params: Promise<{ name: string }> };

/**
 * GET /api/mcp/servers/{name}/resources
 * List the resources and resource templates a connected MCP server publishes.
 *
 * Responds 200 with `{ resources, resourceTemplates, error? }`. As with the tools route, a
 * disconnected server yields empty lists plus an `error` message rather than a non-2xx
 * status. A server that doesn't implement the resources capability yields empty lists and
 * no error.
 */
export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    const { name } = await params;
    const [resourcesResult, templatesResult] = await Promise.all([
      mcpService.listServerResources(name),
      mcpService.listServerResourceTemplates(name),
    ]);
    return json(
      {
        resources: resourcesResult.resources,
        resourceTemplates: templatesResult.resourceTemplates,
        error: resourcesResult.error || templatesResult.error,
      },
      200
    );
  } catch (error) {
    log.error('Error handling GET request', error);
    return json({ resources: [], resourceTemplates: [], ...formatErrorResponse(error) }, 500);
  }
}
