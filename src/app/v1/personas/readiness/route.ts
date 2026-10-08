import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { getPersonaCreationReadiness, RoleVersionNotFoundError } from '@/backend/services/enduringAgents/factory';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/personas/readiness');
export const dynamic = 'force-dynamic';

async function POST_handler(request: NextRequest) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  try {
    return NextResponse.json(await getPersonaCreationReadiness(await request.json().catch(() => null)));
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json({ error: 'Invalid Persona configuration.' }, { status: 400 });
    }
    if (error instanceof RoleVersionNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    log.error('Failed to check Persona readiness', error);
    return NextResponse.json({ error: 'Could not check Persona setup.' }, { status: 500 });
  }
}

export const POST = withWorkspaceRoute(POST_handler);
