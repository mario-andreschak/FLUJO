import { withWorkspaceRoute } from '@/app/api/_workspace';
import {
  admitOperationsRequest, operationsWorkspaceRefusal, recheckOperationsAdmission, type OperationsAdmission,
} from '@/app/api/operations/_admission';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { getCurrentWorkspace, getWorkspaceDataDir } from '@/utils/workspace';
import { assertWorkerRequestReady } from '@/backend/services/workspace/workerMode';
import { runSelftest, type SelftestServer } from '@/backend/services/operations/selftest';
import { writeFileAtomic } from '@/utils/storage/backend';

export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };

const GET_handler = async (request: Request, admission: OperationsAdmission) => {
  const refused = operationsWorkspaceRefusal(admission);
  if (refused) return refused;
  const locked = await assertUnlocked();
  if (locked) return locked;
  try {
    const [{ flowService }, { modelService }, { loadServerConfigs }, { listRuntimes }, { getSchedulerService }] = await Promise.all([
      import('@/backend/services/flow'), import('@/backend/services/model'), import('@/backend/services/mcp/config'),
      import('@/backend/services/mcp/lifecycleCoordinator'), import('@/backend/services/scheduler'),
    ]);
    const report = await runSelftest({
      workspace: getCurrentWorkspace(),
      dataDirectory: getWorkspaceDataDir(),
      writeFileAtomic: (file, data) => writeFileAtomic(file, data),
      loadFlows: () => flowService.loadFlows(),
      loadModels: () => modelService.loadModels(),
      loadServers: async () => {
        const configs = await loadServerConfigs();
        if (!Array.isArray(configs)) throw new Error('MCP configuration is unavailable');
        return configs as unknown as SelftestServer[];
      },
      runtimeStates: () => new Map(listRuntimes().map(record => [record.serverName, record.state])),
      scheduler: async () => {
        const scheduler = getSchedulerService();
        const plans = await scheduler.list();
        const inspected = scheduler.inspectOperations(plans);
        return {
          enabled: plans.filter(plan => plan.enabled).length,
          armed: inspected.armedTriggers,
          paused: inspected.pausedAtLastReconcile === true,
          started: inspected.started,
        };
      },
      network: new URL(request.url).searchParams.get('network') !== '0',
    });
    const revoked = recheckOperationsAdmission(request, admission);
    if (revoked) return revoked;
    const unavailable = assertWorkerRequestReady(request, getCurrentWorkspace());
    if (unavailable) return unavailable;
    return Response.json(report, { headers: NO_STORE });
  } catch {
    // No prompt, provider message, command, credential or private filesystem error.
    return Response.json({ error: 'Self-test is unavailable.', code: 'SELFTEST_UNAVAILABLE' }, { status: 503, headers: NO_STORE });
  }
};

const wrapped = withWorkspaceRoute(GET_handler);

/** Authentication precedes workspace and storage selection. */
export function GET(request: Request) {
  const admitted = admitOperationsRequest(request);
  if ('response' in admitted) return admitted.response;
  return wrapped(request, admitted.admission);
}
