import { assertSnapshotBearer } from '@/backend/services/workspace/snapshotControlAuth';
import { resolveOwnerRequest, type OwnerRequestAuthorization } from '@/backend/services/security/ownerAccess';
import { isWorkerMode } from '@/backend/services/workspace/workerMode';
import { getExposureMode } from '@/utils/http/exposureMode';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { getCurrentWorkspace } from '@/utils/workspace';

/** Who may read operations data. Shared by every /api/operations route. */
export type OperationsAdmission = { worker: true } | { worker: false; local: true }
  | { worker: false; local?: false; authorization: OwnerRequestAuthorization };

/** Same rule as every other API route (assertOwnerRequest): a localhost-only
 * install without an owner policy has no login, so admit loopback callers. */
function localWithoutOwnerPolicy(): boolean {
  return process.env.FLUJO_OWNER_AUTH_FILE === undefined && getExposureMode() === 'localhost';
}

export function recheckOperationsAdmission(request: Request, admission: OperationsAdmission): Response | null {
  if (admission.worker) return assertSnapshotBearer(request);
  if (admission.local) return localWithoutOwnerPolicy() ? assertLocalRequest(request, { strictLoopback: true }) : Response.json(
    { error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  return admission.authorization.recheck();
}

/** Authentication precedes workspace and storage selection, including direct handler imports. */
export function admitOperationsRequest(request: Request): { admission: OperationsAdmission } | { response: Response } {
  if (isWorkerMode()) {
    const unauthorized = assertSnapshotBearer(request);
    return unauthorized ? { response: unauthorized } : { admission: { worker: true } };
  }
  if (localWithoutOwnerPolicy()) {
    const notLocal = assertLocalRequest(request, { strictLoopback: true });
    return notLocal ? { response: notLocal } : { admission: { worker: false, local: true } };
  }
  const resolved = resolveOwnerRequest(request, ['control:admin', 'secrets:read']);
  return resolved.ok ? { admission: { worker: false, authorization: resolved.authorization } } : { response: resolved.response };
}

/** A credential tied to one workspace cannot read another workspace's data. */
export function operationsWorkspaceRefusal(admission: OperationsAdmission): Response | null {
  if (admission.worker || admission.local) return null;
  const { workspaceId } = admission.authorization.principal;
  return workspaceId && workspaceId !== getCurrentWorkspace()
    ? Response.json({ error: 'Forbidden' }, { status: 403, headers: { 'Cache-Control': 'no-store' } })
    : null;
}
