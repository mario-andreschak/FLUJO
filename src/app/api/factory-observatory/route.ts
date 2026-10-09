import { withWorkspaceRoute } from '@/app/api/_workspace';
import { readFactoryObservatorySnapshot } from '@/backend/services/factory/observatorySnapshot';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';

/** Local operator view; the FACTORY bearer never reaches browser code. */
async function GET_handler(request: Request): Promise<Response> {
  const notLocal = assertLocalRequest(request, { strictLoopback: true });
  if (notLocal) return notLocal;
  const locked = await assertUnlocked();
  if (locked) return locked;
  try {
    const snapshot = await readFactoryObservatorySnapshot();
    return Response.json(snapshot, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const code = error instanceof Error && error.message === 'FACTORY_NOT_CONFIGURED'
      ? 'FACTORY_NOT_CONFIGURED' : 'FACTORY_UNAVAILABLE';
    return Response.json({ error: code }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}

export const GET = withWorkspaceRoute(GET_handler);
