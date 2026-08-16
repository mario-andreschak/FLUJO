import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { validateFlowObjectForRun } from '@/backend/execution/flow/validateFlowForRun';
import { flowService } from '@/backend/services/flow';
import { WorkspaceFlowRefSchema } from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';

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
  return NextResponse.json({
    state: validation.isRunnable ? 'ready' : 'invalid',
    issues: validation.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => issue.message),
  });
}

export const GET = withWorkspaceRoute(GET_handler);
