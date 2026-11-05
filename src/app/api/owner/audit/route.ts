import { accessRecordWritable, readAccessEvents } from '@/backend/services/security/accessAudit';
import { accessErrorResponse, accessJson, requireNamedActor } from '../_access';

// FLUJO_INSTALLATION_WIDE_ROUTE: the access record belongs to the installation.
export const runtime = 'nodejs';

/** Newest first. Someone bound to one workspace reads only that workspace's entries. */
export async function GET(request: Request): Promise<Response> {
  const admitted = requireNamedActor(request);
  if ('response' in admitted) return admitted.response;
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get('limit') ?? 100);
  const before = url.searchParams.get('before');
  const action = url.searchParams.get('action');
  if (!Number.isInteger(limit) || limit < 1 || limit > 500
    || (before !== null && !/^\d{1,16}$/.test(before))
    || (action !== null && !/^[a-z.]{1,40}$/.test(action))) {
    return accessJson({ error: 'Invalid filter.', code: 'INVALID' }, 400);
  }
  try {
    const { entries, truncated } = await readAccessEvents({
      limit, ...(before === null ? {} : { before: Number(before) }), ...(action === null ? {} : { action }),
      ...(admitted.actor.workspaceId ? { workspaceId: admitted.actor.workspaceId } : {}),
    });
    return accessJson({ entries, truncated, writable: accessRecordWritable() });
  } catch (error) { return accessErrorResponse(error); }
}
