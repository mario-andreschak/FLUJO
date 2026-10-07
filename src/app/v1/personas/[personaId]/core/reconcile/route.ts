import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import {
  PersonaCorePreparationConflictError,
  reconcileDisabledPersonaCore,
} from '@/backend/services/enduringAgents/personaCorePreparation';
import { EnduringAgentIdSchema } from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/personas/[personaId]/core/reconcile/route');
export const dynamic = 'force-dynamic';

const InputSchema = z.object({
  expectedCoreFlowRef: z.string().trim().min(1).max(256),
  expectedActiveRevisionId: EnduringAgentIdSchema,
}).strict();

async function POST_handler(
  request: NextRequest,
  { params }: { params: Promise<{ personaId: string }> },
) {
  const notLoopback = assertLocalRequest(request, { strictLoopback: true });
  if (notLoopback) return notLoopback;
  const locked = await assertUnlocked({ openai: true });
  if (locked) return locked;
  const { personaId } = await params;
  if (!EnduringAgentIdSchema.safeParse(personaId).success) {
    return NextResponse.json({ error: 'Persona not found.' }, { status: 404 });
  }
  const parsed = InputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid Core reconciliation request.' }, { status: 400 });
  try {
    return NextResponse.json(await reconcileDisabledPersonaCore({ personaId, ...parsed.data }));
  } catch (error) {
    if (error instanceof PersonaCorePreparationConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    log.error('Failed to reconcile disabled Persona Core', error);
    return NextResponse.json({ error: 'Failed to reconcile Persona Core.' }, { status: 500 });
  }
}

export const POST = withWorkspaceRoute(POST_handler);
