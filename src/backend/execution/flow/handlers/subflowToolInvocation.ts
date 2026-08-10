import { createLogger } from '@/utils/logger';
import {
  ToolDefinition,
  SubflowNodePrepResult,
  SubflowLanePlan,
  SubflowNodeProperties,
} from '../types';
import { EmitFn, NodeRef } from '@/shared/types/execution/events';
import { isSubflowToolName, SUBFLOW_TOOL_PREFIX } from '@/shared/utils/handoffNaming';
import { buildConversationTitle } from '@/utils/shared/conversationTitle';
import { flowService } from '@/backend/services/flow/index';
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

/**
 * Callable-subflow TOOL invocation (issue #385, deferred Part B of #359).
 *
 * When a Subflow node's `invocationMode` property is `'tool'` (and the
 * experimental `subflowToolInvocation` setting is on), ProcessNode advertises
 * it as a distinct `call_subflow_<slug>` tool instead of the usual
 * `handoff_to_<slug>` transition tool (see ProcessNode.generateHandoffTools).
 * Calling it does NOT transition the engine graph: it runs the target
 * Subflow's underlying flow INLINE, right here inside the tool call, through
 * the SAME bounded lane engine a parallel/spawn Subflow uses
 * (`runSubflowLanes()`, extracted from SubflowNode.execJobs), and hands the
 * structured `SubflowLaneResult[]` JSON straight back to the calling model —
 * so the model stays on its current node and keeps working with the answer.
 *
 * Dispatch mirrors the existing `question` / `todo` / `write_resource`
 * synthetic tools: a deterministic ToolDefinition offered per opted-in
 * target, executed by name in BOTH tool loops — ModelHandler.processToolCalls
 * (request/response path) and via `localToolExecutors` (self-orchestrating
 * Claude-subscription / Codex adapters).
 *
 * v1 scope is intentionally narrow: one call runs the target's configured
 * `subflowId` ONCE as a single lane (no fan-out/map-over-list/queueing — those
 * remain handoff-only Subflow features). It is also NON-RESUMABLE: no graph
 * transition means no durable join record is attached, so a mid-call crash
 * (process restart) simply loses the in-flight call; the model/caller must
 * retry. Full checkpointed resumability is deferred to a future phase.
 */

const log = createLogger('backend/flow/execution/handlers/subflowToolInvocation');

export { isSubflowToolName, SUBFLOW_TOOL_PREFIX };

/** A minimal reference to a Subflow node advertised as a `call_subflow_*` tool. */
export interface SubflowToolTargetRef {
  id: string;
  label: string;
}

/**
 * Build the `call_subflow_<slug>` tool definition for one tool-mode Subflow
 * target. Mirrors the `acceptsCallerSpawn` shape of a handoff tool (a `task`
 * parameter), but v1 tool-mode never queues — each call is one immediate,
 * synchronous (from the model's perspective) run.
 */
export function buildSubflowTool(
  toolName: string,
  target: SubflowToolTargetRef,
  description: string,
  taskMandatory: boolean,
): ToolDefinition {
  return {
    name: toolName,
    description:
      `${description}\n\n` +
      'CALLABLE SUBFLOW TOOL (not a handoff): calling this runs the ' +
      `"${target.label}" subflow right now and returns its result as structured JSON ` +
      '(success/output/error per lane) — you stay on the current step and can keep working ' +
      'with the answer. Experimental: this call is NOT resumable; if it is interrupted it must ' +
      'be retried from scratch.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: taskMandatory
            ? 'REQUIRED task/instruction for this subflow call. It has no default input configured.'
            : "Task/instruction for this subflow call. Optional; omitted falls back to the subflow's configured input.",
        },
      },
      required: taskMandatory ? ['task'] : [],
    },
  };
}

export interface SubflowToolCallOutcome {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Best-effort child run correlation. Lane results carry a durable child
 * conversation/run id on some paths and nothing on others; a missing id stays
 * ABSENT rather than being invented.
 */
function childRunIdOf(result: unknown): string | undefined {
  const lanes = (result as { lanes?: unknown })?.lanes;
  if (!Array.isArray(lanes) || lanes.length === 0) return undefined;
  const lane = lanes[0] as Record<string, unknown> | undefined;
  for (const key of ['runId', 'conversationId', 'childConversationId']) {
    const value = lane?.[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Execute one `call_subflow_<slug>` tool call: resolve the tool NAME back to a
 * target Subflow node id via the live SharedState's `subflowToolNameMap`
 * (populated by ProcessNode.generateHandoffTools), load that node's
 * configuration from the CURRENT flow, build a single-lane plan, run it
 * through `runSubflowLanes()`, and return a structured JSON-able result.
 *
 * Depth-guarded the same way a normal Subflow child is: `runFlow` itself
 * refuses to start past `MAX_SUBFLOW_DEPTH`, so a chain of tool-mode calls
 * cannot recurse forever either.
 *
 * Reads the LIVE SharedState via `FlowExecutor.conversationStates` (same
 * pattern as `todoTool.executeTodoTool`) rather than requiring the caller to
 * thread a full SharedState — or a name -> node-id map — through: both
 * dispatch sites (ModelHandler's request/response `processToolCalls` and its
 * `localToolExecutors` map for self-orchestrating adapters) only have the
 * called tool's `name` and a `conversationId` in scope.
 */
export async function executeSubflowToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: {
    conversationId?: string;
    emit?: EmitFn;
  },
): Promise<SubflowToolCallOutcome> {
  const { conversationId, emit } = ctx;
  // Parent-side subflow telemetry. The CHILD run reports its own lifecycle under
  // its own runId, so this record never inflates logical-run counts; it measures
  // the call itself (resolution wait plus inline execution).
  const invocationTimer = startStatisticsTimer();
  let telemetry: {
    parentRunId: string;
    node?: { id: string; name?: string };
    subflow: { id: string; name?: string };
    invocationId: string;
    waitMs: number;
  } | undefined;
  const recordSubflowOutcome = (
    outcome: StatisticsSubflowOutcome,
    details?: { error?: unknown; childRunId?: string },
  ): void => {
    if (!telemetry) return;
    const context = telemetry;
    // Exactly ONE terminal record per logical invocation.
    telemetry = undefined;
    try {
      const executionMs = Math.max(0, invocationTimer.elapsedMs() - context.waitMs);
      recordStatisticsEvent(createStatisticsEvent({
        type: 'subflow.invocation',
        runId: context.parentRunId,
        node: context.node,
        subflow: context.subflow,
        mode: 'inline',
        invocationId: context.invocationId,
        childRunId: details?.childRunId,
        outcome,
        durationMs: executionMs,
        waitMs: context.waitMs,
        phases: { subflowWait: context.waitMs, subflowExecution: executionMs },
        errorClass: outcome === 'error' ? classifyStatisticsError(details?.error) : undefined,
      }));
    } catch {
      // Metadata instrumentation never changes a subflow call's behaviour.
    }
  };

  try {
    if (!conversationId) {
      return { success: false, error: 'No active conversation to run the subflow tool call in.' };
    }
    const { FlowExecutor } = await import('../FlowExecutor');
    const sharedState = FlowExecutor.conversationStates.get(conversationId);
    if (!sharedState) {
      return { success: false, error: 'Live conversation state not found for the subflow tool call.' };
    }
    const targetNodeId = sharedState.subflowToolNameMap?.[name];
    if (!targetNodeId) {
      return { success: false, error: `Unknown call_subflow tool "${name}" — no matching target node.` };
    }
    const flow = await flowService.getFlow(sharedState.flowId);
    const flowNode = flow?.nodes.find((n) => n.id === targetNodeId);
    const props = flowNode?.data?.properties as SubflowNodeProperties | undefined;
    const subflowId = props?.subflowId;
    if (!subflowId) {
      return { success: false, error: 'Target subflow node has no configured subflowId.' };
    }

    let subflowName: string | undefined;
    try {
      subflowName = (await flowService.getFlow(subflowId))?.name;
    } catch (err) {
      log.warn('Could not resolve subflow display name; continuing without it', { err });
    }

    const rawTask = typeof args?.task === 'string' ? args.task.trim() : '';
    const task = rawTask.length > 0 ? rawTask : undefined;
    const isolatedMessage = task ?? props?.promptTemplate;

    const lane: SubflowLanePlan = {
      subflowId,
      subflowName,
      ...(isolatedMessage ? { input: { prompt: isolatedMessage } } : {}),
      laneTitle: buildConversationTitle(isolatedMessage ?? subflowName ?? 'Subflow call'),
    };

    const depth = (sharedState.runDepth ?? 0) + 1;
    const nodeRef: NodeRef = {
      nodeId: targetNodeId,
      nodeName: flowNode?.data?.label,
      nodeType: 'subflow',
    };

    const prepResultLike: SubflowNodePrepResult = {
      nodeId: targetNodeId,
      nodeType: 'subflow',
      subflowId,
      subflowName,
      nodeName: flowNode?.data?.label,
      depth,
      chainDepth: sharedState.chainDepth,
      parentRunId: sharedState.conversationId,
      plannedExecutionId: sharedState.plannedExecutionId,
      personaAttribution: sharedState.personaAttribution,
      executionAuthority: sharedState.executionAuthority,
      // Tool-mode invocations attach no durable invocation record (v1 is
      // non-resumable), so this stays ephemeral regardless of the target
      // node's own `saveConversation` setting.
      persistConversation: false,
      showSteps: true,
      emit,
      lanes: [lane],
      concurrencyLimit: 1,
      joinSeparator: '\n\n',
      errorStrategy: 'collect-all',
    };

    // Lazy import breaks the same static cycle SubflowNode.execCore avoids:
    // .../nodes/SubflowNode -> runFlow -> FlowExecutor -> ... -> nodes.
    const { runFlow } = await import('../runFlow');
    const { runSubflowLanes } = await import('../nodes/SubflowNode');

    if (sharedState.logicalRunId) {
      telemetry = {
        parentRunId: sharedState.logicalRunId,
        node: {
          id: targetNodeId,
          ...(flowNode?.data?.label ? { name: flowNode.data.label } : {}),
        },
        subflow: { id: subflowId, ...(subflowName ? { name: subflowName } : {}) },
        invocationId: newStatisticsInvocationId(),
        // Everything before the child starts is queue/resolution wait.
        waitMs: invocationTimer.elapsedMs(),
      };
    }

    const result = await runSubflowLanes(
      prepResultLike,
      runFlow,
      nodeRef,
      isolatedMessage ? { prompt: isolatedMessage } : { prompt: '' },
    );

    recordSubflowOutcome(
      sharedState.isCancelled
        ? 'cancelled'
        : result.success ? 'completed' : 'error',
      { error: result.error, childRunId: childRunIdOf(result) },
    );

    return {
      success: result.success,
      data: {
        success: result.success,
        outputText: result.outputText,
        error: result.error,
        lanes: result.lanes,
      },
      error: result.success ? undefined : result.error,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordSubflowOutcome('error', { error: err });
    log.warn('call_subflow tool execution failed', { toolName: name, err: message });
    return { success: false, error: message };
  }
}
