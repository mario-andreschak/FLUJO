import { assertSnapshotBearer } from '@/backend/services/workspace/snapshotControlAuth';
import { getWorkerBootstrapStatus, isWorkerMode } from '@/backend/services/workspace/workerMode';

// FLUJO_INSTALLATION_WIDE_ROUTE: reports bootstrap failures before a workspace exists.
export async function GET(request: Request): Promise<Response> {
  const unauthorized = assertSnapshotBearer(request);
  if (unauthorized) return unauthorized;
  if (!isWorkerMode()) return Response.json({ error: 'Worker mode is not enabled.' }, { status: 404 });
  const status = getWorkerBootstrapStatus();
  return Response.json(status, {
    status: status.state === 'ready' ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
