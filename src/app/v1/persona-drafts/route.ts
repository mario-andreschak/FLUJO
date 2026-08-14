import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import {
  PersonaDraftConflictError,
  createPersonaCreationDraft,
  listPersonaCreationDrafts,
} from '@/backend/services/enduringAgents';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/persona-drafts/route');
export const dynamic = 'force-dynamic';

async function GET_handler(request: NextRequest) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  try {
    return NextResponse.json(await listPersonaCreationDrafts());
  } catch (error) {
    log.error('Failed to list Persona drafts', error);
    return NextResponse.json({ error: 'Failed to list Persona drafts.' }, { status: 500 });
  }
}

async function POST_handler(request: NextRequest) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const body = await request.json().catch(() => null);
  try {
    return NextResponse.json(await createPersonaCreationDraft(body), { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        { error: 'Invalid Persona draft.', details: error.flatten() },
        { status: 400 },
      );
    }
    if (error instanceof PersonaDraftConflictError) {
      return NextResponse.json({
        error: error.message,
        code: error.code,
        details: error.details,
      }, { status: 409 });
    }
    log.error('Failed to create Persona draft', error);
    return NextResponse.json({ error: 'Failed to create Persona draft.' }, { status: 500 });
  }
}

export const GET = withWorkspaceRoute(GET_handler);
export const POST = withWorkspaceRoute(POST_handler);
