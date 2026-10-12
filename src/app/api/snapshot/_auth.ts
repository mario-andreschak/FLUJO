import { SnapshotCoordinatorError } from '@/backend/services/workspace/snapshotCoordinator';
import { assertSnapshotBearer } from '@/backend/services/workspace/snapshotControlAuth';
import { getWorkerBootstrapStatus, isWorkerMode } from '@/backend/services/workspace/workerMode';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { getCurrentWorkspace } from '@/utils/workspace';

export function authorizeSnapshotRequest(request: Request): Response | null {
  if (isWorkerMode() && process.env.FLUJO_WORKER_SNAPSHOT_SOURCE === '1') {
    // Repeat the worker bearer check in the handler before inspecting any body.
    // Private network membership and a caller-supplied Host are not authority.
    const unauthorized = assertSnapshotBearer(request);
    if (unauthorized) return unauthorized;
    // This profile requires an explicit deployment choice, not legacy hostname
    // inference or an invalid exposure value falling back to network mode.
    if (process.env.FLUJO_EXPOSURE_MODE?.trim().toLowerCase() !== 'network') {
      return noStoreJson({ error: 'Worker snapshot sources require network exposure.' }, 403);
    }
    const notLocal = assertLocalRequest(request);
    if (notLocal) return notLocal;
    const status = getWorkerBootstrapStatus();
    if (status.state !== 'ready' || !status.workspace) {
      return noStoreJson({ error: 'Worker is not ready.', code: 'WORKER_NOT_READY' }, 503);
    }
    if (status.workspace !== getCurrentWorkspace()) {
      return noStoreJson({ error: 'This workspace is not assigned to the worker.' }, 404);
    }
    return null;
  }
  // Desktop and existing workers retain the original loopback control plane.
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
