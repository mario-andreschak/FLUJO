import { withWorkspaceRoute } from '@/app/api/_workspace';
import { admitOperationsRequest, recheckAdmission, workspaceForbidden, type Admission } from '@/app/api/operations/_admission';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { getCurrentWorkspace, getWorkspaceDataDir } from '@/utils/workspace';
import { getWorkerCompatibility } from '@/backend/services/workspace/workerCompatibility';
import { isWorkerMode, getWorkerBootstrapStatus, assertWorkerRequestReady } from '@/backend/services/workspace/workerMode';
import { boundedJsonReader } from '@/backend/services/operations/boundedRead';
import { DESIRED_STATE_STATUS_PATH, projectDesiredStateStatus } from '@/backend/services/desiredState/status';
import { collectOperationsSnapshot, getObservationProcessId } from '@/backend/services/operations/snapshot';
import { getFlowRunAdmissionDiagnostics } from '@/backend/execution/flow/runAdmission';
import { getSubflowPreparationDiagnostics } from '@/backend/execution/flow/subflowPreparationBudget';
import { getSubflowOutputDiagnostics } from '@/backend/execution/flow/subflowOutputBudget';
import { getAllocationReservationSnapshot } from '@/backend/execution/flow/allocationReservations';
import { getConversationPublicationDiagnostics } from '@/backend/execution/flow/conversationPublication';
import { getChatIngressDiagnostics } from '@/utils/http/chatIngress';
import { getChatRateDiagnostics } from '@/utils/http/chatRateLimit';

export const runtime = 'nodejs';

/** Which version this workspace is on. A stored record that cannot be read counts as none. */
async function readDesiredState() {
  try {
    return projectDesiredStateStatus(await boundedJsonReader(getWorkspaceDataDir())(DESIRED_STATE_STATUS_PATH));
  } catch {
    return projectDesiredStateStatus(undefined);
  }
}

const GET_handler = async (request: Request, admission: Admission) => {
  const workspace = getCurrentWorkspace();
  const forbidden = workspaceForbidden(admission, workspace);
  if (forbidden) return forbidden;
  const locked = await assertUnlocked();
  if (locked) return locked;
  try {
    const [{ getSchedulerService }, { FlowExecutor }, { listRuntimes }, { inspectWorkerRecovery }, { getConversationSequenceDiagnostics }] = await Promise.all([
      import('@/backend/services/scheduler'), import('@/backend/execution/flow/FlowExecutor'),
      import('@/backend/services/mcp/lifecycleCoordinator'), import('@/backend/services/scheduler/workerLocalRecovery'),
      import('@/backend/execution/flow/conversationLog'),
    ]);
    const scheduler = getSchedulerService();
    const budget = process.env.FLUJO_OPERATIONS_RSS_BUDGET_BYTES;
    const snapshot = await collectOperationsSnapshot({
      observationProcessId: getObservationProcessId(),
      workspace, compatibility: getWorkerCompatibility(), worker: getWorkerBootstrapStatus(),
      actor: admission.worker ? { kind: 'worker-control' } : admission.local ? { kind: 'local' } : { kind: 'owner',
        ownerId: admission.authorization.principal.ownerId, credentialId: admission.authorization.principal.credentialId },
      read: boundedJsonReader(getWorkspaceDataDir()), scheduler: plans => scheduler.inspectOperations(plans),
      workerRecovery: inspectWorkerRecovery, active: FlowExecutor.conversationStates.values(), mcp: listRuntimes(),
      memory: process.memoryUsage(), ...(budget === undefined ? {} : { rssBudgetBytes: Number(budget) }),
    });
    const desiredState = await readDesiredState();
    const relocked = await assertUnlocked();
    if (relocked) return relocked;
    if (isWorkerMode() !== admission.worker || getCurrentWorkspace() !== workspace) return Response.json({ error: 'Operations profile changed.' },
      { status: 409, headers: { 'Cache-Control': 'no-store' } });
    const revoked = recheckAdmission(request, admission);
    if (revoked) return revoked;
    const unavailable = assertWorkerRequestReady(request, workspace);
    if (unavailable) return unavailable;
    return Response.json({ ...snapshot, desiredState, flowRunAdmission: getFlowRunAdmissionDiagnostics(),
      subflowPreparation: getSubflowPreparationDiagnostics(), subflowOutput: getSubflowOutputDiagnostics(),
      conversationSequences: getConversationSequenceDiagnostics(), allocationReservations: getAllocationReservationSnapshot(),
      conversationPublication: getConversationPublicationDiagnostics(), chatIngress: getChatIngressDiagnostics(),
      chatRateLimit: getChatRateDiagnostics() }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    // No prompt, provider message, command, credential or private filesystem error.
    return Response.json({ error: 'Operations observations are unavailable.', code: 'OPERATIONS_UNAVAILABLE' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
};

const wrapped = withWorkspaceRoute(GET_handler);

/** Authentication precedes workspace/storage selection, including direct handler imports. */
export function GET(request: Request) {
  const admitted = admitOperationsRequest(request);
  return 'response' in admitted ? admitted.response : wrapped(request, admitted.admission);
}
