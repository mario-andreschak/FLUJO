import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import {
  PersonaStorageStatsNotFoundError,
  PersonaStorageStatsUnavailableError,
  getPersonaStorageStats,
} from '@/backend/services/enduringAgents';
import { EnduringAgentIdSchema } from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/personas/[personaId]/storage-stats/route');
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ personaId: string }> };

function noStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

async function GET_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request);
  if (notLocal) return noStore(notLocal);

  const locked = await assertUnlocked();
  if (locked) return noStore(locked);

  const { personaId } = await params;
  if (!EnduringAgentIdSchema.safeParse(personaId).success) {
    return NextResponse.json(
      { error: 'Persona not found.' },
      { status: 404, headers: NO_STORE },
    );
  }

  try {
    return NextResponse.json(
      await getPersonaStorageStats(personaId),
      { headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof PersonaStorageStatsNotFoundError) {
      return NextResponse.json(
        { error: 'Persona not found.' },
        { status: 404, headers: NO_STORE },
      );
    }
    if (error instanceof PersonaStorageStatsUnavailableError) {
      return NextResponse.json(
        { error: 'Persona runtime storage statistics are unavailable.' },
        { status: 409, headers: NO_STORE },
      );
    }
    log.error(`Failed to collect Persona storage stats for ${JSON.stringify(personaId)}`, error);
    return NextResponse.json(
      { error: 'Failed to collect Persona storage statistics.' },
      { status: 500, headers: NO_STORE },
    );
  }
}

export const GET = withWorkspaceRoute(GET_handler);
