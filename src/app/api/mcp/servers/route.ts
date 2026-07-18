import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { mcpService } from '@/backend/services/mcp';
import { MCPServerConfig, MCPStreamableConfig } from '@/shared/types/mcp';
import { formatErrorResponse } from '@/utils/mcp/utils';
import { MASKED_API_KEY } from '@/shared/types/constants';
import { maskServerHeaders } from '@/utils/mcp/headers';
import { json, validateServerName } from '../_helpers';

const log = createLogger('app/api/mcp/servers/route');

/**
 * Never let a stored OAuth client secret reach the browser. Mirrors how model API keys are
 * masked: a saved secret is replaced with MASKED_API_KEY (which the save path interprets as
 * "keep the existing secret"), while a "${global:VAR}" binding is left intact so the edit UI
 * can show that it's bound. Encrypted/plaintext secret material is never sent out.
 */
function redactServerConfig(config: MCPServerConfig): MCPServerConfig {
  if (config.transport !== 'streamable' && config.transport !== 'sse') {
    return config;
  }
  const streamable = config as MCPStreamableConfig;
  // Mask any secret custom headers (#84) — a saved secret header value never reaches the
  // browser; global-variable bindings are left intact so the editor can show "bound".
  const redacted = { ...streamable, headers: maskServerHeaders(streamable.headers) } as MCPStreamableConfig;
  const secret = redacted.oauthClientSecret;
  if (secret && !secret.startsWith('${global:')) {
    redacted.oauthClientSecret = MASKED_API_KEY;
  }
  return redacted as MCPServerConfig;
}

/**
 * GET /api/mcp/servers
 * List all MCP server configurations (with secrets redacted for the browser).
 */
export async function GET() {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  log.debug('Entering GET method');
  try {
    const configs = await mcpService.loadServerConfigs();
    if (!Array.isArray(configs)) {
      return json({ error: configs.error || 'Failed to load server configs' }, 500);
    }
    return json(configs.map(redactServerConfig), 200);
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
  // Local-only: this route persists an arbitrary `command` that the MCP manager
  // later spawns, so reject cross-origin / DNS-rebinding callers first (#141).
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  const _lock = await assertUnlocked();
  if (_lock) return _lock;

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
