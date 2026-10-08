import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import type { NextRequest } from 'next/server';
import { mcpService } from '@/backend/services/mcp';
import { formatErrorResponse } from '@/utils/mcp/utils';
import { json } from '../../../../_helpers';

type RouteContext = { params: Promise<{ name: string }> };

/**
 * Explicit host loading boundary. A separate digest-bound conversation
 * approval is required; discovery and generic resource reads never invoke it.
 */
async function POST_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;
  const lock = await assertUnlocked();
  if (lock) return lock;

  try {
    const { name } = await params;
    const body = await request.json().catch(() => ({}));
    const conversationId =
      typeof body?.conversationId === 'string' ? body.conversationId.trim() : '';
    const uri = typeof body?.uri === 'string' ? body.uri.trim() : '';
    if (!conversationId || !uri) {
      return json(
        {
          success: false,
          error: 'A conversationId and exact Skill uri are required.',
        },
        400,
      );
    }

    const result = await mcpService.loadVerifiedSkill(
      name,
      uri,
      conversationId,
    );
    return json(result, result.success ? 200 : result.statusCode || 500);
  } catch (error) {
    return json({ success: false, ...formatErrorResponse(error) }, 500);
  }
}

export const POST = withWorkspaceRoute(POST_handler);
