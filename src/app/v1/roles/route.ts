import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { roleAdminErrorResponse } from '@/app/v1/roles/_response';
import {
  createPublicRole,
  ensureBuiltInDeveloperRole,
  listPublicRoles,
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
    const includeArchived = new URL(request.url).searchParams.get('includeArchived') === 'true';
    const [roleDefinitions, roleVersions, roles] = await Promise.all([
      listRoleDefinitions(),
      listRoleVersions(),
      listPublicRoles({ includeArchived }),
    ]);
    const visibleRoleIds = new Set(
      roleDefinitions
        .filter((definition) => includeArchived || definition.archivedAt === undefined)
        .map((definition) => definition.id),
    );
    return NextResponse.json({
      roleDefinitions: roleDefinitions.filter((definition) => visibleRoleIds.has(definition.id)),
      roleVersions: roleVersions.filter((version) => visibleRoleIds.has(version.roleDefinitionId)),
      roles,
    });
  } catch (error) {
    log.error('Failed to list Roles', error);
    return NextResponse.json({ error: 'Failed to list Roles.' }, { status: 500 });
  }
}

async function POST_handler(request: NextRequest) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const body = await request.json().catch(() => null);
  try {
    await ensureBuiltInDeveloperRole();
    return NextResponse.json(await createPublicRole(body), { status: 201 });
  } catch (error) {
    const response = roleAdminErrorResponse(error); if (response) return response;
    log.error('Failed to create Role', error);
    return NextResponse.json({ error: 'Failed to create Role.' }, { status: 500 });
  }
}

export const GET = withWorkspaceRoute(GET_handler);
export const POST = withWorkspaceRoute(POST_handler);
