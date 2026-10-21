import { z } from 'zod';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { advanceHarnessRun, cancelHarnessRun, getHarnessRun, promoteHarnessRun } from '@/backend/services/harness/service';
import { harnessBody, harnessErrorResponse } from '../_helpers';

export const runtime = 'nodejs';
export const maxDuration = 200;
type Context = { params: Promise<{ id: string }> };

export const GET = withWorkspaceRoute(async (request: Request, context: Context) => {
  const locked = await assertUnlocked();
  if (locked) return locked;
  try {
    const id = z.uuid().parse((await context.params).id);
    const run = await getHarnessRun(id);
    return Response.json(run, { headers: { 'Cache-Control': 'no-store',
      ...(new URL(request.url).searchParams.has('download') ? { 'Content-Disposition': `attachment; filename="harness-${id}.json"` } : {}),
    } });
  } catch (error) { return harnessErrorResponse(error); }
});

export const POST = withWorkspaceRoute(async (request: Request, context: Context) => {
  const locked = await assertUnlocked();
  if (locked) return locked;
  try {
    const id = z.uuid().parse((await context.params).id);
    const { action } = z.object({ action: z.enum(['advance', 'cancel', 'promote']) }).strict().parse(await harnessBody(request));
    const run = action === 'advance' ? await advanceHarnessRun(id, request.signal)
      : action === 'cancel' ? await cancelHarnessRun(id) : await promoteHarnessRun(id);
    return Response.json(run);
  } catch (error) { return harnessErrorResponse(error); }
});
