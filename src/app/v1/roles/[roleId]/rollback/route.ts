import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { roleAdminErrorResponse } from '@/app/v1/roles/_response';
import { rollbackPublicRole } from '@/backend/services/enduringAgents';
import { EnduringAgentIdSchema } from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/roles/[roleId]/rollback/route');
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ roleId: string }> };

async function POST_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { roleId } = await params;
  if (!EnduringAgentIdSchema.safeParse(roleId).success) {
    return NextResponse.json({ error: 'Role not found.' }, { status: 404 });
  }
  const body = await request.json().catch(() => null);
  try {
    return NextResponse.json(await rollbackPublicRole(roleId, body), { status: 200 });
  } catch (error) {
    const response = roleAdminErrorResponse(error); if (response) return response;
    log.error('Failed to restore a previous version of Role', error);
    return NextResponse.json({ error: 'Failed to restore a previous version of Role.' }, { status: 500 });
  }
}

export const POST = withWorkspaceRoute(POST_handler);
