import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { validateFlowObjectForRun } from '@/backend/execution/flow/validateFlowForRun';
import { flowService } from '@/backend/services/flow';
import { WorkspaceFlowRefSchema } from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { snapshotBehaviorFlowDependencies } from '@/backend/services/enduringAgents/behaviorRevisions';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ flowRef: string }> };

async function GET_handler(request: NextRequest, context: RouteContext) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;

  const parsed = WorkspaceFlowRefSchema.safeParse((await context.params).flowRef);
  if (!parsed.success) {
    return NextResponse.json({ state: 'missing', issues: ['The selected Flow is unavailable.'] });
  }

  const flow = await flowService.getFlow(parsed.data);
  if (!flow || flow.personaOwnership) {
    return NextResponse.json({ state: 'missing', issues: ['The selected Flow is unavailable.'] });
  }

  const validation = await validateFlowObjectForRun(flow);
  const allowModelFallback = request.nextUrl.searchParams.get('allowModelFallback') === '1';
  const blockingIssues = validation.issues.filter((issue) => (
    issue.severity === 'error'
    && !(allowModelFallback && issue.code === 'process-missing-model')
  ));
  const issues = blockingIssues.map((issue) => issue.message);
  try { await snapshotBehaviorFlowDependencies(flow); }
  catch (error) { issues.push(error instanceof Error ? error.message : 'Subflow dependencies could not be pinned.'); }
  return NextResponse.json({
    state: issues.length === 0 ? 'ready' : 'invalid',
    issues,
  });
}

export const GET = withWorkspaceRoute(GET_handler);
