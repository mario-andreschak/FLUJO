import type { PlannedExecution, PlannedExecutionStatus } from '@/shared/types/plannedExecution';
import type { WorkerRecoveryStatus } from '@/shared/types/plannedExecution/workerRecovery';
import type { WorkerBootstrapStatus } from '@/backend/services/workspace/workerMode';
import type { WorkerCompatibility } from '@/backend/services/workspace/workerCompatibility';
import type { McpRuntimeRecord } from '@/backend/services/mcp/lifecycleCoordinator';
import { ObservationReadError } from './boundedRead';

const MAX_ROWS = 200;
const safeId = (value: unknown): string | undefined => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const statuses = new Set(['completed', 'error', 'skipped', 'needs_approval', 'running', 'queued']);

export function errorHint(error: unknown): 'timeout' | 'rate-limit' | 'bad-request' | 'authentication' | 'other' | undefined {
  if (typeof error !== 'string' || !error) return undefined;
  const bounded = error.slice(0, 4096);
  if (/timeout|timed out|ETIMEDOUT/i.test(bounded)) return 'timeout';
  if (/\b429\b|rate.?limit/i.test(bounded)) return 'rate-limit';
  if (/\b400\b|bad request/i.test(bounded)) return 'bad-request';
  if (/\b40[13]\b|unauthorized|authentication/i.test(bounded)) return 'authentication';
  return 'other';
}

interface SchedulerObservation {
  started: boolean;
  pausedAtLastReconcile: boolean;
  armedTriggers: number;
  runningRuns: number;
  overlapQueued: number;
  maxOverlapDepth: number;
  exclusiveWaiting: number;
  blockedByExclusive: number;
  queueCap: number;
  ownedWorkerRunIds: ReadonlySet<string>;
  statuses: Array<{ id: string; status: PlannedExecutionStatus }>;
}
interface ActiveObservation { conversationId?: string; flowId?: string; plannedExecutionId?: string; status?: string }
export interface OperationsSources {
  workspace: string;
  compatibility: WorkerCompatibility;
  worker: WorkerBootstrapStatus;
  actor: { kind: 'owner'; ownerId: string; credentialId: string } | { kind: 'worker-control' };
  read: (relative: string) => Promise<unknown | undefined>;
  scheduler: (executions: readonly PlannedExecution[]) => SchedulerObservation;
  workerRecovery: (execution: PlannedExecution, paused: boolean, owned: ReadonlySet<string>) => Promise<WorkerRecoveryStatus | undefined>;
  active: Iterable<ActiveObservation>;
  mcp: Iterable<McpRuntimeRecord>;
  memory: { rss: number; heapUsed: number; heapTotal: number };
  rssBudgetBytes?: number;
}

/** Sample only. Indexed history is not terminal authority; cache absence is not process/remote cleanup. */
export async function collectOperationsSnapshot(source: OperationsSources) {
  const collectedAt = new Date().toISOString();
  const probes: Array<{ component: string; state: 'observed' | 'absent' | 'unavailable'; reason?: string }> = [];
  const alerts: Array<{ code: string; severity: 'info' | 'warning'; resourceId?: string }> = [];
  let truncated = false;
  const read = async (component: string, relative: string) => {
    try {
      const result = await source.read(relative);
      probes.push({ component, state: result === undefined ? 'absent' : 'observed' });
      return result;
    } catch (error) {
      probes.push({ component, state: 'unavailable', reason: error instanceof ObservationReadError ? error.code : 'unavailable' });
      return undefined;
    }
  };
  const storedPlans = await read('planned-executions', 'db/planned_executions.json');
  const file = object(storedPlans);
  const rawPlans = file?.executions;
  const validPlans = Array.isArray(rawPlans) ? rawPlans.filter(value => {
    const plan = object(value);
    return plan && safeId(plan.id) && typeof plan.enabled === 'boolean' && typeof object(plan.trigger)?.type === 'string';
  }) as PlannedExecution[] : [];
  if (storedPlans !== undefined && (!file || file.version !== 1 || typeof file.paused !== 'boolean' || !Array.isArray(rawPlans)
      || validPlans.length !== rawPlans.length)) {
    probes.push({ component: 'planned-execution-schema', state: 'unavailable', reason: 'invalid-schema' });
  }
  truncated ||= validPlans.length > MAX_ROWS;
  const plans = validPlans.slice(0, MAX_ROWS);
  const live = source.scheduler(plans);
  const liveById = new Map(live.statuses.map(entry => [entry.id, entry.status]));
  const schedules = [];
  for (const execution of plans) {
    const cached = liveById.get(execution.id);
    const recovery = await source.workerRecovery(execution, file?.paused === true, live.ownedWorkerRunIds);
    const history = await read('run-history', `db/planned-execution-runs/${execution.id}.json`);
    const last = Array.isArray(history) ? object(history[history.length - 1]) : undefined;
    if (history !== undefined && !Array.isArray(history)) probes.push({ component: 'run-history-schema', state: 'unavailable', reason: 'invalid-schema' });
    const armed = cached?.armed === true && (!recovery || recovery.eligible);
    if (execution.enabled && !armed && file?.paused !== true) alerts.push({ code: 'enabled-plan-unarmed', severity: 'warning', resourceId: execution.id });
    if (recovery?.pending && recovery.reason === 'unresolved-admission') alerts.push({ code: 'unresolved-worker-admission', severity: 'warning', resourceId: execution.id });
    const hint = errorHint(cached?.lastTriggerError) ?? errorHint(last?.error);
    if (hint) alerts.push({ code: `run-error-hint:${hint}`, severity: 'warning', resourceId: execution.id });
    schedules.push({ id: execution.id, generationId: safeId(execution.generationId), enabled: execution.enabled,
      armed, runningInThisProcess: cached?.running === true, errorHint: hint,
      ...(recovery ? { recovery: { state: recovery.state, reason: recovery.reason, eligible: recovery.eligible,
        ...(recovery.pending ? { pendingRunId: safeId(recovery.pending.runId) } : {}) } } : {}),
      ...(last ? { indexedLastRun: { runId: safeId(last.runId), generationId: safeId(last.executionGenerationId),
        status: typeof last.status === 'string' && statuses.has(last.status) ? last.status : 'unknown' } } : {}),
    });
  }
  const storedApprovals = await read('pending-approval-index', 'db/pending_approvals.json');
  const approvalFile = object(storedApprovals);
  if (storedApprovals !== undefined && !approvalFile) probes.push({ component: 'approval-index-schema', state: 'unavailable', reason: 'invalid-schema' });
  const approvalEntries = approvalFile ? Object.values(approvalFile) : [];
  truncated ||= approvalEntries.length > MAX_ROWS;
  const indexedApprovals = approvalEntries.slice(0, MAX_ROWS).map(value => {
    const entry = object(value);
    return { approvalId: safeId(entry?.approvalId), conversationId: safeId(entry?.conversationId),
      executionId: safeId(entry?.plannedExecutionId), runId: safeId(entry?.runId) };
  });
  if (indexedApprovals.some(entry => !entry.approvalId || !entry.conversationId || !entry.runId)) {
    probes.push({ component: 'approval-index-schema', state: 'unavailable', reason: 'invalid-schema' });
  }
  if (indexedApprovals.length) alerts.push({ code: 'approval-index-needs-census', severity: 'info' });
  const activeRuns = [];
  for (const state of source.active) {
    if (!['running', 'awaiting_tool_approval', 'paused_debug'].includes(state.status ?? '')) continue;
    if (activeRuns.length === MAX_ROWS) { truncated = true; break; }
    activeRuns.push({ conversationId: safeId(state.conversationId), flowId: safeId(state.flowId),
      executionId: safeId(state.plannedExecutionId), status: state.status });
  }
  const processes = [];
  for (const runtime of source.mcp) {
    if (processes.length === MAX_ROWS) { truncated = true; break; }
    const receipt = runtime.shutdownReceipt;
    const matching = receipt?.runtimeId === runtime.runtimeId && receipt.generation === runtime.generation
      && receipt.workspace === source.workspace && receipt.serverName === runtime.serverName;
    if ((runtime.state === 'cold' || runtime.state === 'stopping') && runtime.generation > 0
        && (!matching || receipt?.exitOutcome === 'unknown')) alerts.push({ code: 'shutdown-exit-unobserved', severity: 'warning' });
    processes.push({ runtimeId: safeId(runtime.runtimeId), generation: count(runtime.generation), state: runtime.state,
      leases: count(runtime.leases), pins: runtime.pins.size,
      ...(matching && receipt ? { shutdown: { processOwnership: receipt.processOwnership,
        exitOutcome: receipt.exitOutcome, forced: receipt.forced, errorClassification: receipt.errorClassification,
        generation: receipt.generation, runtimeId: safeId(receipt.runtimeId) } } : { shutdown: { exitOutcome: 'unknown' as const } }),
    });
  }
  const queue = { overlap: count(live.overlapQueued), exclusiveWaiting: count(live.exclusiveWaiting),
    maxOverlapDepth: count(live.maxOverlapDepth), blockedByExclusive: count(live.blockedByExclusive), capPerQueue: count(live.queueCap) };
  if (queue.capPerQueue > 0 && (queue.exclusiveWaiting >= queue.capPerQueue || queue.blockedByExclusive >= queue.capPerQueue || queue.maxOverlapDepth >= queue.capPerQueue)) {
    alerts.push({ code: 'queue-pressure', severity: 'warning' });
  }
  const rssBudget = source.rssBudgetBytes && Number.isSafeInteger(source.rssBudgetBytes) && source.rssBudgetBytes > 0 ? source.rssBudgetBytes : undefined;
  if (source.rssBudgetBytes !== undefined && !rssBudget) probes.push({ component: 'rss-observation-budget', state: 'unavailable', reason: 'invalid-config' });
  if (rssBudget && source.memory.rss >= rssBudget) alerts.push({ code: 'rss-budget-reached', severity: 'warning' });
  if (!live.started) alerts.push({ code: 'scheduler-not-started', severity: 'info' });
  if (truncated) alerts.push({ code: 'diagnostic-row-budget-reached', severity: 'warning' });
  if (probes.some(probe => probe.state === 'unavailable')) alerts.push({ code: 'diagnostic-source-unavailable', severity: 'warning' });
  return { schemaVersion: 1 as const, collectedAt, workspace: source.workspace, identity: source.compatibility, actor: source.actor,
    observation: 'non-atomic-diagnostic-sample' as const, complete: !truncated && probes.every(probe => probe.state !== 'unavailable'),
    scope: { schedulerAndActiveRuns: 'this-process-and-workspace', approvalAndHistory: 'unverified-durable-index', processExit: 'matching-runtime-generation-receipt' },
    probes, truncated, rowLimit: MAX_ROWS, worker: { mode: source.worker.mode, state: source.worker.state },
    scheduler: { started: live.started, pausedAtLastReconcile: live.pausedAtLastReconcile,
      pausedInStoredConfig: typeof file?.paused === 'boolean' ? file.paused : null,
      armedTriggers: count(live.armedTriggers), runningRuns: count(live.runningRuns), queue },
    schedules, indexedApprovals, activeRuns, processes,
    memory: { rssBytes: count(source.memory.rss), heapUsedBytes: count(source.memory.heapUsed), heapTotalBytes: count(source.memory.heapTotal),
      ...(rssBudget ? { configuredRssBudgetBytes: rssBudget } : {}) }, alerts,
  };
}
