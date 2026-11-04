import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { createHarnessComparison, listHarnessComparisons } from '@/backend/services/harness/comparison';
import { harnessBody, harnessErrorResponse } from '../_helpers';

export const runtime = 'nodejs';

export const GET = withWorkspaceRoute(async () => {
  const locked = await assertUnlocked();
  if (locked) return locked;
  try {
    return Response.json({ comparisons: await listHarnessComparisons() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return harnessErrorResponse(error); }
});

export const POST = withWorkspaceRoute(async (request: Request) => {
  const locked = await assertUnlocked();
  if (locked) return locked;
  try { return Response.json(await createHarnessComparison(await harnessBody(request)), { status: 201 }); }
  catch (error) { return harnessErrorResponse(error); }
});
