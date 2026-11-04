import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { cancelOrDeleteHarnessComparison, getHarnessComparison } from '@/backend/services/harness/comparison';
import { harnessErrorResponse } from '../../_helpers';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withWorkspaceRoute(async (_request: Request, { params }: RouteContext) => {
  const locked = await assertUnlocked();
  if (locked) return locked;
  try {
    const { id } = await params;
    return Response.json(await getHarnessComparison(id), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return harnessErrorResponse(error); }
});

/** Stops a comparison that is still running, and otherwise removes its record. */
export const DELETE = withWorkspaceRoute(async (_request: Request, { params }: RouteContext) => {
  const locked = await assertUnlocked();
  if (locked) return locked;
  try {
    const { id } = await params;
    return Response.json(await cancelOrDeleteHarnessComparison(id));
  } catch (error) { return harnessErrorResponse(error); }
});
