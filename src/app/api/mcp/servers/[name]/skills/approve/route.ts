import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import type { NextRequest } from 'next/server';
import { mcpService } from '@/backend/services/mcp';
import { approveMcpSkill } from '@/backend/services/mcp/skillApprovalRegistry';
import { formatErrorResponse } from '@/utils/mcp/utils';
import { json } from '../../../../_helpers';

type RouteContext = { params: Promise<{ name: string }> };

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

    const current = await mcpService.getServerSkill(name, uri);
    if (!current.success || !current.data) {
      return json(current, current.statusCode || 502);
    }
    const entry = current.data.skill;
    if (entry.resources === 'dynamic') {
      return json(
        {
          success: false,
          error: 'Dynamic MCP Skills cannot be approved for verified loading.',
        },
        422,
      );
    }
    const manifest = entry.resources.find(
      (resource) => resource.uri === entry.uri,
    );
    if (!manifest) {
      return json(
        { success: false, error: 'MCP Skill manifest metadata is missing.' },
        422,
      );
    }

    const approval = approveMcpSkill({
      conversationId,
      serverName: name,
      skillUri: entry.uri,
      manifestDigest: manifest.digest,
    });
    return json({ success: true, data: approval }, 200);
  } catch (error) {
    return json({ success: false, ...formatErrorResponse(error) }, 400);
  }
}

export const POST = withWorkspaceRoute(POST_handler);
