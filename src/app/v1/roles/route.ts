import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import {
  ensureBuiltInDeveloperRole,
  listRoleDefinitions,
  listRoleVersions,
} from '@/backend/services/enduringAgents';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/roles/route');
export const dynamic = 'force-dynamic';

async function GET_handler(request: NextRequest) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  try {
    await ensureBuiltInDeveloperRole();
    const [roleDefinitions, roleVersions] = await Promise.all([
      listRoleDefinitions(),
      listRoleVersions(),
    ]);
    return NextResponse.json({ roleDefinitions, roleVersions });
  } catch (error) {
    log.error('Failed to list Roles', error);
    return NextResponse.json({ error: 'Failed to list Roles.' }, { status: 500 });
  }
}

export const GET = withWorkspaceRoute(GET_handler);

