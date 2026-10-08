import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { personaDomainErrorResponse } from '@/app/v1/personas/_domainResponse';
import { authorizePersonaAppLaunch } from '@/backend/services/enduringAgents';
import { EnduringAgentIdSchema } from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/personas/[personaId]/app-grants/[grantId]/launch/route');
export const dynamic = 'force-dynamic';
type RouteContext = { params: Promise<{ personaId: string; grantId: string }> };

async function POST_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { personaId, grantId } = await params;
  if (
    !EnduringAgentIdSchema.safeParse(personaId).success
    || !EnduringAgentIdSchema.safeParse(grantId).success
  ) return NextResponse.json({ error: 'Persona app grant not found.' }, { status: 404 });
  const body = await request.json().catch(() => null);
  try {
    return NextResponse.json(await authorizePersonaAppLaunch(personaId, grantId, body));
  } catch (error) {
    const response = personaDomainErrorResponse(error); if (response) return response;
    log.error('Failed to authorize Persona app launch', error);
    return NextResponse.json({ error: 'Failed to authorize Persona app launch.' }, { status: 500 });
  }
}

export const POST = withWorkspaceRoute(POST_handler);
