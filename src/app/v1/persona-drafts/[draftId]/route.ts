import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import {
  PersonaDraftConflictError,
  PersonaDraftNotFoundError,
  deletePersonaCreationDraft,
  getPersonaCreationDraft,
  updatePersonaCreationDraft,
} from '@/backend/services/enduringAgents';
import { EnduringAgentIdSchema } from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/persona-drafts/[draftId]/route');
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ draftId: string }> };

function invalidDraftId(draftId: string): NextResponse | null {
  return EnduringAgentIdSchema.safeParse(draftId).success
    ? null
    : NextResponse.json({ error: 'Persona draft not found.' }, { status: 404 });
}

function draftErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: 'Invalid Persona draft.', details: error.flatten() },
      { status: 400 },
    );
  }
  if (error instanceof PersonaDraftNotFoundError) {
    return NextResponse.json({
      error: error.message,
      code: error.code,
    }, { status: 404 });
  }
  if (error instanceof PersonaDraftConflictError) {
    return NextResponse.json({
      error: error.message,
      code: error.code,
      details: error.details,
    }, { status: 409 });
  }
  return null;
}

async function GET_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { draftId } = await params;
  const invalid = invalidDraftId(draftId); if (invalid) return invalid;
  try {
    const draft = await getPersonaCreationDraft(draftId);
    return draft
      ? NextResponse.json(draft)
      : NextResponse.json({ error: 'Persona draft not found.' }, { status: 404 });
  } catch (error) {
    log.error(`Failed to read Persona draft ${JSON.stringify(draftId)}`, error);
    return NextResponse.json({ error: 'Failed to read Persona draft.' }, { status: 500 });
  }
}

async function PATCH_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { draftId } = await params;
  const invalid = invalidDraftId(draftId); if (invalid) return invalid;
  const body = await request.json().catch(() => null);
  try {
    return NextResponse.json(await updatePersonaCreationDraft(draftId, body));
  } catch (error) {
    const response = draftErrorResponse(error); if (response) return response;
    log.error(`Failed to update Persona draft ${JSON.stringify(draftId)}`, error);
    return NextResponse.json({ error: 'Failed to update Persona draft.' }, { status: 500 });
  }
}

async function DELETE_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { draftId } = await params;
  const invalid = invalidDraftId(draftId); if (invalid) return invalid;
  const body = await request.json().catch(() => null);
  try {
    await deletePersonaCreationDraft(draftId, body);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    const response = draftErrorResponse(error); if (response) return response;
    log.error(`Failed to discard Persona draft ${JSON.stringify(draftId)}`, error);
    return NextResponse.json({ error: 'Failed to discard Persona draft.' }, { status: 500 });
  }
}

export const GET = withWorkspaceRoute(GET_handler);
export const PATCH = withWorkspaceRoute(PATCH_handler);
export const DELETE = withWorkspaceRoute(DELETE_handler);
