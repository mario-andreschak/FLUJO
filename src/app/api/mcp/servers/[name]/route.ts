import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { mcpService } from '@/backend/services/mcp';
import { MCPServerConfig } from '@/shared/types/mcp';
import { formatErrorResponse } from '@/utils/mcp/utils';
import { json, getServerConfigByName, validateServerName } from '../../_helpers';

const log = createLogger('app/api/mcp/servers/[name]/route');

type RouteContext = { params: Promise<{ name: string }> };

/**
 * GET /api/mcp/servers/{name}
 * Get a single MCP server configuration by name.
 */
export async function GET(_request: NextRequest, { params }: RouteContext) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const { name } = await params;
    const { config, error } = await getServerConfigByName(name);

    if (error) {
      return json({ error }, 500);
    }
    if (!config) {
      return json({ error: `Server "${name}" not found` }, 404);
    }

    return json(config, 200);
  } catch (error) {
    log.error('Error handling GET request', error);
    return json(formatErrorResponse(error), 500);
  }
}

/**
 * PUT /api/mcp/servers/{name}
 * Update an existing MCP server configuration. The body may be a partial config; the
 * provided fields are merged onto the stored config. The path name identifies which
 * server to update. Saving the config also drives the connection state (a server with
 * `disabled: false` is (re)connected, `disabled: true` is disconnected).
 *
 * A body `name` that differs from the path triggers a rename and is validated.
 */
export async function PUT(request: NextRequest, { params }: RouteContext) {
  // Local-only: a PUT can persist an arbitrary `command` that the MCP manager
  // later spawns, so reject cross-origin / DNS-rebinding callers first (#141).
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const { name } = await params;
    const updates = (await request.json()) as Partial<MCPServerConfig>;

    if (!updates || typeof updates !== 'object') {
      return json({ error: 'A config body is required' }, 400);
    }

    // Only validate when the body renames the server; existing names predate validation
    // and must keep working untouched.
    if (typeof updates.name === 'string' && updates.name !== name) {
      const nameError = validateServerName(updates.name);
      if (nameError) {
        return json({ error: nameError }, 400);
      }
    }

    const result = await mcpService.updateServerConfig(name, updates);

    if ('error' in result) {
      const errMsg = typeof result.error === 'string' ? result.error : '';
      const status = errMsg.includes('not found')
        ? 404
        : errMsg.includes('already exists')
          ? 409
          : errMsg.includes('built-in')
            ? 403
            : 400;
      log.warn(`Error updating config for ${name}:`, result.error);
      return json({ error: result.error }, status);
    }

    log.info(`Successfully updated config for ${name}`);
    return json(result, 200);
  } catch (error) {
    log.error('Error handling PUT request', error);
    return json(formatErrorResponse(error), 500);
  }
}

/**
 * DELETE /api/mcp/servers/{name}
 * Delete an MCP server configuration by name (disconnecting it first if connected).
 */
export async function DELETE(request: NextRequest, { params }: RouteContext) {
  // Local-only: this is a state-mutating route, so reject cross-origin /
  // DNS-rebinding callers first (#141).
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const { name } = await params;
    const result = await mcpService.deleteServerConfig(name);

    if (!result.success) {
      const errMsg = typeof result.error === 'string' ? result.error : '';
      const status = errMsg.includes('not found') ? 404 : errMsg.includes('built-in') ? 403 : 500;
      log.warn(`Error deleting config for ${name}:`, result.error);
      return json({ success: false, error: result.error }, status);
    }

    log.info(`Successfully deleted config for ${name}`);
    return json({ success: true }, 200);
  } catch (error) {
    log.error('Error handling DELETE request', error);
    return json({ success: false, ...formatErrorResponse(error) }, 500);
  }
}
