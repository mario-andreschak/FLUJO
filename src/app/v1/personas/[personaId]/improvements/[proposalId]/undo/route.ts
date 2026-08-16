import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { personaImprovementErrorResponse } from '@/app/v1/personas/_improvementResponse';
import {
  getBehaviorProposal,
  rollbackBehaviorProposal,
} from '@/backend/services/enduringAgents';
import { EnduringAgentIdSchema } from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/personas/[personaId]/improvements/[proposalId]/undo/route');
export const dynamic = 'force-dynamic';
type RouteContext = { params: Promise<{ personaId: string; proposalId: string }> };

async function POST_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { personaId, proposalId } = await params;
  if (
    !EnduringAgentIdSchema.safeParse(personaId).success
    || !EnduringAgentIdSchema.safeParse(proposalId).success
  ) {
    return NextResponse.json({ error: 'Improvement not found.' }, { status: 404 });
  }
  try {
    const proposal = await getBehaviorProposal(proposalId);
    if (!proposal || proposal.personaId !== personaId) {
      return NextResponse.json({ error: 'Improvement not found.' }, { status: 404 });
    }
    return NextResponse.json(await rollbackBehaviorProposal(proposal.id, {
      actor: 'persona-owner',
      reason: 'Undone from the Persona Improvements screen.',
    }));
  } catch (error) {
    const response = personaImprovementErrorResponse(error); if (response) return response;
    log.error('Failed to undo Persona improvement', error);
    return NextResponse.json({ error: 'Could not undo this improvement.' }, { status: 500 });
  }
}

export const POST = withWorkspaceRoute(POST_handler);
