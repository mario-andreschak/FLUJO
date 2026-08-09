import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import {
  PersonaDeletionConflictError,
  PersonaDeletionNotFoundError,
  deletePersona,
  listPersonaRuntimeBundle,
} from '@/backend/services/enduringAgents';
import { EnduringAgentIdSchema } from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/personas/[personaId]/route');
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
    const bundle = await listPersonaRuntimeBundle(personaId);
    return bundle
      ? NextResponse.json(bundle)
      : NextResponse.json({ error: 'Persona not found.' }, { status: 404 });
  } catch (error) {
    log.error(`Failed to read Persona ${JSON.stringify(personaId)}`, error);
    return NextResponse.json({ error: 'Failed to read Persona.' }, { status: 500 });
  }
}

async function DELETE_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { personaId } = await params;
  if (!EnduringAgentIdSchema.safeParse(personaId).success) {
    return NextResponse.json({ error: 'Persona not found.' }, { status: 404 });
  }
  const body = await request.json().catch(() => null);
  try {
    return NextResponse.json(await deletePersona(personaId, body));
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json({ error: 'Invalid Persona deletion confirmation.' }, { status: 400 });
    }
    if (error instanceof PersonaDeletionNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof PersonaDeletionConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    log.error(`Failed to delete Persona ${JSON.stringify(personaId)}`, error);
    return NextResponse.json({ error: 'Failed to delete Persona.' }, { status: 500 });
  }
}

export const GET = withWorkspaceRoute(GET_handler);
export const DELETE = withWorkspaceRoute(DELETE_handler);
