import { withWorkspaceRoute } from '@/app/api/_workspace';
import type { NextRequest } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { createLogger } from '@/utils/logger';
import { json } from '@/app/api/mcp/_helpers';
import { mcpService } from '@/backend/services/mcp';
import {
  decodeStandaloneSkillResource,
  FLUJO_STANDALONE_SKILL_SCHEME,
} from '@/backend/services/mcp/standaloneSkills';

const log = createLogger('app/api/mcp/flujo/resources/read/route');

async function POST_handler(request: NextRequest) {
  const lock = await assertUnlocked();
  if (lock) return lock;

  let body: { uri?: unknown };
  try {
    body = (await request.json()) as { uri?: unknown };
  } catch {
    return json({ error: 'Request body must be valid JSON.' }, 400);
  }
  const uri = typeof body.uri === 'string' ? body.uri.trim() : '';
  if (
    !uri ||
    (!uri.startsWith('flujo://run/') &&
      !uri.startsWith(`${FLUJO_STANDALONE_SKILL_SCHEME}//`))
  ) {
    return json({ error: 'A valid FLUJO resource URI is required.' }, 400);
  }

  try {
    if (uri.startsWith(`${FLUJO_STANDALONE_SKILL_SCHEME}//`)) {
      const decoded = decodeStandaloneSkillResource(uri);
      const result = await mcpService.readVerifiedSkillResource(
        decoded.serverName,
        decoded.skillUri,
        decoded.resourceUri,
      );
      if (!result.success || !result.data) {
        return json({ error: result.error || 'Failed to verify MCP Skill resource.' }, result.statusCode || 502);
      }
      return json({
        contents: [
          {
            uri: decoded.transportUri,
            ...(result.data.mimeType ? { mimeType: result.data.mimeType } : {}),
            ...(result.data.text === undefined ? {} : { text: result.data.text }),
            ...(result.data.blob === undefined ? {} : { blob: result.data.blob }),
          },
        ],
      }, 200);
    }

    // internalReadResource performs the full URI parse, records readBy lineage,
    // and emits the resource:read event. Do not reproduce that logic here.
    const { internalReadResource } = await import('@/backend/services/mcp/internalResources');
    return json(await internalReadResource(uri), 200);
  } catch (error) {
    log.error('Failed to read internal or Skill resource', {
      uri,
      error: error instanceof Error ? error.message : String(error),
    });
    return json({ error: 'Failed to read FLUJO resource.' }, 500);
  }
}

export const POST = withWorkspaceRoute(POST_handler);
