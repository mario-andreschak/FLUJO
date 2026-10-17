import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { GoalSourceUnavailableError, readPersonaGoalSource } from '@/backend/services/enduringAgents/goalSourceRead';
import { getPersonaWorkItem } from '@/backend/services/enduringAgents/store';
import { EnduringAgentIdSchema } from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';
import { PersonaShardIdentityError } from '@/utils/storage/personaShardIdentity';
import { getCurrentWorkspace } from '@/utils/workspace';

const log = createLogger('app/v1/personas/[personaId]/work-items/[workItemId]/source/route');
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
type RouteContext = { params: Promise<{ personaId: string; workItemId: string }> };

async function GET_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request, { strictLoopback: true }); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { personaId, workItemId } = await params;
  const notFound = () => NextResponse.json({ error: 'Goal not found.' }, { status: 404, headers });
  if (!EnduringAgentIdSchema.safeParse(personaId).success
    || !EnduringAgentIdSchema.safeParse(workItemId).success) return notFound();
  try {
    const item = await getPersonaWorkItem(personaId, workItemId).catch((error: unknown) => {
      if (error instanceof PersonaShardIdentityError) return null;
      throw error;
    });
    if (!item || item.personaId !== personaId || item.parentGoalId || !item.goal) return notFound();
    const source = await readPersonaGoalSource(personaId, workItemId);
    const body = JSON.stringify({ schema: 'flujo-goal-source/v1', workspaceId: getCurrentWorkspace(), personaId, ...source });
    if (Buffer.byteLength(body, 'utf8') > 1024 * 1024) {
      return NextResponse.json({ error: 'Original Goal source exceeds the read limit.' }, { status: 413, headers });
    }
    return new NextResponse(body, { headers: { ...headers, 'Content-Type': 'application/json' } });
  } catch (error) {
    if (error instanceof GoalSourceUnavailableError || error instanceof PersonaShardIdentityError) {
      return NextResponse.json({ error: 'Original Goal source is not currently verified.' }, { status: 409, headers });
    }
    log.error('Failed to read original Persona Goal source', error);
    return NextResponse.json({ error: 'Goal source is unavailable.' }, { status: 503, headers });
  }
}

// Original owner/workspace, strict loopback and encryption gates remain intact.
export const GET = withWorkspaceRoute(GET_handler);
