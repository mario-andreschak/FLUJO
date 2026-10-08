import { SnapshotCoordinatorError } from '@/backend/services/workspace/snapshotCoordinator';
import { assertSnapshotBearer } from '@/backend/services/workspace/snapshotControlAuth';
import { assertLocalRequest } from '@/utils/http/localRequest';

export function authorizeSnapshotRequest(request: Request): Response | null {
  const notLocal = assertLocalRequest(request, { strictLoopback: true });
  if (notLocal) return notLocal;
  return assertSnapshotBearer(request);
}

export function snapshotSessionId(request: Request): string | null {
  try {
    return new URL(request.url).searchParams.get('sessionId');
  } catch {
    return null;
  }
}

export function noStoreJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export function snapshotRouteError(error: unknown): Response {
  if (error instanceof SnapshotCoordinatorError) {
    return noStoreJson({ error: error.message, code: error.code }, error.status);
  }
  return noStoreJson(
    { error: 'Snapshot operation failed.', code: 'SNAPSHOT_FAILED' },
    500,
  );
}
