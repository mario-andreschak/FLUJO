import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { personaImprovementErrorResponse } from '@/app/v1/personas/_improvementResponse';
import {
  activateBehaviorProposal,
  approveBehaviorProposal,
  BehaviorLearningPolicyError,
  getBehaviorProposal,
} from '@/backend/services/enduringAgents';
import { EnduringAgentIdSchema } from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/personas/[personaId]/improvements/[proposalId]/apply/route');
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
    let proposal = await getBehaviorProposal(proposalId);
    if (!proposal || proposal.personaId !== personaId) {
      return NextResponse.json({ error: 'Improvement not found.' }, { status: 404 });
    }
    if (proposal.status === 'awaiting_approval') {
      proposal = await approveBehaviorProposal(proposal.id, {
        actor: 'persona-owner',
        reason: 'Accepted from the Persona Improvements screen.',
      });
    }
    if (proposal.status === 'approved') {
      proposal = await activateBehaviorProposal(proposal.id);
    }
    if (proposal.status !== 'activated') {
      throw new BehaviorLearningPolicyError('This improvement is not ready to apply.');
    }
    return NextResponse.json(proposal);
  } catch (error) {
    const response = personaImprovementErrorResponse(error); if (response) return response;
    log.error('Failed to apply Persona improvement', error);
    return NextResponse.json({ error: 'Could not apply this improvement.' }, { status: 500 });
  }
}

export const POST = withWorkspaceRoute(POST_handler);
