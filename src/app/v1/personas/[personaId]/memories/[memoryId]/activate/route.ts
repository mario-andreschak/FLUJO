import { NextRequest, NextResponse } from 'next/server';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { personaDomainErrorResponse } from '@/app/v1/personas/_domainResponse';
import { activateMemory } from '@/backend/services/enduringAgents';
import { EnduringAgentIdSchema } from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/personas/[personaId]/memories/[memoryId]/activate/route');
export const dynamic = 'force-dynamic';
type RouteContext = { params: Promise<{ personaId: string; memoryId: string }> };

async function POST_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request, { strictLoopback: true }); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { personaId, memoryId } = await params;
  if (!EnduringAgentIdSchema.safeParse(personaId).success || !EnduringAgentIdSchema.safeParse(memoryId).success) {
    return NextResponse.json({ error: 'MemoryItem not found.' }, { status: 404 });
  }
  try {
    return NextResponse.json(await activateMemory(personaId, memoryId, { reviewed: true }));
  } catch (error) {
    const response = personaDomainErrorResponse(error); if (response) return response;
    log.error('Failed to activate Persona memory', error);
    return NextResponse.json({ error: 'Failed to activate Persona memory.' }, { status: 500 });
  }
}

export const POST = withWorkspaceRoute(POST_handler);
