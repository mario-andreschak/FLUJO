import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import type { NextRequest } from 'next/server';
import { mcpService } from '@/backend/services/mcp';
import { formatErrorResponse } from '@/utils/mcp/utils';
import { json } from '../../../_helpers';

type RouteContext = { params: Promise<{ name: string }> };

/** Discover draft SEP-2640 Skills for one explicitly selected MCP server. */
async function GET_handler(request: NextRequest, { params }: RouteContext) {
  const lock = await assertUnlocked();
  if (lock) return lock;

  try {
    const { name } = await params;
    const cursor = request.nextUrl.searchParams.get('cursor') ?? undefined;
    return json(await mcpService.listServerSkills(name, cursor), 200);
  } catch (error) {
    return json(
      {
        resultType: 'complete',
        skills: [],
        availability: 'available',
        ...formatErrorResponse(error),
      },
      500,
    );
  }
}

export const GET = withWorkspaceRoute(GET_handler);
