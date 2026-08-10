import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { personaDomainErrorResponse } from '@/app/v1/personas/_domainResponse';
import { activatePersonaBehaviorRevision } from '@/backend/services/enduringAgents';
import { EnduringAgentIdSchema } from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/personas/[personaId]/behaviors/[behaviorId]/activate/route');
export const dynamic = 'force-dynamic';
type RouteContext = { params: Promise<{ personaId: string; behaviorId: string }> };

async function POST_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request, { strictLoopback: true }); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { personaId, behaviorId } = await params;
  if (
    !EnduringAgentIdSchema.safeParse(personaId).success
    || !EnduringAgentIdSchema.safeParse(behaviorId).success
  ) {
    return NextResponse.json({ error: 'Behavior not found.' }, { status: 404 });
  }
  const body = await request.json().catch(() => null);
  try {
    return NextResponse.json(await activatePersonaBehaviorRevision(personaId, behaviorId, body));
  } catch (error) {
    const response = personaDomainErrorResponse(error); if (response) return response;
    log.error('Failed to activate Persona Behavior revision', error);
    return NextResponse.json({ error: 'Failed to activate Behavior revision.' }, { status: 500 });
  }
}

export const POST = withWorkspaceRoute(POST_handler);
