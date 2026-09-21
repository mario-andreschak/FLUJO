import { createLogger } from '@/utils/logger';
import type { EmitFn, NodeRef } from '@/shared/types/execution/events';
import type { SubflowTaskRecord } from '@/shared/types/subflowTasks';
import {
  createTask,
  getSubflowTaskSettings,
  getTask,
  listTasks,
  patchTask,
  requestCancel,
  toTaskHandle,
} from '@/backend/services/subflowTasks';
import { flowService } from '@/backend/services/flow';
import { buildConversationTitle } from '@/utils/shared/conversationTitle';
import {
  classifyStatisticsError,
  createStatisticsEvent,
  recordStatisticsEvent,
} from '@/backend/services/statistics';
import {
  newStatisticsInvocationId,
  startStatisticsTimer,
} from '@/backend/services/statistics/metadata';
import type { StatisticsSubflowOutcome } from '@/shared/types/statistics';
import type { SubflowLanePlan, SubflowNodePrepResult, SubflowNodeProperties, ToolDefinition } from '../types';
import { bindToCurrentWorkspace, DEFAULT_WORKSPACE, getCurrentWorkspace, workspaceCacheKey } from '@/utils/workspace';
import { runInWriteChain } from '@/utils/storage/backend';
import { assertFlowExecutionCurrent, commitFlowDurableMutation, rethrowFlowExecutionAuthorityError } from '../executionAuthority';
import { isCancelledByAncestry } from '../cancellation';
import { publishSubflowCompletion } from '../subflowCommunication';

const log = createLogger('backend/flow/execution/handlers/subflowDetachedInvocation');
export const SUBFLOW_DETACHED_TOOL_PREFIX = 'start_subflow_';

export interface DetachedJobEntry { controller: AbortController; promise: Promise<void>; }
const runtime = globalThis as typeof globalThis & { __flujoDetachedJobs?: Map<string, DetachedJobEntry> };
export const detachedJobRegistry = runtime.__flujoDetachedJobs ??= new Map<string, DetachedJobEntry>();
const TASK_TIMEOUT = 'subflow-task-runtime-timeout';

function detachedJobKey(taskId: string): string {
  return getCurrentWorkspace() === DEFAULT_WORKSPACE ? taskId : workspaceCacheKey(taskId);
}

export function buildDetachedSubflowTool(
  name: string,
  target: { id: string; label: string },
  description: string,
  taskMandatory: boolean,
): ToolDefinition {
  return {
    name,
    description: `${description}\n\nDETACHED SUBFLOW: starts "${target.label}" in the background and returns a durable task handle immediately. Keep working while it runs. Use subflow_send_message for steering/replies and subflow_wait to wait for updates. subflow_task_get reads its result; subflow_task_cancel stops it.`,
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'string', description: taskMandatory ? 'Required task for the detached subflow.' : 'Optional task; defaults to the subflow configuration.' } },
      required: taskMandatory ? ['task'] : [],
    },
  };
}

/**
 * Parent-side telemetry context for a DETACHED subflow call.
 *
 * The parent run id and the durable child conversation id are captured at spawn
 * time, so the call can still be correlated after the parent run has ended and
 * without relying on in-memory state.
 */
interface DetachedSubflowTelemetry {
  parentRunId?: string;
  invocationId: string;
  subflow: { id: string; name?: string };
  node?: { id: string; name?: string };
  childRunId?: string;
}

async function runDetachedJob(
  task: SubflowTaskRecord,
  prep: SubflowNodePrepResult,
  nodeRef: NodeRef,
  input: { prompt: string },
  controller: AbortController,
  maxRuntimeMs: number,
  telemetry?: DetachedSubflowTelemetry,
): Promise<void> {
  const timer = startStatisticsTimer();
  let recorded = false;
  // Detached calls never make the parent wait, so there is no wait phase; the
  // duration is the child's own execution time observed by the launcher.
  const record = (outcome: StatisticsSubflowOutcome, error?: unknown): void => {
    if (!telemetry?.parentRunId || recorded) return;
    recorded = true;
    try {
      const durationMs = timer.elapsedMs();
      recordStatisticsEvent(createStatisticsEvent({
        type: 'subflow.invocation',
        runId: telemetry.parentRunId,
        node: telemetry.node,
        subflow: telemetry.subflow,
        mode: 'detached',
        invocationId: telemetry.invocationId,
        childRunId: telemetry.childRunId,
        outcome,
        durationMs,
        waitMs: 0,
        phases: { subflowExecution: durationMs },
        errorClass: outcome === 'error' ? classifyStatisticsError(error) : undefined,
      }));
    } catch {
      // Metadata instrumentation never changes detached subflow behaviour.
    }
  };
  const timeout = Number.isFinite(maxRuntimeMs) && maxRuntimeMs > 0
    ? setTimeout(() => controller.abort(TASK_TIMEOUT), maxRuntimeMs)
    : undefined;
  timeout?.unref?.();
  const terminal = async (patch: Parameters<typeof patchTask>[1]): Promise<void> => {
    const updated = await patchTask(task.taskId, patch, { ifStatus: 'working' });
    if (updated && ['completed', 'failed', 'cancelled'].includes(updated.status)) {
      try { await publishSubflowCompletion(updated); }
      catch (error) { log.warn('Could not notify the parent of a completed subflow task', { taskId: task.taskId, error }); }
    }
  };
  const cancelled = async (): Promise<boolean> => {
    const { FlowExecutor } = await import('../FlowExecutor');
    return controller.signal.aborted || Boolean(prep.executionAuthority?.signal.aborted)
      || isCancelledByAncestry(task.originConversationId, FlowExecutor.conversationStates);
  };
  const finishCancellation = async (): Promise<void> => {
    const timedOut = controller.signal.reason === TASK_TIMEOUT;
    record(timedOut ? 'error' : 'cancelled', timedOut ? new Error('Detached subflow timed out.') : undefined);
    await terminal(timedOut
      ? { status: 'failed', failureReason: 'timeout', error: 'Detached subflow exceeded its maximum runtime.' }
      : { status: 'cancelled', failureReason: 'cancelled', cancelRequestedAt: Date.now() });
  };
  try {
    const { runFlow } = await import('../runFlow');
    const { runSubflowLanes } = await import('../nodes/SubflowNode');
    const result = await runSubflowLanes(prep, runFlow, nodeRef, input);
    const current = await getTask(task.taskId);
    if (await cancelled() || current?.status === 'cancelled') {
      await finishCancellation();
      return;
    }
    record(result.success ? 'completed' : 'error', result.error);
    await terminal(result.success
      ? { status: 'completed', outputText: result.outputText }
      : { status: 'failed', error: result.error ?? 'Detached subflow failed.', failureReason: 'child-error' });
  } catch (error) {
    if (await cancelled()) {
      await finishCancellation();
    } else {
      record('error', error);
      await terminal({
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        failureReason: 'child-error',
      });
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    // A job that ends without any terminal record (process death, unexpected
    // early return) is reported as incomplete instead of a success or failure.
    record('incomplete');
    detachedJobRegistry.delete(detachedJobKey(task.taskId));
  }
}

export async function executeDetachedSubflowStart(
  name: string, args: Record<string, unknown>, ctx: { conversationId?: string; emit?: EmitFn },
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  // Parallel tool calls must share admission, or each can observe the same
  // spare slot and exceed the workspace's worker limit.
  return runInWriteChain(workspaceCacheKey('subflow-task-admission'), () => startDetachedSubflow(name, args, ctx));
}

async function startDetachedSubflow(
  name: string,
  args: Record<string, unknown>,
  ctx: { conversationId?: string; emit?: EmitFn },
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const originConversationId = ctx.conversationId;
  if (!originConversationId) return { success: false, error: 'No active conversation to start a detached subflow.' };
  try {
    const { FlowExecutor } = await import('../FlowExecutor');
    const shared = FlowExecutor.conversationStates.get(originConversationId);
    const targetNodeId = shared?.subflowDetachedToolNameMap?.[name];
    if (!shared || !targetNodeId) return { success: false, error: `Unknown detached subflow tool "${name}".` };
    await assertFlowExecutionCurrent(shared);
    if (shared.isCancelled || shared.executionAuthority?.signal.aborted) {
      return { success: false, error: 'The launching conversation was cancelled.' };
    }

    const [settings, active] = await Promise.all([getSubflowTaskSettings(), listTasks({ status: 'working', limit: 500 })]);
    if (active.length >= settings.maxConcurrentDetachedJobs) {
      return { success: false, error: `Detached job limit reached (${settings.maxConcurrentDetachedJobs}).` };
    }

    const flow = shared.flowSnapshot
      ?? await flowService.getFlow(shared.flowId);
    const node = flow?.nodes.find(item => item.id === targetNodeId);
    const props = node?.data?.properties as SubflowNodeProperties | undefined;
    if (!props?.subflowId) return { success: false, error: 'Target subflow node has no configured subflowId.' };
    const rawTask = typeof args.task === 'string' ? args.task.trim() : '';
    const prompt = rawTask || props.promptTemplate || '';
    const task = await commitFlowDurableMutation(shared, () => createTask({
      status: 'working',
      pollInterval: props.detachedPollIntervalMs,
      // SharedState.conversationId is optional; the launching conversation id is
      // the durable owner of the task, so fall back to it rather than widening
      // the record type to `string | undefined`.
      originConversationId: shared.conversationId ?? originConversationId,
      originNodeId: targetNodeId,
      originLogicalRunId: shared.logicalRunId,
      flowId: props.subflowId!,
      childConversationId: crypto.randomUUID(),
      input: { prompt },
    }));
    if (!task) return { success: false, error: 'Unable to persist detached subflow task.' };

    shared.launchedTaskIds = [...new Set([...(shared.launchedTaskIds ?? []), task.taskId])];
    shared.subflowOrchestratorNodeId = shared.currentNodeId;
    const controller = new AbortController();
    const lane: SubflowLanePlan = { subflowId: props.subflowId, conversationId: task.childConversationId, input: { prompt }, laneTitle: buildConversationTitle(prompt || 'Detached subflow') };
    const prep: SubflowNodePrepResult = {
      nodeId: targetNodeId, nodeType: 'subflow', subflowId: props.subflowId,
      nodeName: node?.data?.label, depth: (shared.runDepth ?? 0) + 1,
      chainDepth: shared.chainDepth, plannedExecutionId: shared.plannedExecutionId,
      parentRunId: task.originConversationId,
      personaAttribution: shared.personaAttribution,
      executionAuthority: shared.executionAuthority,
      abortSignal: controller.signal,
      persistConversation: true, showSteps: true, emit: ctx.emit, lanes: [lane],
      concurrencyLimit: 1, joinSeparator: '\n\n', errorStrategy: 'collect-all',
    };
    let subflowName: string | undefined;
    try {
      subflowName = (await flowService.getFlow(props.subflowId))?.name;
    } catch {
      // Display names are best-effort; the stable subflow id is authoritative.
    }
    // Bind the fire-and-forget job explicitly: it outlives the request that
    // launched it and every storage/cache operation must retain that workspace.
    const launchDetachedJob = bindToCurrentWorkspace(runDetachedJob);
    const job = launchDetachedJob(
      task,
      prep,
      { nodeId: targetNodeId, nodeName: node?.data?.label, nodeType: 'subflow' },
      { prompt },
      controller,
      settings.maxJobRuntimeMs,
      {
        parentRunId: shared.logicalRunId,
        invocationId: newStatisticsInvocationId(),
        subflow: { id: props.subflowId, ...(subflowName ? { name: subflowName } : {}) },
        node: {
          id: targetNodeId,
          ...(node?.data?.label ? { name: node.data.label } : {}),
        },
        childRunId: task.childConversationId,
      },
    );
    detachedJobRegistry.set(detachedJobKey(task.taskId), { controller, promise: job });
    void job;
    return { success: true, data: { ...toTaskHandle(task), childConversationId: task.childConversationId, parentConversationId: task.originConversationId } };
  } catch (error) {
    rethrowFlowExecutionAuthorityError(error);
    log.warn('Failed to start detached subflow', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function canAccessTask(task: SubflowTaskRecord, ctx: { conversationId?: string }, allowChild: boolean): Promise<boolean> {
  if (!ctx.conversationId) return false;
  const { FlowExecutor } = await import('../FlowExecutor');
  const caller = FlowExecutor.conversationStates.get(ctx.conversationId);
  if (!caller) return false;
  await assertFlowExecutionCurrent(caller);
  if (caller.isCancelled || caller.executionAuthority?.signal.aborted) return false;
  if (allowChild && task.childConversationId === ctx.conversationId) return true;
  return task.originConversationId === ctx.conversationId
    && (!task.originLogicalRunId || task.originLogicalRunId === caller.logicalRunId);
}

export async function executeTaskGet(taskId: string, ctx: { conversationId?: string } = {}) {
  const task = await getTask(taskId);
  return task && await canAccessTask(task, ctx, true) ? { success: true, data: { task: toTaskHandle(task), childConversationId: task.childConversationId, parentConversationId: task.originConversationId, ...(task.status === 'completed' ? { result: task.outputText } : {}), ...(task.error ? { error: task.error } : {}) } } : { success: false, error: 'Task not found.' };
}

/** Trusted local-user API; model callers must use the relationship-checked wrapper. */
export async function cancelDetachedTask(taskId: string): Promise<SubflowTaskRecord | null> {
  const task = await requestCancel(taskId);
  if (task?.status === 'cancelled') detachedJobRegistry.get(detachedJobKey(taskId))?.controller.abort();
  return task;
}

export async function executeTaskCancel(taskId: string, ctx: { conversationId?: string } = {}) {
  const current = await getTask(taskId);
  if (!current || !await canAccessTask(current, ctx, false)) return { success: false, error: 'Task not found.' };
  const task = await cancelDetachedTask(taskId);
  return task ? { success: true, data: toTaskHandle(task) } : { success: false, error: 'Task not found.' };
}
