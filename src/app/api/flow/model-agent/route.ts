import { withWorkspaceRoute } from '@/app/api/_workspace';
import { createModelAgent } from '@/backend/services/flow/modelAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { createLogger } from '@/utils/logger';
import { NextRequest } from 'next/server';
import { json } from '../_helpers';

const log = createLogger('app/api/flow/model-agent/route');

interface ModelAgentBody {
  creationId?: unknown;
  modelId?: unknown;
  name?: unknown;
  systemPrompt?: unknown;
  servers?: unknown;
}

/**
 * POST /api/flow/model-agent
 *
 * Creates and persists a Start -> Process (+ connected MCP attachments) ->
 * Finish agent from a narrow selection contract. Graph data and credentials
 * are never accepted from the browser.
 */
async function POST_handler(request: NextRequest) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const body = (await request.json().catch(() => null)) as ModelAgentBody | null;
    if (!body || typeof body !== 'object') {
      return json({ error: 'Request body must be a JSON object.' }, 400);
    }
    if (typeof body.creationId !== 'string' || typeof body.modelId !== 'string') {
      return json({ error: 'A creationId and modelId are required.' }, 400);
    }
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 160) {
      return json({ error: 'Agent name must contain 1 to 160 characters.' }, 400);
    }
    if (
      body.systemPrompt !== undefined
      && (typeof body.systemPrompt !== 'string' || body.systemPrompt.length > 20_000)
    ) {
      return json({ error: 'System prompt must be at most 20,000 characters.' }, 400);
    }
    if (body.servers !== undefined && !Array.isArray(body.servers)) {
      return json({ error: 'Connected apps must be an array.' }, 400);
    }

    const servers: Array<{ name: string; enabledTools?: string[] }> = [];
    for (const value of body.servers ?? []) {
      if (!value || typeof value !== 'object') {
        return json({ error: 'Each connected app selection must be an object.' }, 400);
      }
      const server = value as { name?: unknown; enabledTools?: unknown };
      if (typeof server.name !== 'string' || !server.name || server.name.length > 256) {
        return json({ error: 'Each connected app must have a valid name.' }, 400);
      }
      if (
        server.enabledTools !== undefined
        && (
          !Array.isArray(server.enabledTools)
          || server.enabledTools.length > 1_000
          || server.enabledTools.some(
            (tool) => typeof tool !== 'string' || !tool || tool.length > 256,
          )
        )
      ) {
        return json({ error: `Invalid tool selection for "${server.name}".` }, 400);
      }
      servers.push({
        name: server.name,
        ...(server.enabledTools !== undefined
          ? { enabledTools: server.enabledTools as string[] }
          : {}),
      });
    }

    const result = await createModelAgent({
      creationId: body.creationId,
      modelId: body.modelId,
      name: body.name,
      servers,
      ...(typeof body.systemPrompt === 'string'
        ? { systemPrompt: body.systemPrompt.trim() || undefined }
        : {}),
    });
    if (!result.success) {
      return json({ error: result.error }, result.statusCode);
    }

    return json({ flowId: result.flowId, name: result.name }, result.reused ? 200 : 201);
  } catch (error) {
    log.error('Error handling model-agent creation', error);
    return json({ error: 'Internal server error.' }, 500);
  }
}

export const POST = withWorkspaceRoute(POST_handler);
