import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { personaImprovementErrorResponse } from '@/app/v1/personas/_improvementResponse';
import {
  getBehaviorProposal,
  promoteBehaviorProposalToRoleVersion,
} from '@/backend/services/enduringAgents';
import { EnduringAgentIdSchema } from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger(
  'app/v1/personas/[personaId]/improvements/[proposalId]/promote/route',
);
export const dynamic = 'force-dynamic';
type RouteContext = { params: Promise<{ personaId: string; proposalId: string }> };

const PromoteImprovementInputSchema = z.object({
  confirmation: z.literal('PROMOTE'),
  migrationNotes: z.string().trim().min(1).max(10_000),
}).strict();

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
    const input = PromoteImprovementInputSchema.parse(
      await request.json().catch(() => null),
    );
    const roleVersion = await promoteBehaviorProposalToRoleVersion(proposal.id, {
      confirmation: input.confirmation,
      actor: 'persona-owner',
      migrationNotes: input.migrationNotes,
    });
    const updated = await getBehaviorProposal(proposal.id);
    if (!updated) throw new Error('Promoted improvement could not be reloaded.');
    return NextResponse.json({ proposal: updated, roleVersion });
  } catch (error) {
    const response = personaImprovementErrorResponse(error); if (response) return response;
    log.error('Failed to save Persona improvement as a Role version', error);
    return NextResponse.json({ error: 'Could not save this improvement as a Role version.' }, { status: 500 });
  }
}

export const POST = withWorkspaceRoute(POST_handler);
