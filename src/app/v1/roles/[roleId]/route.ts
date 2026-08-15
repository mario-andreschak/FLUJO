import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { roleAdminErrorResponse } from '@/app/v1/roles/_response';
import {
  applyRoleLifecycle,
  getPublicRole,
  updatePublicRole,
} from '@/backend/services/enduringAgents';
import { EnduringAgentIdSchema } from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/roles/[roleId]/route');
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ roleId: string }> };

function invalidRoleId(roleId: string): NextResponse | null {
  return EnduringAgentIdSchema.safeParse(roleId).success
    ? null
    : NextResponse.json({ error: 'Role not found.' }, { status: 404 });
}

async function GET_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { roleId } = await params;
  const invalid = invalidRoleId(roleId); if (invalid) return invalid;
  try {
    return NextResponse.json(await getPublicRole(roleId));
  } catch (error) {
    const response = roleAdminErrorResponse(error); if (response) return response;
    log.error(`Failed to read Role ${JSON.stringify(roleId)}`, error);
    return NextResponse.json({ error: 'Failed to read Role.' }, { status: 500 });
  }
}

async function PATCH_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { roleId } = await params;
  const invalid = invalidRoleId(roleId); if (invalid) return invalid;
  const body = await request.json().catch(() => null);
  try {
    return NextResponse.json(await updatePublicRole(roleId, body));
  } catch (error) {
    const response = roleAdminErrorResponse(error); if (response) return response;
    log.error(`Failed to update Role ${JSON.stringify(roleId)}`, error);
    return NextResponse.json({ error: 'Failed to update Role.' }, { status: 500 });
  }
}

async function DELETE_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { roleId } = await params;
  const invalid = invalidRoleId(roleId); if (invalid) return invalid;
  const body = await request.json().catch(() => null);
  try {
    const role = await applyRoleLifecycle(roleId, body);
    return role ? NextResponse.json(role) : new NextResponse(null, { status: 204 });
  } catch (error) {
    const response = roleAdminErrorResponse(
      error,
      'Invalid Role archive or deletion request.',
    );
    if (response) return response;
    log.error(`Failed to archive or delete Role ${JSON.stringify(roleId)}`, error);
    return NextResponse.json({ error: 'Failed to archive or delete Role.' }, { status: 500 });
  }
}

export const GET = withWorkspaceRoute(GET_handler);
const PUT_handler = PATCH_handler;

export const PATCH = withWorkspaceRoute(PATCH_handler);
export const PUT = withWorkspaceRoute(PUT_handler);
export const DELETE = withWorkspaceRoute(DELETE_handler);
