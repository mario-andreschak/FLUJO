import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import {
  PersonaDeletionNotFoundError,
  previewPersonaDeletion,
} from '@/backend/services/enduringAgents';
import { EnduringAgentIdSchema } from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/personas/[personaId]/deletion-preview/route');
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ personaId: string }> };

async function GET_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { personaId } = await params;
  if (!EnduringAgentIdSchema.safeParse(personaId).success) {
    return NextResponse.json({ error: 'Persona not found.' }, { status: 404 });
  }
  try {
    return NextResponse.json(await previewPersonaDeletion(personaId));
  } catch (error) {
    if (error instanceof PersonaDeletionNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    log.error(`Failed to preview Persona deletion ${JSON.stringify(personaId)}`, error);
    return NextResponse.json({ error: 'Failed to preview Persona deletion.' }, { status: 500 });
  }
}

export const GET = withWorkspaceRoute(GET_handler);
