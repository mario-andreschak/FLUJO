import { assertSnapshotBearer } from '@/backend/services/workspace/snapshotControlAuth';
import { isWorkerMode } from '@/backend/services/workspace/workerMode';
import { resolveOwnerRequest, type OwnerRequestAuthorization } from '@/backend/services/security/ownerAccess';
import { getExposureMode } from '@/utils/http/exposureMode';
import { assertLocalRequest } from '@/utils/http/localRequest';

export type Admission = { worker: true } | { worker: false; local: true }
  | { worker: false; local?: false; authorization: OwnerRequestAuthorization };

/** Same rule as every other API route (assertOwnerRequest): a localhost-only
 * install without an owner policy has no login, so admit loopback callers. */
function localWithoutOwnerPolicy(): boolean {
  return process.env.FLUJO_OWNER_AUTH_FILE === undefined && getExposureMode() === 'localhost';
}

export function recheckAdmission(request: Request, admission: Admission): Response | null {
  if (admission.worker) return assertSnapshotBearer(request);
  if (admission.local) return localWithoutOwnerPolicy() ? assertLocalRequest(request, { strictLoopback: true }) : Response.json(
    { error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  return admission.authorization.recheck();
}

/** Who may reach the operations routes. Decided before any workspace or storage is selected. */
export function admitOperationsRequest(request: Request): { admission: Admission } | { response: Response } {
  if (isWorkerMode()) {
    const unauthorized = assertSnapshotBearer(request);
    return unauthorized ? { response: unauthorized } : { admission: { worker: true } };
  }
  if (localWithoutOwnerPolicy()) {
    const notLocal = assertLocalRequest(request, { strictLoopback: true });
    return notLocal ? { response: notLocal } : { admission: { worker: false, local: true } };
  }
  const resolved = resolveOwnerRequest(request, ['control:admin', 'secrets:read']);
  return resolved.ok
    ? { admission: { worker: false, authorization: resolved.authorization } }
    : { response: resolved.response };
}

/** A credential tied to one workspace is refused everywhere else. */
export function workspaceForbidden(admission: Admission, workspace: string): Response | null {
  if (!admission.worker && !admission.local && admission.authorization.principal.workspaceId
      && admission.authorization.principal.workspaceId !== workspace) {
    return Response.json({ error: 'Forbidden' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
  return null;
}
