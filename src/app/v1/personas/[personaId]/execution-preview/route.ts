import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { previewPersonaExecution } from '@/backend/services/enduringAgents/personaExecutionPreview';
import { EnduringAgentIdSchema } from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/personas/[personaId]/execution-preview/route');
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ personaId: string }> };

async function GET_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true });
  if (locked) return locked;

  const { personaId } = await params;
  if (!EnduringAgentIdSchema.safeParse(personaId).success) {
    return NextResponse.json(
      { error: 'Persona execution preview not found.' },
      { status: 404 },
    );
  }

  try {
    const preview = await previewPersonaExecution(personaId);
    return preview
      ? NextResponse.json(preview)
      : NextResponse.json(
          { error: 'Persona execution preview not found.' },
          { status: 404 },
        );
  } catch (error) {
    log.error(
      `Failed to read Persona execution preview ${JSON.stringify(personaId)}`,
      error,
    );
    return NextResponse.json(
      { error: 'Failed to read Persona execution preview.' },
      { status: 500 },
    );
  }
}

export const GET = withWorkspaceRoute(GET_handler);
