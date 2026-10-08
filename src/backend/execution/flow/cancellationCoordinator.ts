import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { clearPendingApprovals } from '@/backend/execution/flow/toolApprovalRegistry';
import { cancelAllToolCalls } from '@/backend/execution/flow/toolCancelRegistry';
import { workspaceCacheKey } from '@/utils/workspace';

const ACTIVE_FLOW_STATUSES = new Set([
  'running',
  'awaiting_tool_approval',
  'paused_debug',
]);

interface CancellableRun {
  identity: string;
  runId?: string;
  conversationId?: string;
  controller: AbortController;
}

interface AdmissionBarrier {
  holderRunId: string;
  token: number;
  waiters: Set<() => void>;
}

const globalCoordinator = globalThis as unknown as {
  __flujoCancellableRuns?: Map<string, Map<string, CancellableRun>>;
  __flujoAdmissionBarriers?: Map<string, AdmissionBarrier>;
  __flujoAdmissionBarrierToken?: number;
};

const runRegistries = globalCoordinator.__flujoCancellableRuns
  ?? (globalCoordinator.__flujoCancellableRuns = new Map());
const barriers = globalCoordinator.__flujoAdmissionBarriers
  ?? (globalCoordinator.__flujoAdmissionBarriers = new Map());

function runsKey(): string {
  return workspaceCacheKey('cancellable-runs');
}

function barrierKey(): string {
  return workspaceCacheKey('run-admission-barrier');
}

function currentRuns(): Map<string, CancellableRun> {
  const key = runsKey();
  let runs = runRegistries.get(key);
  if (!runs) {
    runs = new Map();
    runRegistries.set(key, runs);
  }
  return runs;
}

export interface CancellableRunRegistration {
  signal: AbortSignal;
  release: () => void;
}

/**
 * Register every runFlow invocation so workspace EMERGENCY cancellation can
 * actively abort provider/tool work instead of only preventing the next loop.
 */
export async function registerCancellableRun(input: {
  runId?: string;
  conversationId?: string;
  signal?: AbortSignal;
}): Promise<CancellableRunRegistration> {
  // Admission and registration must be one atomic event-loop step. Keeping the
  // barrier check inside this loop closes the gap where an EMERGENCY barrier
  // could appear after a caller finished waiting but before its controller was
  // visible to the cancellation sweep.
  while (true) {
    if (input.signal?.aborted) {
      throw input.signal.reason ?? new Error('Run cancelled while waiting for admission.');
    }
    const barrier = barriers.get(barrierKey());
    if (!barrier || (input.runId && barrier.holderRunId === input.runId)) {
      const key = runsKey();
      let runs = runRegistries.get(key);
      if (!runs) {
        runs = new Map();
        runRegistries.set(key, runs);
      }
      const identity = [
        input.runId ?? input.conversationId ?? 'anonymous',
        Date.now(),
        Math.random(),
      ].join(':');
      const controller = new AbortController();
      runs.set(identity, {
        identity,
        runId: input.runId,
        conversationId: input.conversationId,
        controller,
      });
      return {
        signal: controller.signal,
        release: () => {
          const active = runRegistries.get(key);
          active?.delete(identity);
          if (active?.size === 0) runRegistries.delete(key);
        },
      };
    }
    await waitForWorkspaceRunAdmission(input.runId, input.signal);
  }
}

/**
 * Wait until no Super-Exclusive/EMERGENCY run owns the workspace admission
 * barrier. The holder itself passes by presenting the same logical run id.
 */
export async function waitForWorkspaceRunAdmission(
  runId?: string,
  signal?: AbortSignal,
): Promise<void> {
  while (true) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error('Run cancelled while waiting for admission.');
    }
    const barrier = barriers.get(barrierKey());
    if (!barrier || (runId && barrier.holderRunId === runId)) return;

    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener('abort', abort);
        resolve();
      };
      const abort = () => {
        barrier.waiters.delete(wake);
        reject(signal?.reason ?? new Error('Run cancelled while waiting for admission.'));
      };
      barrier.waiters.add(wake);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
}

/**
 * Wait for the current holder and reserve the next barrier in one event-loop
 * step. Callers that need ownership must use this instead of separately
 * waiting and acquiring, which would let two contenders pass the same gap.
 */
export async function acquireWorkspaceRunBarrierWhenAvailable(
  holderRunId: string,
  signal?: AbortSignal,
): Promise<() => void> {
  while (true) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error('Run cancelled while waiting for admission.');
    }
    const barrier = barriers.get(barrierKey());
    if (!barrier || barrier.holderRunId === holderRunId) {
      return acquireWorkspaceRunBarrier(holderRunId);
    }
    await waitForWorkspaceRunAdmission(holderRunId, signal);
  }
}

/**
 * Install a workspace admission barrier. EMERGENCY may forcefully replace an
 * existing holder; stale release callbacks are fenced by a monotonic token.
 */
export function acquireWorkspaceRunBarrier(
  holderRunId: string,
  options: { force?: boolean } = {},
): () => void {
  const key = barrierKey();
  const current = barriers.get(key);
  if (current && current.holderRunId !== holderRunId && !options.force) {
    throw new Error('Another workspace run already owns the admission barrier.');
  }
  const token = (globalCoordinator.__flujoAdmissionBarrierToken ?? 0) + 1;
  globalCoordinator.__flujoAdmissionBarrierToken = token;
  barriers.set(key, {
    holderRunId,
    token,
    waiters: current?.waiters ?? new Set(),
  });
  return () => {
    const active = barriers.get(key);
    if (!active || active.token !== token) return;
    barriers.delete(key);
    for (const wake of active.waiters) wake();
    active.waiters.clear();
  };
}

export interface WorkspaceCancellationReport {
  directRunIds: string[];
  conversationIds: string[];
  personaDispatchIds: string[];
  failures: Array<{ kind: 'direct' | 'persona'; id: string; error: string }>;
}

/**
 * Cancel all active conversations visible from the current workspace.
 *
 * Direct Flow controllers and live state are process-local. Persona dispatch
 * cancellation is durable and uses the dispatcher identity, so queued/running
 * Persona work converges on its existing single terminal record.
 */
export async function cancelAllRunningConversations(input: {
  exceptRunId?: string;
  reason: string;
  timeoutMs?: number;
}): Promise<WorkspaceCancellationReport> {
  const report: WorkspaceCancellationReport = {
    directRunIds: [],
    conversationIds: [],
    personaDispatchIds: [],
    failures: [],
  };
  const timeoutMs = input.timeoutMs ?? 10_000;
  const runs = Array.from(currentRuns().values());

  for (const run of runs) {
    if (run.runId && run.runId === input.exceptRunId) continue;
    try {
      run.controller.abort(new Error(input.reason));
      if (run.runId) report.directRunIds.push(run.runId);
      if (run.conversationId) report.conversationIds.push(run.conversationId);
    } catch (error) {
      report.failures.push({
        kind: 'direct',
        id: run.runId ?? run.conversationId ?? run.identity,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const [conversationId, state] of FlowExecutor.conversationStates) {
    if (!state || !ACTIVE_FLOW_STATUSES.has(state.status ?? '')) continue;
    if (state.logicalRunId && state.logicalRunId === input.exceptRunId) continue;
    state.isCancelled = true;
    const scope = state.conversationId ?? conversationId;
    cancelAllToolCalls(scope);
    if (state.logicalRunId && state.logicalRunId !== scope) {
      cancelAllToolCalls(state.logicalRunId);
    }
    clearPendingApprovals(scope);
    if (!report.conversationIds.includes(scope)) report.conversationIds.push(scope);
  }

  try {
    const {
      cancelPersonaFlowDispatchById,
      listPersonaFlowDispatches,
    } = await import('@/backend/services/enduringAgents/personaDispatcher');
    const dispatches = await listPersonaFlowDispatches();
    const active = dispatches.filter((dispatch) =>
      dispatch.state === 'queued'
      || dispatch.state === 'running'
      || dispatch.state === 'waiting'
    );
    const settlements = await Promise.allSettled(active.map(async (dispatch) => {
      const cancelled = await cancelPersonaFlowDispatchById(
        {
          personaId: dispatch.personaId,
          dispatchId: dispatch.id,
          reason: input.reason,
        },
        { waitForCompletion: true, timeoutMs },
      );
      report.personaDispatchIds.push(cancelled.id);
    }));
    settlements.forEach((settlement, index) => {
      if (settlement.status === 'rejected') {
        report.failures.push({
          kind: 'persona',
          id: active[index]?.id ?? 'unknown',
          error: settlement.reason instanceof Error
            ? settlement.reason.message
            : String(settlement.reason),
        });
      }
    });
  } catch (error) {
    report.failures.push({
      kind: 'persona',
      id: 'workspace',
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const deadline = Date.now() + timeoutMs;
  while (
    Array.from(currentRuns().values()).some((run) => run.runId !== input.exceptRunId)
    && Date.now() < deadline
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return report;
}
