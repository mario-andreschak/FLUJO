import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import type { NextRequest } from 'next/server';
import { mcpService } from '@/backend/services/mcp';
import { formatErrorResponse } from '@/utils/mcp/utils';
import { json } from '../../../../_helpers';

type RouteContext = { params: Promise<{ name: string }> };

/**
 * Explicit host loading boundary. Calling this endpoint is the user's current
 * conversation action; discovery and generic resource reads never invoke it.
 */
async function POST_handler(request: NextRequest, { params }: RouteContext) {
  const lock = await assertUnlocked();
  if (lock) return lock;

  try {
    const { name } = await params;
    const body = await request.json().catch(() => ({}));
    const uri = typeof body?.uri === 'string' ? body.uri.trim() : '';
    if (!uri) {
      return json({ success: false, error: 'A Skill "uri" is required.' }, 400);
    }

    const result = await mcpService.loadVerifiedSkill(name, uri);
    return json(result, result.success ? 200 : result.statusCode || 500);
  } catch (error) {
    return json({ success: false, ...formatErrorResponse(error) }, 500);
  }
}

export const POST = withWorkspaceRoute(POST_handler);
