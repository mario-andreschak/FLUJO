import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { personaDomainErrorResponse } from '@/app/v1/personas/_domainResponse';
import {
  createPersonaWorkItem,
  queryPersonaWorkItems,
} from '@/backend/services/enduringAgents';
import { EnduringAgentIdSchema, PERSONA_PRIORITIES, PERSONA_WORK_ITEM_STATUSES } from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/personas/[personaId]/work-items/route');
export const dynamic = 'force-dynamic';
type RouteContext = { params: Promise<{ personaId: string }> };

function listParam<T extends string>(value: string | null, allowed: readonly T[]): T[] | undefined {
  if (!value) return undefined;
  const items = value.split(',').filter((item): item is T => allowed.includes(item as T));
  return items.length > 0 ? items : undefined;
}

async function GET_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { personaId } = await params;
  if (!EnduringAgentIdSchema.safeParse(personaId).success) {
    return NextResponse.json({ error: 'Persona not found.' }, { status: 404 });
  }
  try {
    const dueBefore = request.nextUrl.searchParams.get('dueBefore');
    return NextResponse.json(await queryPersonaWorkItems(personaId, {
      statuses: listParam(request.nextUrl.searchParams.get('status'), PERSONA_WORK_ITEM_STATUSES),
      priorities: listParam(request.nextUrl.searchParams.get('priority'), PERSONA_PRIORITIES),
      ...(dueBefore ? { dueBefore: Number(dueBefore) } : {}),
      includeBlockedByDependencies: request.nextUrl.searchParams.get('readyOnly') !== 'true',
    }));
  } catch (error) {
    const response = personaDomainErrorResponse(error); if (response) return response;
    log.error('Failed to list Persona WorkItems', error);
    return NextResponse.json({ error: 'Failed to list Persona WorkItems.' }, { status: 500 });
  }
}

async function POST_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { personaId } = await params;
  if (!EnduringAgentIdSchema.safeParse(personaId).success) {
    return NextResponse.json({ error: 'Persona not found.' }, { status: 404 });
  }
  const body = await request.json().catch(() => null);
  try {
    return NextResponse.json(await createPersonaWorkItem({ ...body, personaId }), { status: 201 });
  } catch (error) {
    const response = personaDomainErrorResponse(error); if (response) return response;
    log.error('Failed to create Persona WorkItem', error);
    return NextResponse.json({ error: 'Failed to create Persona WorkItem.' }, { status: 500 });
  }
}

export const GET = withWorkspaceRoute(GET_handler);
export const POST = withWorkspaceRoute(POST_handler);
