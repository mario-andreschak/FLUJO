import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { personaDomainErrorResponse } from '@/app/v1/personas/_domainResponse';
import {
  PERSONA_WORK_ITEM_CONTROL_ACTIONS,
  controlPersonaWorkItem,
} from '@/backend/services/enduringAgents';
import { EnduringAgentIdSchema } from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger(
  'app/v1/personas/[personaId]/work-items/[workItemId]/control/route',
);
const ControlInputSchema = z.object({
  action: z.enum(PERSONA_WORK_ITEM_CONTROL_ACTIONS),
}).strict();

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ personaId: string; workItemId: string }>;
};

async function POST_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { personaId, workItemId } = await params;
  if (
    !EnduringAgentIdSchema.safeParse(personaId).success
    || !EnduringAgentIdSchema.safeParse(workItemId).success
  ) {
    return NextResponse.json({ error: 'Task not found.' }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  try {
    const { action } = ControlInputSchema.parse(body);
    return NextResponse.json(await controlPersonaWorkItem(personaId, workItemId, action));
  } catch (error) {
    const response = personaDomainErrorResponse(error); if (response) return response;
    log.error('Failed to control Persona Task', error);
    return NextResponse.json({ error: 'Could not change this Task right now.' }, { status: 500 });
  }
}

export const POST = withWorkspaceRoute(POST_handler);
