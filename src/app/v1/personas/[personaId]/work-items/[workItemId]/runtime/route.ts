import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { getPersonaWorkItem } from '@/backend/services/enduringAgents/store';
import { readPersonaGoalRuntime } from '@/backend/services/enduringAgents/goalRuntimeRead';
import { EnduringAgentIdSchema } from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';
import { getCurrentWorkspace } from '@/utils/workspace';

const log = createLogger('app/v1/personas/[personaId]/work-items/[workItemId]/runtime/route');
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
    const item = await getPersonaWorkItem(personaId, workItemId);
    if (!item || item.personaId !== personaId || item.parentGoalId || !item.goal) return notFound();
    // Reuse the same bounded, drift-checked join as the native Persona tool.
    // Never return the raw WorkItem, mailbox payload, Activity context or lease.
    const runtime = await readPersonaGoalRuntime(personaId, workItemId);
    return NextResponse.json({
      schema: 'flujo-goal-runtime/v1',
      workspaceId: getCurrentWorkspace(),
      personaId,
      runtime,
    }, { headers });
  } catch (error) {
    log.error('Failed to read Persona Goal runtime', error);
    return NextResponse.json({ error: 'Goal runtime is unavailable.' }, { status: 503, headers });
  }
}

// The ordinary owner/workspace transport guard remains mandatory; this is not
// a public MCP shortcut and never fabricates Persona execution authority.
export const GET = withWorkspaceRoute(GET_handler);
