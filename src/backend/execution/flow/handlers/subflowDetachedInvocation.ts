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

const log = createLogger('backend/flow/execution/handlers/subflowDetachedInvocation');
export const SUBFLOW_DETACHED_TOOL_PREFIX = 'start_subflow_';

export interface DetachedJobEntry { controller: AbortController; promise: Promise<void>; }
export const detachedJobRegistry = new Map<string, DetachedJobEntry>();

export function buildDetachedSubflowTool(
  name: string,
  target: { id: string; label: string },
  description: string,
  taskMandatory: boolean,
): ToolDefinition {
  return {
    name,
    description: `${description}\n\nDETACHED SUBFLOW: starts "${target.label}" in the background and returns a durable task handle immediately. Use subflow_task_get to poll it or subflow_task_cancel to stop it.`,
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
  try {
    const { runFlow } = await import('../runFlow');
    const { runSubflowLanes } = await import('../nodes/SubflowNode');
    const result = await runSubflowLanes(prep, runFlow, nodeRef, input);
    const current = await getTask(task.taskId);
    if (controller.signal.aborted || current?.status === 'cancelled') {
      record('cancelled');
      return;
    }
    record(result.success ? 'completed' : 'error', result.error);
    await patchTask(task.taskId, result.success
      ? { status: 'completed', outputText: result.outputText }
      : { status: 'failed', error: result.error ?? 'Detached subflow failed.', failureReason: 'child-error' });
  } catch (error) {
    record(controller.signal.aborted ? 'cancelled' : 'error', error);
    if (!controller.signal.aborted) {
      await patchTask(task.taskId, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        failureReason: 'child-error',
      });
    }
  } finally {
    // A job that ends without any terminal record (process death, unexpected
    // early return) is reported as incomplete instead of a success or failure.
    record('incomplete');
    detachedJobRegistry.delete(task.taskId);
  }
}

export async function executeDetachedSubflowStart(
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

    const [settings, active] = await Promise.all([getSubflowTaskSettings(), listTasks({ status: 'working', limit: 500 })]);
    if (active.length >= settings.maxConcurrentDetachedJobs) {
      return { success: false, error: `Detached job limit reached (${settings.maxConcurrentDetachedJobs}).` };
    }

    const flow = await flowService.getFlow(shared.flowId);
    const node = flow?.nodes.find(item => item.id === targetNodeId);
    const props = node?.data?.properties as SubflowNodeProperties | undefined;
    if (!props?.subflowId) return { success: false, error: 'Target subflow node has no configured subflowId.' };
    const rawTask = typeof args.task === 'string' ? args.task.trim() : '';
    const prompt = rawTask || props.promptTemplate || '';
    const task = await createTask({
      status: 'working',
      pollInterval: props.detachedPollIntervalMs,
      // SharedState.conversationId is optional; the launching conversation id is
      // the durable owner of the task, so fall back to it rather than widening
      // the record type to `string | undefined`.
      originConversationId: shared.conversationId ?? originConversationId,
      originNodeId: targetNodeId,
      flowId: props.subflowId,
      childConversationId: crypto.randomUUID(),
      input: { prompt },
    });
    if (!task) return { success: false, error: 'Unable to persist detached subflow task.' };

    shared.launchedTaskIds = [...new Set([...(shared.launchedTaskIds ?? []), task.taskId])];
    const lane: SubflowLanePlan = { subflowId: props.subflowId, input: { prompt }, laneTitle: buildConversationTitle(prompt || 'Detached subflow') };
    const prep: SubflowNodePrepResult = {
      nodeId: targetNodeId, nodeType: 'subflow', subflowId: props.subflowId,
      nodeName: node?.data?.label, depth: (shared.runDepth ?? 0) + 1,
      chainDepth: shared.chainDepth, plannedExecutionId: shared.plannedExecutionId,
      persistConversation: true, showSteps: true, emit: ctx.emit, lanes: [lane],
      concurrencyLimit: 1, joinSeparator: '\n\n', errorStrategy: 'collect-all',
    };
    const controller = new AbortController();
    let subflowName: string | undefined;
    try {
      subflowName = (await flowService.getFlow(props.subflowId))?.name;
    } catch {
      // Display names are best-effort; the stable subflow id is authoritative.
    }
    const job = runDetachedJob(
      task,
      prep,
      { nodeId: targetNodeId, nodeName: node?.data?.label, nodeType: 'subflow' },
      { prompt },
      controller,
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
    detachedJobRegistry.set(task.taskId, { controller, promise: job });
    void job;
    return { success: true, data: toTaskHandle(task) };
  } catch (error) {
    log.warn('Failed to start detached subflow', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function executeTaskGet(taskId: string) {
  const task = await getTask(taskId);
  return task ? { success: true, data: { task: toTaskHandle(task), ...(task.status === 'completed' ? { result: task.outputText } : {}), ...(task.error ? { error: task.error } : {}) } } : { success: false, error: 'Task not found.' };
}

export async function executeTaskCancel(taskId: string) {
  const task = await requestCancel(taskId);
  detachedJobRegistry.get(taskId)?.controller.abort();
  return task ? { success: true, data: toTaskHandle(task) } : { success: false, error: 'Task not found.' };
}
