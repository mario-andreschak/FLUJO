// In-loop executors for FLUJO tools when an agent SDK adapter runs its own tool loop.
import { ModelCallInput } from '../types/modelHandler';
import { mcpService } from '@/backend/services/mcp';
import { isRunResourceToolName, executeRunResourceTool, nativeRunResourceResult, WRITE_RESOURCE_TOOL_NAME, READ_RESOURCE_TOOL_NAME } from './runResourceTools';
import { isQuestionToolName, executeQuestionTool, QUESTION_TOOL_NAME } from './runQuestionTool';
import { isTodoToolName, executeTodoTool, TODO_TOOL_NAME } from './todoTool';
import { executeToolLoadingTool, isToolLoadingToolName, toolLoadingResultValue } from '../toolLoading/toolLoadingExecutors';
import { isMcpSkillToolName, executeMcpSkillTool, LOAD_MCP_SKILL_TOOL_NAME } from './mcpSkillTools';
import { isPersonaToolName, executePersonaTool } from './personaTools';
import {
  executeMeetingTool,
  isLiveMeetingTurnSilent,
  isMeetingToolName,
} from './meetingTools';
import { isMCPResourceToolName, executeMCPResourceTool, LIST_MCP_RESOURCES_TOOL_NAME } from './mcpResourceTools';
import { isSubflowToolName, executeSubflowToolCall } from './subflowToolInvocation';
import { isSubflowCommunicationTool, executeSubflowCommunicationTool } from '../subflowCommunication';
import { isBehaviorToolName, executeBehaviorToolCall } from './behaviorToolInvocation';
import { executeDetachedSubflowStart, executeTaskCancel, executeTaskGet, SUBFLOW_DETACHED_TOOL_PREFIX } from './subflowDetachedInvocation';
import { type FlowDurableMutationContext } from '@/backend/execution/flow/executionAuthority';
import { createLiveToolApproval } from '@/backend/execution/flow/toolApprovalGate';
import type { EmitFn } from '@/shared/types/execution/events';

/** What the in-loop executors need from the model call that offers them. */
export type SelfOrchestratedToolContext = {
  input: ModelCallInput;
  tools: ModelCallInput['tools'];
  conversationId?: string;
  runId?: string;
  nodeId?: string;
  nodeDisplayName?: string;
  toolNameMap: ModelCallInput['toolNameMap'];
  mcpNodes: ModelCallInput['mcpNodes'];
  emit?: EmitFn;
  durableContext: FlowDurableMutationContext;
  modelContextWindow?: number;
  requestToolApproval: ReturnType<typeof createLiveToolApproval>;
};

/**
 * Executors for FLUJO's own tools that self-orchestrating adapters (agent
 * SDKs) run inside their tool loop, keyed by the advertised tool name. Only
 * tools this call actually offers get an executor.
 */
export function buildSelfOrchestratedToolExecutors(context: SelfOrchestratedToolContext): {
  localToolExecutors: Record<string, (args: Record<string, unknown>) => Promise<unknown>> | undefined;
  shouldEndAgenticTurn: (() => boolean) | undefined;
} {
  const {
    input, tools, conversationId, runId, nodeId, nodeDisplayName, toolNameMap, mcpNodes,
    emit, durableContext, modelContextWindow, requestToolApproval,
  } = context;
  // Run-resource tools (issue #161): self-orchestrating adapters (Claude
  // subscription) run their own tool loop and never surface tool calls to
  // FLUJO's loop, so the synthetic `write_resource` tool must be executed
  // in-loop via a localToolExecutor. Built only when the tool is actually
  // present + we have a conversation to scope the write to; the request/
  // response path handles the same tool in processToolCalls instead.
  const runResourceNode = nodeId ? { nodeId, nodeName: nodeDisplayName, nodeType: 'process' as const } : undefined;
  const hasRunResourceTool = conversationId && (tools ?? []).some((t) => t.type === 'function' && isRunResourceToolName(t.function.name));
  const hasMCPResourceTool = conversationId && (tools ?? []).some((t) => t.type === 'function' && isMCPResourceToolName(t.function.name));
  const hasQuestionTool = conversationId && (tools ?? []).some((t) => t.type === 'function' && isQuestionToolName(t.function.name));
  const hasTodoTool = conversationId && (tools ?? []).some((t) => t.type === 'function' && isTodoToolName(t.function.name));
  const hasMcpSkillTool = conversationId && (tools ?? []).some((t) => t.type === 'function' && isMcpSkillToolName(t.function.name));
  const personaToolCallNames = conversationId
    ? (tools ?? [])
        .filter((t) => t.type === 'function' && isPersonaToolName(t.function.name))
        .map((t) => t.function.name)
    : [];
  const hasPersonaTool = personaToolCallNames.length > 0;
  const meetingToolCallNames = conversationId
    ? (tools ?? [])
        .filter((t) => t.type === 'function' && isMeetingToolName(t.function.name))
        .map((t) => t.function.name)
    : [];
  const hasMeetingTool = meetingToolCallNames.length > 0;
  const shouldEndAgenticTurn = conversationId && hasMeetingTool
    ? () => isLiveMeetingTurnSilent(conversationId)
    : undefined;
  // Issue #385: `call_subflow_<slug>` tool names are per-target-node and
  // dynamic (unlike the fixed-name synthetic tools above), so they can't be
  // hard-coded keys in the object literal below — collect every advertised
  // name and attach an executor per name after the literal is built.
  const subflowToolCallNames = conversationId
    ? (tools ?? [])
        .filter((t) => t.type === 'function' && isSubflowToolName(t.function.name))
        .map((t) => t.function.name)
    : [];
  const hasSubflowTool = subflowToolCallNames.length > 0;
  const communicationToolNames = conversationId
    ? (tools ?? []).filter(t => t.type === 'function' && isSubflowCommunicationTool(t.function.name)).map(t => t.function.name)
    : [];
  const detachedToolCallNames = conversationId
    ? (tools ?? [])
        .filter((t) => t.type === 'function' && (
          t.function.name.startsWith(SUBFLOW_DETACHED_TOOL_PREFIX)
          || t.function.name === 'subflow_task_get' || t.function.name === 'subflow_task_cancel'))
        .map((t) => t.function.name)
    : [];
  const hasDetachedSubflowTool = detachedToolCallNames.length > 0;
  const behaviorToolCallNames = conversationId
    ? (tools ?? [])
        .filter((t) => t.type === 'function' && isBehaviorToolName(t.function.name))
        .map((t) => t.function.name)
    : [];
  const hasBehaviorTool = behaviorToolCallNames.length > 0;
  // #1448: search_tools, call_tool and run_tool_script run in-loop too.
  const toolLoadingCallNames = (tools ?? [])
    .filter((t) => t.type === 'function' && isToolLoadingToolName(t.function.name))
    .map((t) => t.function.name);
  const localToolExecutors: Record<string, (args: Record<string, unknown>) => Promise<unknown>> | undefined =
    (hasRunResourceTool || hasMCPResourceTool || hasQuestionTool || hasTodoTool || hasMcpSkillTool || hasPersonaTool || hasMeetingTool || hasSubflowTool || hasBehaviorTool || hasDetachedSubflowTool || communicationToolNames.length > 0 || toolLoadingCallNames.length > 0)
      ? {
          [WRITE_RESOURCE_TOOL_NAME]: async (args: Record<string, unknown>): Promise<unknown> => {
            const outcome = await executeRunResourceTool(WRITE_RESOURCE_TOOL_NAME, args, {
              conversationId,
              node: runResourceNode,
              emit,
              ...durableContext,
            });
            if (!outcome.success) throw new Error(outcome.error ?? 'write_resource failed');
            return outcome.data;
          },
          // read_resource (issue #168): lets a self-orchestrating model
          // dereference a flujo://run/... marker back to full content in-loop.
          // Also dispatches native MCP resource URIs (issue #239) when mcpNodes is available.
          [READ_RESOURCE_TOOL_NAME]: async (args: Record<string, unknown>): Promise<unknown> => {
            const outcome = await executeRunResourceTool(READ_RESOURCE_TOOL_NAME, args, {
              conversationId,
              maxImageTokens: modelContextWindow ? Math.min(8192, Math.floor(modelContextWindow / 8)) : 8192,
              node: runResourceNode,
              emit,
              mcpNodes: mcpNodes ?? [],
              ...durableContext,
            });
            return nativeRunResourceResult(outcome);
          },
          // list_mcp_resources (issue #239): list native MCP server resources in-loop.
          [LIST_MCP_RESOURCES_TOOL_NAME]: async (args: Record<string, unknown>): Promise<unknown> => {
            const outcome = await executeMCPResourceTool(LIST_MCP_RESOURCES_TOOL_NAME, args, {
              conversationId,
              node: runResourceNode,
              emit,
              mcpNodes: mcpNodes ?? [],
              ...durableContext,
            });
            if (!outcome.success) throw new Error(outcome.error ?? 'list_mcp_resources failed');
            return outcome.data;
          },
          // question (issue #258): lets a self-orchestrating model ask the user
          // a structured multiple-choice question in-loop and block on the
          // answer, same as the request/response path's processToolCalls branch.
          [QUESTION_TOOL_NAME]: async (args: Record<string, unknown>): Promise<unknown> => {
            const outcome = await executeQuestionTool(args, {
              conversationId,
              node: runResourceNode,
              emit,
              unattended: input.unattended,
            });
            if (!outcome.success) throw new Error(outcome.error ?? 'question failed');
            return outcome.data;
          },
          // todo (issue #259): lets a self-orchestrating model maintain its
          // run-scoped task list in-loop, same as the request/response path.
          [TODO_TOOL_NAME]: async (args: Record<string, unknown>): Promise<unknown> => {
            const outcome = await executeTodoTool(args, {
              conversationId,
              node: runResourceNode,
              emit,
            });
            if (!outcome.success) throw new Error(outcome.error ?? 'todo failed');
            return outcome.data;
          },
          // load_mcp_skill: load a skill a bound MCP server offers (Skills over MCP).
          [LOAD_MCP_SKILL_TOOL_NAME]: async (args: Record<string, unknown>): Promise<unknown> => {
            const outcome = await executeMcpSkillTool(args, {
              conversationId, mcpNodes: mcpNodes ?? [], unattended: input.unattended, emit, node: runResourceNode,
            });
            if (!outcome.success) throw new Error(outcome.error ?? 'load_mcp_skill failed');
            return outcome.data;
          },
        }
      : undefined;

  // call_subflow_* (issue #385): one executor per ADVERTISED tool-mode
  // Subflow name, dispatching to the same lane engine a parallel/spawn
  // Subflow uses (`runSubflowLanes()`), inline inside this tool call. Never
  // dispatched via processHandoffToolCalls — that only matches `handoff_to_*`.
  if (localToolExecutors && hasSubflowTool) {
    for (const toolName of subflowToolCallNames) {
      localToolExecutors[toolName] = async (args: Record<string, unknown>): Promise<unknown> => {
        const outcome = await executeSubflowToolCall(toolName, args, { conversationId, emit });
        if (!outcome.success) throw Object.assign(new Error(outcome.error ?? 'call_subflow failed'), { details: outcome.errorDetails });
        return outcome.data;
      };
    }
  }

  if (localToolExecutors && hasDetachedSubflowTool) {
    for (const toolName of detachedToolCallNames) {
      localToolExecutors[toolName] = async (args: Record<string, unknown>): Promise<unknown> => {
        const context = { conversationId, emit };
        const outcome = toolName === 'subflow_task_get'
          ? await executeTaskGet(String(args.taskId ?? ''), context)
          : toolName === 'subflow_task_cancel'
            ? await executeTaskCancel(String(args.taskId ?? ''), context)
            : await executeDetachedSubflowStart(toolName, args, context);
        if (!outcome.success) throw new Error(outcome.error ?? `${toolName} failed`);
        return outcome.data;
      };
    }
  }

  for (const toolName of communicationToolNames) {
    localToolExecutors![toolName] = async (args: Record<string, unknown>): Promise<unknown> => {
      const outcome = await executeSubflowCommunicationTool(toolName, args, { conversationId, signal: input.signal });
      if (!outcome.success) throw new Error(outcome.error ?? `${toolName} failed`);
      return outcome.data;
    };
  }

  if (localToolExecutors && hasBehaviorTool) {
    for (const toolName of behaviorToolCallNames) {
      localToolExecutors[toolName] = async (args: Record<string, unknown>): Promise<unknown> => {
        const outcome = await executeBehaviorToolCall(toolName, args, { conversationId, emit });
        if (!outcome.success) throw new Error(outcome.error ?? 'call_behavior failed');
        return outcome.data;
      };
    }
  }

  if (localToolExecutors && hasPersonaTool) {
    for (const toolName of personaToolCallNames) {
      if (!isPersonaToolName(toolName)) continue;
      localToolExecutors[toolName] = async (args: Record<string, unknown>): Promise<unknown> => {
        const outcome = await executePersonaTool(toolName, args, {
          conversationId,
          executionAuthority: input.executionAuthority,
          personaAttribution: input.personaAttribution,
        });
        if (!outcome.success) throw new Error(outcome.error ?? `${toolName} failed`);
        return outcome.data;
      };
    }
  }

  // Meeting controls use the same live-state executor as the outer
  // request/response loop. Add only names actually advertised on this call;
  // ordinary flows therefore expose neither definitions nor local handlers.
  if (localToolExecutors && hasMeetingTool) {
    for (const toolName of meetingToolCallNames) {
      localToolExecutors[toolName] = async (args: Record<string, unknown>): Promise<unknown> => {
        const outcome = await executeMeetingTool(toolName, args, { conversationId });
        if (!outcome.success) throw new Error(outcome.error ?? `${toolName} failed`);
        return outcome.data;
      };
    }
  }

  if (localToolExecutors && toolLoadingCallNames.length > 0) {
    for (const toolName of toolLoadingCallNames) {
      localToolExecutors[toolName] = async (args: Record<string, unknown>): Promise<unknown> => {
        const outcome = await executeToolLoadingTool(toolName, args, {
          catalog: input.toolCatalog,
          toolNameMap: toolNameMap ?? {},
          mcpNodes,
          markToolsLoaded: input.markToolsLoaded,
          approve: requestToolApproval,
          service: mcpService,
          conversationId,
          runId,
          nodeId,
          signal: input.signal ?? input.executionAuthority?.signal,
          beforeToolDispatch: input.beforeToolDispatch,
          authorizePersonaCoreMcp: input.executionAuthority?.authorizePersonaCoreMcp,
          contextWindow: modelContextWindow,
        });
        if (!outcome.success) throw new Error(outcome.content);
        return toolLoadingResultValue(outcome.content);
      };
    }
  }

  return { localToolExecutors, shouldEndAgenticTurn };
}
