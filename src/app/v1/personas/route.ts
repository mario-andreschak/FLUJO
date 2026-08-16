import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import {
  PersonaFactoryConflictError,
  RoleVersionNotFoundError,
  createPersonaFromRole,
  listPersonas,
} from '@/backend/services/enduringAgents';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/personas/route');
export const dynamic = 'force-dynamic';

async function GET_handler(request: NextRequest) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  try {
    return NextResponse.json(await listPersonas());
  } catch (error) {
    log.error('Failed to list Personas', error);
    return NextResponse.json({ error: 'Failed to list Personas.' }, { status: 500 });
  }
}

async function POST_handler(request: NextRequest) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const body = await request.json().catch(() => null);
  try {
    return NextResponse.json(await createPersonaFromRole(body), { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json({ error: 'Invalid Persona configuration.' }, { status: 400 });
    }
    if (error instanceof PersonaFactoryConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof RoleVersionNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    log.error('Failed to create Persona', error);
    return NextResponse.json({ error: 'Failed to create Persona.' }, { status: 500 });
  }
}

export const GET = withWorkspaceRoute(GET_handler);
export const POST = withWorkspaceRoute(POST_handler);
