import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { personaDomainErrorResponse } from '@/app/v1/personas/_domainResponse';
import { forgetMemory, getPersonaMemory } from '@/backend/services/enduringAgents';
import { EnduringAgentIdSchema } from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/personas/[personaId]/memories/[memoryId]/route');
export const dynamic = 'force-dynamic';
type RouteContext = { params: Promise<{ personaId: string; memoryId: string }> };

function validIds(personaId: string, memoryId: string): boolean {
  return EnduringAgentIdSchema.safeParse(personaId).success
    && EnduringAgentIdSchema.safeParse(memoryId).success;
}

async function GET_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { personaId, memoryId } = await params;
  if (!validIds(personaId, memoryId)) return NextResponse.json({ error: 'MemoryItem not found.' }, { status: 404 });
  try {
    return NextResponse.json(await getPersonaMemory(personaId, memoryId));
  } catch (error) {
    const response = personaDomainErrorResponse(error); if (response) return response;
    log.error('Failed to read Persona memory', error);
    return NextResponse.json({ error: 'Failed to read Persona memory.' }, { status: 500 });
  }
}

async function DELETE_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { personaId, memoryId } = await params;
  if (!validIds(personaId, memoryId)) return NextResponse.json({ error: 'MemoryItem not found.' }, { status: 404 });
  try {
    return NextResponse.json(await forgetMemory(personaId, memoryId));
  } catch (error) {
    const response = personaDomainErrorResponse(error); if (response) return response;
    log.error('Failed to forget Persona memory', error);
    return NextResponse.json({ error: 'Failed to forget Persona memory.' }, { status: 500 });
  }
}

export const GET = withWorkspaceRoute(GET_handler);
export const DELETE = withWorkspaceRoute(DELETE_handler);
