import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { personaDomainErrorResponse } from '@/app/v1/personas/_domainResponse';
import {
  deletePersonaWorkItem,
  getPersonaWorkItem,
  updatePersonaWorkItem,
} from '@/backend/services/enduringAgents';
import { EnduringAgentIdSchema } from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/personas/[personaId]/work-items/[workItemId]/route');
export const dynamic = 'force-dynamic';
type RouteContext = { params: Promise<{ personaId: string; workItemId: string }> };

function validIds(personaId: string, workItemId: string): boolean {
  return EnduringAgentIdSchema.safeParse(personaId).success
    && EnduringAgentIdSchema.safeParse(workItemId).success;
}

async function GET_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request, { strictLoopback: true }); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { personaId, workItemId } = await params;
  if (!validIds(personaId, workItemId)) return NextResponse.json({ error: 'WorkItem not found.' }, { status: 404 });
  try {
    const item = await getPersonaWorkItem(workItemId);
    return item?.personaId === personaId
      ? NextResponse.json(item)
      : NextResponse.json({ error: 'WorkItem not found.' }, { status: 404 });
  } catch (error) {
    log.error('Failed to read Persona WorkItem', error);
    return NextResponse.json({ error: 'Failed to read Persona WorkItem.' }, { status: 500 });
  }
}

async function PATCH_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request, { strictLoopback: true }); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { personaId, workItemId } = await params;
  if (!validIds(personaId, workItemId)) return NextResponse.json({ error: 'WorkItem not found.' }, { status: 404 });
  const body = await request.json().catch(() => null);
  try {
    return NextResponse.json(await updatePersonaWorkItem(personaId, workItemId, body));
  } catch (error) {
    const response = personaDomainErrorResponse(error); if (response) return response;
    log.error('Failed to update Persona WorkItem', error);
    return NextResponse.json({ error: 'Failed to update Persona WorkItem.' }, { status: 500 });
  }
}

async function DELETE_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request, { strictLoopback: true }); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { personaId, workItemId } = await params;
  if (!validIds(personaId, workItemId)) return NextResponse.json({ error: 'WorkItem not found.' }, { status: 404 });
  try {
    await deletePersonaWorkItem(personaId, workItemId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    const response = personaDomainErrorResponse(error); if (response) return response;
    log.error('Failed to delete Persona WorkItem', error);
    return NextResponse.json({ error: 'Failed to delete Persona WorkItem.' }, { status: 500 });
  }
}

export const GET = withWorkspaceRoute(GET_handler);
export const PATCH = withWorkspaceRoute(PATCH_handler);
export const DELETE = withWorkspaceRoute(DELETE_handler);
