import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { personaDomainErrorResponse } from '@/app/v1/personas/_domainResponse';
import {
  replacePersonaAppAccess,
  revokePersonaAppAccess,
} from '@/backend/services/enduringAgents';
import { EnduringAgentIdSchema } from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/personas/[personaId]/app-grants/[grantId]/route');
export const dynamic = 'force-dynamic';
type RouteContext = { params: Promise<{ personaId: string; grantId: string }> };

async function PATCH_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { personaId, grantId } = await params;
  if (
    !EnduringAgentIdSchema.safeParse(personaId).success
    || !EnduringAgentIdSchema.safeParse(grantId).success
  ) return NextResponse.json({ error: 'Persona App not found.' }, { status: 404 });
  try {
    const grant = await replacePersonaAppAccess(personaId, grantId, await request.json());
    return NextResponse.json(grant);
  } catch (error) {
    const response = personaDomainErrorResponse(error); if (response) return response;
    log.error('Failed to switch Persona App configuration', error);
    return NextResponse.json({ error: 'Failed to switch Persona App configuration.' }, { status: 500 });
  }
}

async function DELETE_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { personaId, grantId } = await params;
  if (
    !EnduringAgentIdSchema.safeParse(personaId).success
    || !EnduringAgentIdSchema.safeParse(grantId).success
  ) return NextResponse.json({ error: 'Persona app grant not found.' }, { status: 404 });
  try {
    await revokePersonaAppAccess(personaId, grantId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    const response = personaDomainErrorResponse(error); if (response) return response;
    log.error('Failed to revoke Persona app grant', error);
    return NextResponse.json({ error: 'Failed to revoke Persona app grant.' }, { status: 500 });
  }
}

export const PATCH = withWorkspaceRoute(PATCH_handler);
export const DELETE = withWorkspaceRoute(DELETE_handler);
