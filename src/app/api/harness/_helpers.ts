import { z } from 'zod';
import { HarnessError } from '@/backend/services/harness/service';
import { HarnessModelError } from '@/backend/services/harness/model';
import { readBoundedBody } from '@/utils/http/boundedBody';

export async function harnessBody(request: Request, maxBytes = 192 * 1024): Promise<unknown> {
  try { return JSON.parse((await readBoundedBody(request, maxBytes)).toString('utf8')); }
  catch { throw new HarnessError(`Provide a JSON body smaller than ${Math.round(maxBytes / 1024)} KiB.`); }
}

export function harnessErrorResponse(error: unknown) {
  if (error instanceof HarnessError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof HarnessModelError) return Response.json({ error: error.message }, { status: 409 });
  if (error instanceof z.ZodError) return Response.json({ error: 'Invalid experiment request.' }, { status: 400 });
  return Response.json({ error: 'Harness Lab could not complete this operation. Check the selected model connection and workspace storage, then reload the experiment.' }, { status: 500 });
}
