import { NextRequest, NextResponse } from 'next/server';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { personaDomainErrorResponse } from '@/app/v1/personas/_domainResponse';
import { pinMemoryToCore, unpinMemoryFromCore } from '@/backend/services/enduringAgents';
import { EnduringAgentIdSchema } from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/personas/[personaId]/memories/[memoryId]/pin/route');
export const dynamic = 'force-dynamic';
type RouteContext = { params: Promise<{ personaId: string; memoryId: string }> };

async function mutate(request: NextRequest, context: RouteContext, pin: boolean) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { personaId, memoryId } = await context.params;
  if (!EnduringAgentIdSchema.safeParse(personaId).success || !EnduringAgentIdSchema.safeParse(memoryId).success) {
    return NextResponse.json({ error: 'MemoryItem not found.' }, { status: 404 });
  }
  try {
    return NextResponse.json(pin
      ? await pinMemoryToCore(personaId, memoryId)
      : await unpinMemoryFromCore(personaId, memoryId));
  } catch (error) {
    const response = personaDomainErrorResponse(error); if (response) return response;
    log.error('Failed to update Persona core memory', error);
    return NextResponse.json({ error: 'Failed to update Persona core memory.' }, { status: 500 });
  }
}

async function POST_handler(request: NextRequest, context: RouteContext) {
  return mutate(request, context, true);
}

async function DELETE_handler(request: NextRequest, context: RouteContext) {
  return mutate(request, context, false);
}

export const POST = withWorkspaceRoute(POST_handler);
export const DELETE = withWorkspaceRoute(DELETE_handler);
