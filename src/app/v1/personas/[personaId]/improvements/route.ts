import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import {
  listBehaviorOutcomeMetrics,
  listBehaviorProposals,
} from '@/backend/services/enduringAgents';
import {
  EnduringAgentIdSchema,
  type BehaviorProposalWithOutcome,
} from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/personas/[personaId]/improvements/route');
export const dynamic = 'force-dynamic';
type RouteContext = { params: Promise<{ personaId: string }> };

async function GET_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { personaId } = await params;
  if (!EnduringAgentIdSchema.safeParse(personaId).success) {
    return NextResponse.json({ error: 'Persona not found.' }, { status: 404 });
  }
  try {
    // The outcome metric is attached per proposal rather than returned as a
    // separate top-level shape, so existing clients keep reading an array.
    const [proposals, metrics] = await Promise.all([
      listBehaviorProposals(personaId),
      listBehaviorOutcomeMetrics(personaId),
    ]);
    const byProposalId = new Map(metrics.map((metric) => [metric.proposalId, metric]));
    const payload: BehaviorProposalWithOutcome[] = proposals.map((proposal) => {
      const outcome = byProposalId.get(proposal.id);
      return outcome ? { ...proposal, outcome } : proposal;
    });
    return NextResponse.json(payload);
  } catch (error) {
    log.error('Failed to list Persona improvements', error);
    return NextResponse.json({ error: 'Could not load improvements.' }, { status: 500 });
  }
}

export const GET = withWorkspaceRoute(GET_handler);
