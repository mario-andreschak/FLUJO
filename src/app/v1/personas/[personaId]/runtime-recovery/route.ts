import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import {
  PersonaRuntimeCorruptionError,
  PersonaRuntimeNotFoundError,
  PersonaRuntimeRecoveryConflictError,
  PersonaRuntimeUnavailableError,
  inspectAndReconcilePersonaRuntime,
  recoverPersonaRuntime,
} from '@/backend/services/enduringAgents';
import { EnduringAgentIdSchema } from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/personas/[personaId]/runtime-recovery/route');
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ personaId: string }> };

async function POST_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request, { strictLoopback: true }); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { personaId } = await params;
  if (!EnduringAgentIdSchema.safeParse(personaId).success) {
    return NextResponse.json({ error: 'Persona not found.' }, { status: 404 });
  }
  const body = await request.json().catch(() => null);
  try {
    const recovery = await recoverPersonaRuntime({
      ...(body && typeof body === 'object' ? body : {}),
      personaId,
    });
    const runtime = await inspectAndReconcilePersonaRuntime(personaId);
    return runtime
      ? NextResponse.json({ recovery, runtime })
      : NextResponse.json({ error: 'Persona not found.' }, { status: 404 });
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        { error: 'Runtime recovery requires exact confirmation RECOVER.' },
        { status: 400 },
      );
    }
    if (error instanceof PersonaRuntimeNotFoundError) {
      return NextResponse.json({ error: 'Persona not found.' }, { status: 404 });
    }
    if (error instanceof PersonaRuntimeRecoveryConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (
      error instanceof PersonaRuntimeCorruptionError
      || error instanceof PersonaRuntimeUnavailableError
    ) {
      return NextResponse.json(
        { error: 'Persona runtime could not be repaired safely.' },
        { status: 409 },
      );
    }
    log.error(`Failed to recover Persona runtime ${JSON.stringify(personaId)}`, error);
    return NextResponse.json({ error: 'Failed to recover Persona runtime.' }, { status: 500 });
  }
}

export const POST = withWorkspaceRoute(POST_handler);
