import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { personaDomainErrorResponse } from '@/app/v1/personas/_domainResponse';
import {
  readPersonaComposition,
  updatePersonaComposition,
} from '@/backend/services/enduringAgents';
import { EnduringAgentIdSchema } from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/personas/[personaId]/composition/route');
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ personaId: string }> };

function invalidPersonaId(personaId: string): NextResponse | null {
  return EnduringAgentIdSchema.safeParse(personaId).success
    ? null
    : NextResponse.json({ error: 'Persona composition not found.' }, { status: 404 });
}

async function GET_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { personaId } = await params;
  const invalid = invalidPersonaId(personaId); if (invalid) return invalid;

  try {
    const composition = await readPersonaComposition(personaId);
    return composition
      ? NextResponse.json(composition)
      : NextResponse.json({ error: 'Persona composition not found.' }, { status: 404 });
  } catch (error) {
    const response = personaDomainErrorResponse(error); if (response) return response;
    log.error(`Failed to read Persona composition ${JSON.stringify(personaId)}`, error);
    return NextResponse.json(
      { error: 'Failed to read Persona composition.' },
      { status: 500 },
    );
  }
}

async function PATCH_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { personaId } = await params;
  const invalid = invalidPersonaId(personaId); if (invalid) return invalid;
  const body = await request.json().catch(() => null);

  try {
    return NextResponse.json(await updatePersonaComposition(personaId, body));
  } catch (error) {
    const response = personaDomainErrorResponse(error); if (response) return response;
    log.error(`Failed to update Persona composition ${JSON.stringify(personaId)}`, error);
    return NextResponse.json(
      { error: 'Failed to update Persona composition.' },
      { status: 500 },
    );
  }
}

export const GET = withWorkspaceRoute(GET_handler);
export const PATCH = withWorkspaceRoute(PATCH_handler);
