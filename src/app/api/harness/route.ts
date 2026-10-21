import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { createHarnessRun, listHarnessRunSummaries } from '@/backend/services/harness/service';
import { harnessModelOptions } from '@/backend/services/harness/model';
import { harnessBody, harnessErrorResponse } from './_helpers';

export const runtime = 'nodejs';

export const GET = withWorkspaceRoute(async () => {
  const locked = await assertUnlocked();
  if (locked) return locked;
  try {
    const [runs, models] = await Promise.all([listHarnessRunSummaries(), harnessModelOptions()]);
    return Response.json({ models, runs: runs.slice(0, 100).map(run => ({
      id: run.id, name: run.name, status: run.status, createdAt: run.createdAt,
      callsCompleted: run.callsCompleted, eligible: run.eligible,
    })) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return harnessErrorResponse(error); }
});

export const POST = withWorkspaceRoute(async (request: Request) => {
  const locked = await assertUnlocked();
  if (locked) return locked;
  try { return Response.json(await createHarnessRun(await harnessBody(request)), { status: 201 }); }
  catch (error) { return harnessErrorResponse(error); }
});
