import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { personaDomainErrorResponse } from '@/app/v1/personas/_domainResponse';
import { resolveMemoryConflict } from '@/backend/services/enduringAgents';
import {
  EnduringAgentIdSchema,
  ResolveMemoryConflictInputSchema,
} from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger(
  'app/v1/personas/[personaId]/memories/[memoryId]/resolve-conflict/route',
);
export const dynamic = 'force-dynamic';
type RouteContext = { params: Promise<{ personaId: string; memoryId: string }> };

async function POST_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { personaId, memoryId } = await params;
  if (
    !EnduringAgentIdSchema.safeParse(personaId).success
    || !EnduringAgentIdSchema.safeParse(memoryId).success
  ) {
    return NextResponse.json({ error: 'MemoryItem not found.' }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const parsed = ResolveMemoryConflictInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid conflict resolution request.', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json(await resolveMemoryConflict(personaId, memoryId, parsed.data));
  } catch (error) {
    const response = personaDomainErrorResponse(error); if (response) return response;
    log.error('Failed to resolve Persona memory conflict', error);
    return NextResponse.json(
      { error: 'Failed to resolve Persona memory conflict.' },
      { status: 500 },
    );
  }
}

export const POST = withWorkspaceRoute(POST_handler);
