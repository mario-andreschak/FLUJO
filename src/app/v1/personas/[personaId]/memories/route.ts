import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { personaDomainErrorResponse } from '@/app/v1/personas/_domainResponse';
import { rememberMemory, searchPersonaMemory } from '@/backend/services/enduringAgents';
import {
  EnduringAgentIdSchema,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  MEMORY_TRUST_LEVELS,
} from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/personas/[personaId]/memories/route');
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
    const rawLimit = request.nextUrl.searchParams.get('limit');
    const rawOrder = request.nextUrl.searchParams.get('order');
    if (rawOrder !== null && rawOrder !== 'review') {
      return NextResponse.json({ error: 'Invalid memory order.' }, { status: 400 });
    }
    if (rawLimit !== null && !/^[1-9]\\d*$/.test(rawLimit)) {
      return NextResponse.json({ error: 'Memory limit must be an integer from 1 to 200.' }, {
        status: 400,
      });
    }
    const limit = rawLimit === null ? undefined : Number(rawLimit);
    if (limit !== undefined && (limit < 1 || limit > 200)) {
      return NextResponse.json({ error: 'Memory limit must be an integer from 1 to 200.' }, {
        status: 400,
      });
    }
    const statuses = listParam(request.nextUrl.searchParams.get('status'), MEMORY_STATUSES)
      ?? [...MEMORY_STATUSES];
    return NextResponse.json(await searchPersonaMemory(personaId, {
      query: request.nextUrl.searchParams.get('q') ?? undefined,
      kinds: listParam(request.nextUrl.searchParams.get('kind'), MEMORY_KINDS),
      scopes: listParam(request.nextUrl.searchParams.get('scope'), MEMORY_SCOPES),
      statuses,
      trust: listParam(request.nextUrl.searchParams.get('trust'), MEMORY_TRUST_LEVELS),
      coreOnly: request.nextUrl.searchParams.get('coreOnly') === 'true',
      ...(rawOrder === 'review' ? { order: rawOrder } : {}),
      ...(limit !== undefined ? { limit } : rawOrder === 'review' ? { limit: 20 } : {}),
    }));
  } catch (error) {
    const response = personaDomainErrorResponse(error); if (response) return response;
    log.error('Failed to search Persona memory', error);
    return NextResponse.json({ error: 'Failed to search Persona memory.' }, { status: 500 });
  }
}

async function POST_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { personaId } = await params;
  if (!EnduringAgentIdSchema.safeParse(personaId).success) {
    return NextResponse.json({ error: 'Persona not found.' }, { status: 404 });
  }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  try {
    const { reviewed, ...payload } = body ?? {};
    return NextResponse.json(await rememberMemory(
      { ...payload, personaId } as never,
      { reviewed: reviewed === true },
    ), { status: 201 });
  } catch (error) {
    const response = personaDomainErrorResponse(error); if (response) return response;
    log.error('Failed to remember Persona memory', error);
    return NextResponse.json({ error: 'Failed to remember Persona memory.' }, { status: 500 });
  }
}

export const GET = withWorkspaceRoute(GET_handler);
export const POST = withWorkspaceRoute(POST_handler);
