import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { mcpService } from '@/backend/services/mcp';
import { MCPServerConfig } from '@/shared/types/mcp';
import { formatErrorResponse } from '@/utils/mcp/utils';
import { json, validateServerName } from '../_helpers';

const log = createLogger('app/api/mcp/servers/route');

/**
 * GET /api/mcp/servers
 * List all MCP server configurations.
 */
export async function GET() {
  log.debug('Entering GET method');
  try {
    const configs = await mcpService.loadServerConfigs();
    if (!Array.isArray(configs)) {
      return json({ error: configs.error || 'Failed to load server configs' }, 500);
    }
    return json(configs, 200);
  } catch (error) {
    log.error('Error handling GET request', error);
    return json(formatErrorResponse(error), 500);
  }
}

/**
 * POST /api/mcp/servers
 * Create a new MCP server configuration. The request body is the server config.
 */
export async function POST(request: NextRequest) {
  log.debug('Entering POST method');
  try {
    const config = (await request.json()) as MCPServerConfig;

    if (!config || typeof config !== 'object') {
      return json({ error: 'A server config is required' }, 400);
    }

    const nameError = validateServerName(config.name);
    if (nameError) {
      return json({ error: nameError }, 400);
    }

    // Reject duplicates so POST keeps create semantics (use PUT /api/mcp/servers/{name} to update).
    const existing = await mcpService.loadServerConfigs();
    if (!Array.isArray(existing)) {
      return json({ error: existing.error || 'Failed to load server configs' }, 500);
    }
    if (existing.some((c) => c.name === config.name)) {
      return json({ error: `Server "${config.name}" already exists` }, 409);
    }

    const result = await mcpService.updateServerConfig(config.name, config);
    if ('error' in result) {
      log.warn(`Error creating config for ${config.name}:`, result.error);
      return json({ error: result.error }, 400);
    }

    log.info(`Successfully created config for ${config.name}`);
    return json(result, 201);
  } catch (error) {
    log.error('Error handling POST request', error);
    return json(formatErrorResponse(error), 500);
  }
}
