import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { personaDomainErrorResponse } from '@/app/v1/personas/_domainResponse';
import { copyPersonaCompositionFlow } from '@/backend/services/enduringAgents';
import { EnduringAgentIdSchema } from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/personas/[personaId]/composition/copy/route');
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ personaId: string }> };

async function POST_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { personaId } = await params;
  if (!EnduringAgentIdSchema.safeParse(personaId).success) {
    return NextResponse.json({ error: 'Persona composition not found.' }, { status: 404 });
  }

  try {
    return NextResponse.json(await copyPersonaCompositionFlow(
      personaId,
      await request.json().catch(() => null),
    ));
  } catch (error) {
    const response = personaDomainErrorResponse(error); if (response) return response;
    log.error(`Failed to copy Persona Flow for ${JSON.stringify(personaId)}`, error);
    return NextResponse.json(
      { error: 'Failed to copy Persona Flow.' },
      { status: 500 },
    );
  }
}

export const POST = withWorkspaceRoute(POST_handler);
