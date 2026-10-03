import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { getCurrentWorkspace, getWorkspaceDataDir } from '@/utils/workspace';
import { getWorkerCompatibility } from '@/backend/services/workspace/workerCompatibility';
import { isWorkerMode, getWorkerBootstrapStatus, assertWorkerRequestReady } from '@/backend/services/workspace/workerMode';
import { assertSnapshotBearer } from '@/backend/services/workspace/snapshotControlAuth';
import { resolveOwnerRequest, type OwnerRequestAuthorization } from '@/backend/services/security/ownerAccess';
import { boundedJsonReader } from '@/backend/services/operations/boundedRead';
import { collectOperationsSnapshot } from '@/backend/services/operations/snapshot';

export const runtime = 'nodejs';

type Admission = { worker: true } | { worker: false; authorization: OwnerRequestAuthorization };

const wrapped = withWorkspaceRoute(async (request: Request, admission: Admission) => {
  const locked = await assertUnlocked();
  if (locked) return locked;
  try {
    const [{ getSchedulerService }, { FlowExecutor }, { listRuntimes }, { inspectWorkerRecovery }] = await Promise.all([
      import('@/backend/services/scheduler'), import('@/backend/execution/flow/FlowExecutor'),
      import('@/backend/services/mcp/lifecycleCoordinator'), import('@/backend/services/scheduler/workerLocalRecovery'),
    ]);
    const scheduler = getSchedulerService();
    const budget = process.env.FLUJO_OPERATIONS_RSS_BUDGET_BYTES;
    const snapshot = await collectOperationsSnapshot({
      workspace: getCurrentWorkspace(), compatibility: getWorkerCompatibility(), worker: getWorkerBootstrapStatus(),
      actor: admission.worker ? { kind: 'worker-control' } : { kind: 'owner',
        ownerId: admission.authorization.principal.ownerId, credentialId: admission.authorization.principal.credentialId },
      read: boundedJsonReader(getWorkspaceDataDir()), scheduler: plans => scheduler.inspectOperations(plans),
      workerRecovery: inspectWorkerRecovery, active: FlowExecutor.conversationStates.values(), mcp: listRuntimes(),
      memory: process.memoryUsage(), ...(budget === undefined ? {} : { rssBudgetBytes: Number(budget) }),
    });
    if (isWorkerMode() !== admission.worker) return Response.json({ error: 'Operations profile changed.' },
      { status: 409, headers: { 'Cache-Control': 'no-store' } });
    const revoked = admission.worker ? assertSnapshotBearer(request) : admission.authorization.recheck();
    if (revoked) return revoked;
    const unavailable = assertWorkerRequestReady(request, getCurrentWorkspace());
    if (unavailable) return unavailable;
    return Response.json(snapshot, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    // No prompt, provider message, command, credential or private filesystem error.
    return Response.json({ error: 'Operations observations are unavailable.', code: 'OPERATIONS_UNAVAILABLE' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
});

/** Authentication precedes workspace/storage selection, including direct handler imports. */
export function GET(request: Request) {
  if (isWorkerMode()) {
    const unauthorized = assertSnapshotBearer(request);
    if (unauthorized) return unauthorized;
    return wrapped(request, { worker: true });
  }
  const resolved = resolveOwnerRequest(request, ['control:admin', 'secrets:read']);
  if (!resolved.ok) return resolved.response;
  return wrapped(request, { worker: false, authorization: resolved.authorization });
}
