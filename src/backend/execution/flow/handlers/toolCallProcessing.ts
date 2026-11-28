// Runs one model turn's tool calls: approval, MCP and internal tools, subflows, results in call order.
import { getHarnessExecution, replayHarnessTool } from '@/backend/services/harness/executionScope';
import { createHash } from 'node:crypto';
import { assertExecutionModelTool, ExecutionExtensionError } from '@/backend/execution/extensions';
import { ToolCallProcessingInput, ToolCallProcessingResult } from '../types/modelHandler';
import { ToolCallInfo } from '../types';
import { classifyToolExitCode } from '../toolRepeatGuard';
import { FlujoChatMessage } from '@/shared/types/chat';
import { Result } from '../errors';
import { createToolError } from '../errorFactory';
import { decodeToolName, assertToolIdentityFresh, isToolOfferedInStep } from './toolNamespace';
import OpenAI from 'openai';
import { ownerScopeForRun } from '@/backend/services/mcp/ownerScope';
import { mcpService } from '@/backend/services/mcp';
import { registerToolCall, releaseToolCall } from '../toolCancelRegistry';
import { combineAbortSignals } from '../combineAbortSignals';
import { runWithConcurrency } from '@/backend/services/mcp/utils/boundedConcurrency';
import { DEFAULT_TOOL_CALL_TIMEOUT_SECONDS } from '@/shared/types/mcp';
import { extractUiResourceUri } from '@/shared/utils/mcpApps';
import { resolveInvokedToolUiLink } from '@/backend/mcpApps/toolUi';
import { getRunResourceSettings, writeRunResource } from '@/backend/services/runResources';
import { captureToolResult } from '@/backend/services/runResources/capture';
import { mediaPartFromToolItem, splitToolResultMedia } from '@/backend/services/runResources/toolResultMedia';
import { boundToolResult } from '@/backend/services/runResources/boundToolResult';
import { measureToolResult } from '@/backend/services/runResources/toolResultBound';
import { resolveToolResultBound } from '@/shared/toolResultLimit';
import { isRunResourceToolName, executeRunResourceTool } from './runResourceTools';
import { isQuestionToolName, executeQuestionTool } from './runQuestionTool';
import { isTodoToolName, executeTodoTool } from './todoTool';
import { executeToolLoadingTool, isToolLoadingToolName } from '../toolLoading/toolLoadingExecutors';
import { isMcpSkillToolName, executeMcpSkillTool } from './mcpSkillTools';
import { isPersonaToolName, executePersonaTool } from './personaTools';
import { executeMeetingTool, hasLiveMeetingTurn, isMeetingToolName, isSilentMeetingControlRequest } from './meetingTools';
import { isMCPResourceToolName, executeMCPResourceTool } from './mcpResourceTools';
import { isSubflowToolName, executeSubflowToolCall } from './subflowToolInvocation';
import { isSubflowCommunicationTool, executeSubflowCommunicationTool } from '../subflowCommunication';
import { isBehaviorToolName, executeBehaviorToolCall } from './behaviorToolInvocation';
import { executeDetachedSubflowStart, executeTaskCancel, executeTaskGet, SUBFLOW_DETACHED_TOOL_PREFIX } from './subflowDetachedInvocation';
import { type RunResourceSettings } from '@/shared/types/runResources';
import type { ModelMediaPart } from '@/shared/types/model/media';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { applyPresetArguments } from '@/backend/utils/resolveDynamicReferences';
import { assertFlowExecutionCurrent, commitFlowDurableMutation, isFlowExecutionAuthorityError, rethrowFlowExecutionAuthorityError, type FlowDurableMutationContext } from '@/backend/execution/flow/executionAuthority';
import { createLiveToolApproval, requireApprovalOf } from '@/backend/execution/flow/toolApprovalGate';
import { v4 as uuidv4 } from 'uuid';
import { classifyStatisticsError, createStatisticsEvent, recordStatisticsEvent } from '@/backend/services/statistics';
import { newStatisticsInvocationId, statisticsPayloadMetadata } from '@/backend/services/statistics/metadata';
import { createLogger } from '@/utils/logger';
import { persistModelMedia } from './modelMedia';

const log = createLogger('backend/flow/execution/handlers/toolCallProcessing');

/**
 * Issue #252: default per-server cap on concurrent tool calls within a single
 * model turn, used when a server declares no `maxConcurrency`. Deliberately
 * conservative — the old serial loop implicitly capped every server at 1, so we
 * stay low to avoid overwhelming servers that were protected by serialization.
 */
const DEFAULT_TOOL_CALL_CONCURRENCY = 4;

/**
 * MCP Apps (#97): resolve a tool definition's linked `ui://` resource while
 * honoring the per-server opt-in. The stable spec requires predeclared
 * templates; result metadata can echo that URI but cannot redirect the host
 * to a different, unreviewed resource.
 */
export async function resolveToolUiLink(
  serverName: string,
  toolName: string,
  resultData: unknown,
  advertisedUri?: string,
  invocationArgs?: Record<string, unknown>,
): Promise<{ uri: string; serverName: string; toolName: string; toolArgs?: string; toolOwnerScope?: string } | undefined> {
  // New conversations carry the advertised URI in their tool identity map.
  // Older persisted maps do not, so re-read the model-visible definition as a
  // compatibility fallback. Never select a URI solely from the call result.
  let uri = advertisedUri;
  if (!uri) {
    try {
      const { tools } = await mcpService.listServerTools(serverName);
      const def = Array.isArray(tools) ? tools.find((t) => t.name === toolName) : undefined;
      uri = extractUiResourceUri((def as { _meta?: unknown } | undefined)?._meta);
    } catch (error) {
      log.warn(`resolveToolUiLink: failed to list tools for ${serverName}`, error);
    }
  }
  return resolveInvokedToolUiLink(
    serverName,
    toolName,
    uri,
    resultData,
    invocationArgs,
  );
}

export async function processToolCallsAdmitted(input: ToolCallProcessingInput): Promise<Result<ToolCallProcessingResult>> {
  const { toolCalls, toolNameMap, emit, conversationId, runId, node, signal, mcpNodes } = input;
  const durableContext: FlowDurableMutationContext = {
    executionAuthority: input.executionAuthority,
    executionExtensionContext: input.executionExtensionContext,
    personaAttribution: input.personaAttribution,
  };

  log.debug('Processing tool-call batch', { count: toolCalls?.length ?? 0 });

  if (!toolCalls || toolCalls.length === 0) {
    const emptyResult: Result<ToolCallProcessingResult> = {
      success: true,
      value: {
        toolCallMessages: [],
        processedToolCalls: []
      }
    };

    return emptyResult;
  }

  try {
    // Issue #252: run this turn's tool calls CONCURRENTLY (bounded, per-server
    // configurable cap) instead of one-at-a-time. Each call's outcome is written
    // into pre-allocated, index-keyed slots so the emitted/appended order is
    // always the model's original tool_calls order — independent of completion
    // order. This keeps the prefix-cache fingerprint stable and a single-call
    // turn byte-identical to the old sequential path.
    type ProcessedToolCall = ToolCallInfo;
    const results: Array<FlujoChatMessage | null> = new Array(toolCalls.length).fill(null);
    const processed: Array<ProcessedToolCall | null> = new Array(toolCalls.length).fill(null);
    // A valid meeting_control(silent) is a terminal barrier inside this tool
    // batch. Calls before it retain their authored order/semantics; calls
    // after it are paired with synthetic results but never dispatched. This
    // closes the same-response loophole where silence and a large explorer
    // fan-out were emitted together.
    let terminalSilentCallIndex = -1;
    for (let index = 0; conversationId && hasLiveMeetingTurn(conversationId) && index < toolCalls.length; index++) {
      const call = toolCalls[index];
      try {
        const args = JSON.parse(call.function.arguments || '{}');
        if (isSilentMeetingControlRequest(call.function.name, args)) {
          terminalSilentCallIndex = index;
          break;
        }
      } catch {
        // The ordinary dispatch path below returns the malformed-args error.
      }
    }

    // Per-server concurrency caps (MCPManagerConfig.maxConcurrency). Loaded once
    // up front; a server that declares none (or a non-positive value) uses the
    // conservative module default. Failure to load caps is non-fatal.
    const concurrencyByServer = new Map<string, number>();
    try {
      const serverConfigs = await mcpService.loadServerConfigs();
      if (Array.isArray(serverConfigs)) {
        for (const cfg of serverConfigs) {
          if (typeof cfg.maxConcurrency === 'number' && cfg.maxConcurrency > 0) {
            concurrencyByServer.set(cfg.name, cfg.maxConcurrency);
          }
        }
      }
    } catch (error) {
      log.warn('Failed to load server configs for concurrency caps; using default', error);
    }

    // Group key for a call: MCP calls are capped per resolved server; local
    // synthetic tools (handoff / MCP-resource / run-resource) share one cheap
    // unbounded group. Mirrors the dispatch routing inside executeOneToolCall.
    const LOCAL_GROUP = '__local__';
    const groupKeyForCall = (tc: OpenAI.ChatCompletionMessageFunctionToolCall): string => {
      const toolName = tc.function.name;
      if (toolName.startsWith('handoff_to_') || toolName === 'handoff') return LOCAL_GROUP;
      if (isMCPResourceToolName(toolName)) return LOCAL_GROUP;
      if (isRunResourceToolName(toolName)) return LOCAL_GROUP;
      if (isQuestionToolName(toolName)) return LOCAL_GROUP;
      if (isTodoToolName(toolName)) return LOCAL_GROUP;
      if (isToolLoadingToolName(toolName)) return LOCAL_GROUP;
      if (isMcpSkillToolName(toolName)) return LOCAL_GROUP;
      if (isPersonaToolName(toolName)) return LOCAL_GROUP;
      if (isMeetingToolName(toolName)) return LOCAL_GROUP;
      if (isSubflowToolName(toolName)) return LOCAL_GROUP;
      if (isBehaviorToolName(toolName)) return LOCAL_GROUP;
      const decoded = decodeToolName(toolName, toolNameMap);
      return decoded ? `srv:${decoded.server}` : LOCAL_GROUP;
    };
    const approveStepTool = createLiveToolApproval({
      conversationId: input.approvalConversationId ?? conversationId,
      requireApproval: requireApprovalOf(input.requireToolApproval),
      followSetting: !(input.executionExtensionContext || input.personaAttribution || input.unattended),
      stepRequiresApproval: Object.values(toolNameMap ?? {}).some((tool) => tool.requiresApproval)
        ? (toolName) => toolNameMap?.[toolName]?.requiresApproval === true
        : undefined,
      onApprovalRequired: input.onApprovalRequired,
      signal,
    });
    const limitForGroup = (key: string): number => {
      if (key === LOCAL_GROUP) return Math.max(1, toolCalls.length);
      const server = key.slice('srv:'.length);
      return concurrencyByServer.get(server) ?? DEFAULT_TOOL_CALL_CONCURRENCY;
    };

    // Per-call worker. Runs the EXACT same dispatch logic as the old loop body,
    // but into local single-slot collectors (each path emits exactly one tool
    // message + at most one processed entry), then copies them into the
    // index-keyed slots in a finally so every branch — including the early
    // returns (formerly `continue`) — records its outcome.
    const executeOneToolCall = async (callIndex: number): Promise<void> => {
      const toolCall = toolCalls[callIndex];
      const { id, function: { name, arguments: argsString } } = toolCall;
      if (input.executionExtensionContext) {
        await assertExecutionModelTool(input.executionExtensionContext, name,
          toolNameMap && Object.hasOwn(toolNameMap, name) ? toolNameMap[name] : undefined);
      }
      const decodedForUi = decodeToolName(name, toolNameMap);
      let invocationArgsForUi: Record<string, unknown> | undefined;
      try {
        const parsed = JSON.parse(argsString);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          invocationArgsForUi = parsed as Record<string, unknown>;
        }
      } catch {
        // The normal parsing path below will surface malformed tool args.
      }

      const toolCallMessages: FlujoChatMessage[] = [];
      const processedToolCalls: ProcessedToolCall[] = [];
      const toolStartedAt = Date.now();
      // When the final authority check rejects, preserve that failure as a
      // run-level stop. The broad per-tool catch below intentionally turns
      // ordinary tool failures into transcript messages, but a stale Persona
      // worker must never be allowed to hand that failure back to the model
      // and continue executing.
      let executionAuthorityFailure: unknown;
      // Stable identity for this LOGICAL tool invocation, so a duplicate
      // observation of the same call is deduplicated during aggregation.
      const toolInvocationId = newStatisticsInvocationId();

      // Keep the authority assertion outside the per-tool error-to-message
      // conversion below. A stale Persona fence is a run-level stop, not a
      // recoverable tool error the model may reason past.
      await input.beforeToolDispatch?.();

      try {
        // A step's tool list holds at call time, not only when it is offered.
        // `toolNameMap` deliberately keeps every tool bound during the run so
        // history stays decodable, which makes it the wrong authority here. This
        // also covers FLUJO's by-name tools, which never pass the map. The call
        // is answered with an error, so the model can recover within the step.
        if (!isToolOfferedInStep(name, input.offeredToolNames, toolNameMap)) {
          const reason = `Tool "${name}" is not available in this step. Use only the tools offered for this step.`;
          log.warn(`Rejecting call to a tool this step did not offer: ${name}`);
          emit?.({ type: 'tool:call', toolCallId: id, name, args: argsString });
          emit?.({ type: 'tool:result', toolCallId: id, name, result: reason, isError: true });
          toolCallMessages.push({ id: uuidv4(), role: 'tool', tool_call_id: id, content: reason, timestamp: Date.now() });
          processedToolCalls.push({ name, args: {}, id, result: reason });
          return;
        }

        // Cancellation check BEFORE starting this call (issue #109/#252): once
        // Stop is pressed, a not-yet-started call is answered with a synthetic
        // "cancelled" tool message so every tool_call id stays answered and the
        // transcript well-formed. In-flight calls are killed via the signal.
        if (input.shouldAbort?.()) {
          log.info(`Cancellation detected before tool call ${name}; answering it with a synthetic cancelled result.`);
          const cancelledReason = 'Execution cancelled by user before this tool call ran.';
          const uiLink = decodedForUi
            ? await resolveToolUiLink(
                decodedForUi.server,
                decodedForUi.tool,
                undefined,
                decodedForUi.uiResourceUri,
                invocationArgsForUi,
              )
            : undefined;
          toolCallMessages.push({
            id: uuidv4(),
            role: "tool",
            tool_call_id: id,
            content: cancelledReason,
            timestamp: Date.now(),
            ...(uiLink ? { ui: { ...uiLink, cancelledReason, isError: true } } : {}),
          });
          processedToolCalls.push({ name, args: {}, id, result: cancelledReason });
          return;
        }
        // Parse the arguments
        let args = JSON.parse(argsString) as Record<string, unknown>;
        log.info("trying to call tool", name)
        if (getHarnessExecution() && !name.startsWith('handoff_to_') && name !== 'handoff') {
          const resultContent = replayHarnessTool(name, args);
          toolCallMessages.push({ id: uuidv4(), role: 'tool', tool_call_id: id, content: resultContent, timestamp: Date.now() });
          processedToolCalls.push({ name, args, id, result: resultContent });
          return;
        }
        // Check if it's a handoff tool
        if (name.startsWith('handoff_to_') || name === 'handoff') {
          // Process handoff tool directly
          log.info(`Processing handoff tool: ${name}`);

          // Return success for handoff tools
          const result = {
            success: true,
            data: { handoff: true, args }
          };

          // Format the result
          const resultContent = JSON.stringify(result.data);

          // Add tool result message with timestamp and ID
          toolCallMessages.push({
            id: uuidv4(), // Generate unique ID
            role: "tool",
            tool_call_id: id,
            content: resultContent,
            timestamp: Date.now() // Add timestamp
          });

          // Add to processed tool calls
          processedToolCalls.push({
            name,
            args,
            id,
            result: resultContent
          });

          // This call is done — record its outcome (see finally).
          return;
        }

        // MCP resource tools (issue #239): synthetic FLUJO tools for native MCP
        // server resources (list_mcp_resources). Dispatched before the standard
        // MCP decode path so they are never routed to mcpService.
        if (isMCPResourceToolName(name)) {
          emit?.({ type: 'tool:call', toolCallId: id, name, args: argsString });
          const outcome = await executeMCPResourceTool(name, args, {
            conversationId,
            node,
            emit,
            mcpNodes: mcpNodes ?? [],
            ...durableContext,
          });
          await assertFlowExecutionCurrent(durableContext);
          const resultContent = outcome.success
            ? JSON.stringify(outcome.data)
            : `Error: ${outcome.error}`;
          await commitFlowDurableMutation(durableContext, async () => {
            emit?.({
              type: 'tool:result',
              toolCallId: id,
              name,
              result: resultContent.length > 500 ? `${resultContent.slice(0, 500)}…` : resultContent,
              isError: !outcome.success,
            });
          });
          toolCallMessages.push({
            id: uuidv4(),
            role: 'tool',
            tool_call_id: id,
            content: resultContent,
            timestamp: Date.now(),
          });
          processedToolCalls.push({ name, args, id, result: resultContent });
          return;
        }

        // Run-resource tools (issue #161): synthetic FLUJO tools that write a
        // run artifact, dispatched here (not via mcpService) using the run's
        // conversationId already in scope. Only offered when a produce node is
        // wired (ProcessNode.prep), so this branch is inert for other flows.
        if (isRunResourceToolName(name)) {
          emit?.({ type: 'tool:call', toolCallId: id, name, args: argsString });
          const outcome = await executeRunResourceTool(name, args, {
            conversationId,
            node,
            emit,
            mcpNodes: mcpNodes ?? [],
            ...durableContext,
          });
          await assertFlowExecutionCurrent(durableContext);
          const resultContent = outcome.success
            ? JSON.stringify(outcome.data)
            : `Error: ${outcome.error}`;
          await commitFlowDurableMutation(durableContext, async () => {
            emit?.({
              type: 'tool:result',
              toolCallId: id,
              name,
              result: resultContent.length > 500 ? `${resultContent.slice(0, 500)}…` : resultContent,
              isError: !outcome.success,
            });
          });
          toolCallMessages.push({
            id: uuidv4(),
            role: 'tool',
            tool_call_id: id,
            content: resultContent,
            ...(outcome.media?.length ? { media: await persistModelMedia(outcome.media, conversationId, node?.nodeId, durableContext) } : {}),
            timestamp: Date.now(),
          });
          processedToolCalls.push({ name, args, id, result: resultContent });
          return;
        }

        // Question tool (issue #258): synthetic FLUJO tool that asks the user a
        // structured multiple-choice question and BLOCKS this turn until they
        // answer/decline (in-request blocking-promise via questionRegistry).
        // Only offered when the node opted in (ProcessNode.prep allowQuestion),
        // so this branch is inert otherwise. Unattended runs degrade to a clear
        // tool-error rather than blocking (executeQuestionTool honours it).
        if (isQuestionToolName(name)) {
          emit?.({ type: 'tool:call', toolCallId: id, name, args: argsString });
          const outcome = await executeQuestionTool(args, {
            conversationId,
            node,
            emit,
            unattended: input.unattended,
          });
          const resultContent = outcome.success
            ? (typeof outcome.data === 'string' ? outcome.data : JSON.stringify(outcome.data))
            : `Error: ${outcome.error}`;
          emit?.({
            type: 'tool:result',
            toolCallId: id,
            name,
            result: resultContent.length > 500 ? `${resultContent.slice(0, 500)}…` : resultContent,
            isError: !outcome.success,
          });
          toolCallMessages.push({
            id: uuidv4(),
            role: 'tool',
            tool_call_id: id,
            content: resultContent,
            timestamp: Date.now(),
          });
          processedToolCalls.push({ name, args, id, result: resultContent });
          return;
        }

        // load_mcp_skill: asks the person once, then returns the verified
        // skill text as untrusted data (mcpSkillTools.ts).
        if (isMcpSkillToolName(name)) {
          emit?.({ type: 'tool:call', toolCallId: id, name, args: argsString });
          const outcome = await executeMcpSkillTool(args, {
            conversationId, mcpNodes: mcpNodes ?? [], unattended: input.unattended, emit, node,
          });
          const resultContent = outcome.success ? String(outcome.data) : `Error: ${outcome.error}`;
          emit?.({
            type: 'tool:result',
            toolCallId: id,
            name,
            result: resultContent.length > 500 ? `${resultContent.slice(0, 500)}…` : resultContent,
            isError: !outcome.success,
          });
          toolCallMessages.push({ id: uuidv4(), role: 'tool', tool_call_id: id, content: resultContent, timestamp: Date.now() });
          processedToolCalls.push({ name, args, id, result: resultContent });
          return;
        }

        // Todo tool (issue #259): synthetic FLUJO tool that replaces the
        // run-scoped task list on the live SharedState and emits a todo:update
        // event for the live view. Only offered when the node opted in
        // (ProcessNode.prep enableTodoTool), so this branch is inert otherwise.
        if (isTodoToolName(name)) {
          emit?.({ type: 'tool:call', toolCallId: id, name, args: argsString });
          const outcome = await executeTodoTool(args, { conversationId, node, emit });
          const resultContent = outcome.success
            ? JSON.stringify(outcome.data)
            : `Error: ${outcome.error}`;
          emit?.({
            type: 'tool:result',
            toolCallId: id,
            name,
            result: resultContent.length > 500 ? `${resultContent.slice(0, 500)}…` : resultContent,
            isError: !outcome.success,
          });
          toolCallMessages.push({
            id: uuidv4(),
            role: 'tool',
            tool_call_id: id,
            content: resultContent,
            timestamp: Date.now(),
          });
          processedToolCalls.push({ name, args, id, result: resultContent });
          return;
        }

        // #1448: deferred tool search, call-through and code mode. A tool a
        // program runs asks the approval gate live, since it cannot pause the run.
        if (isToolLoadingToolName(name)) {
          emit?.({ type: 'tool:call', toolCallId: id, name, args: argsString });
          const outcome = await executeToolLoadingTool(name, args, {
            catalog: input.toolCatalog,
            toolNameMap: toolNameMap ?? {},
            offeredToolNames: input.offeredToolNames,
            mcpNodes,
            markToolsLoaded: input.markToolsLoaded,
            approve: approveStepTool,
            service: mcpService,
            conversationId,
            runId,
            nodeId: node?.nodeId,
            signal,
            beforeToolDispatch: input.beforeToolDispatch,
            authorizePersonaCoreMcp: input.executionAuthority?.authorizePersonaCoreMcp,
            contextWindow: input.modelContextWindow,
            toolResults: input.toolResults,
          });
          emit?.({
            type: 'tool:result',
            toolCallId: id,
            name,
            result: outcome.content.length > 500 ? `${outcome.content.slice(0, 500)}…` : outcome.content,
            isError: !outcome.success,
          });
          toolCallMessages.push({ id: uuidv4(), role: 'tool', tool_call_id: id, content: outcome.content, timestamp: Date.now() });
          processedToolCalls.push({ name, args, id, result: outcome.content });
          return;
        }

        // Issue #415 phase 4: authored, fenced Persona memory/WorkItem tools.
        if (isPersonaToolName(name)) {
          emit?.({ type: 'tool:call', toolCallId: id, name, args: argsString });
          const outcome = await executePersonaTool(name, args, {
            conversationId,
            executionAuthority: input.executionAuthority,
            personaAttribution: input.personaAttribution,
          });
          const resultContent = outcome.success
            ? JSON.stringify(outcome.data)
            : `Error: ${outcome.error}`;
          emit?.({
            type: 'tool:result',
            toolCallId: id,
            name,
            result: resultContent.length > 500 ? `${resultContent.slice(0, 500)}…` : resultContent,
            isError: !outcome.success,
          });
          toolCallMessages.push({
            id: uuidv4(),
            role: 'tool',
            tool_call_id: id,
            content: resultContent,
            timestamp: Date.now(),
          });
          processedToolCalls.push({ name, args, id, result: resultContent });
          return;
        }

        // Coordinator-owned meeting controls. The executor verifies that the
        // conversation is an active meeting participant and appends only a
        // normalized action to this turn's live SharedState. The coordinator
        // commits those actions after the participant turn settles.
        if (isMeetingToolName(name)) {
          emit?.({ type: 'tool:call', toolCallId: id, name, args: argsString });
          const outcome = await executeMeetingTool(name, args, { conversationId });
          const resultContent = outcome.success
            ? JSON.stringify(outcome.data)
            : `Error: ${outcome.error}`;
          emit?.({
            type: 'tool:result',
            toolCallId: id,
            name,
            result: resultContent.length > 500 ? `${resultContent.slice(0, 500)}…` : resultContent,
            isError: !outcome.success,
          });
          toolCallMessages.push({
            id: uuidv4(),
            role: 'tool',
            tool_call_id: id,
            content: resultContent,
            timestamp: Date.now(),
          });
          processedToolCalls.push({ name, args, id, result: resultContent });
          return;
        }

        if (isBehaviorToolName(name)) {
          emit?.({ type: 'tool:call', toolCallId: id, name, args: argsString });
          const outcome = await executeBehaviorToolCall(name, args, {
            conversationId,
            toolCallId: id,
            emit,
          });
          const resultContent = outcome.success
            ? JSON.stringify(outcome.data)
            : `Error: ${outcome.error}`;
          emit?.({
            type: 'tool:result',
            toolCallId: id,
            name,
            result: resultContent.length > 500 ? `${resultContent.slice(0, 500)}…` : resultContent,
            isError: !outcome.success,
          });
          toolCallMessages.push({
            id: uuidv4(),
            role: 'tool',
            tool_call_id: id,
            content: resultContent,
            timestamp: Date.now(),
          });
          processedToolCalls.push({ name, args, id, result: resultContent });
          return;
        }

        // Inline subflow tools are available on every connected Subflow.
        if (isSubflowToolName(name)) {
          emit?.({ type: 'tool:call', toolCallId: id, name, args: argsString });
          const outcome = await executeSubflowToolCall(name, args, { conversationId, emit });
          const resultContent = outcome.success
            ? JSON.stringify(outcome.data)
            : outcome.errorDetails ? JSON.stringify({ success: false, error: outcome.error, errorDetails: outcome.errorDetails }) : `Error: ${outcome.error}`;
          emit?.({
            type: 'tool:result',
            toolCallId: id,
            name,
            result: resultContent.length > 500 ? `${resultContent.slice(0, 500)}…` : resultContent,
            isError: !outcome.success,
          });
          toolCallMessages.push({
            id: uuidv4(),
            role: 'tool',
            tool_call_id: id,
            content: resultContent,
            timestamp: Date.now(),
          });
          processedToolCalls.push({ name, args, id, result: resultContent });
          return;
        }

        if (isSubflowCommunicationTool(name)) {
          emit?.({ type: 'tool:call', toolCallId: id, name, args: argsString });
          const outcome = await executeSubflowCommunicationTool(name, args, { conversationId, toolCallId: id, signal });
          const resultContent = outcome.success ? JSON.stringify(outcome.data) : `Error: ${outcome.error}`;
          emit?.({ type: 'tool:result', toolCallId: id, name, result: resultContent.slice(0, 500), isError: !outcome.success });
          toolCallMessages.push({ id: uuidv4(), role: 'tool', tool_call_id: id, content: resultContent, timestamp: Date.now() });
          processedToolCalls.push({ name, args, id, result: resultContent });
          return;
        }

        if (name.startsWith(SUBFLOW_DETACHED_TOOL_PREFIX) || name === 'subflow_task_get' || name === 'subflow_task_cancel') {
          emit?.({ type: 'tool:call', toolCallId: id, name, args: argsString });
          const outcome = name === 'subflow_task_get'
            ? await executeTaskGet(String(args.taskId ?? ''), { conversationId })
            : name === 'subflow_task_cancel'
              ? await executeTaskCancel(String(args.taskId ?? ''), { conversationId })
              : await executeDetachedSubflowStart(name, args, { conversationId, emit });
          const resultContent = outcome.success ? JSON.stringify(outcome.data) : `Error: ${outcome.error}`;
          emit?.({ type: 'tool:result', toolCallId: id, name, result: resultContent.slice(0, 500), isError: !outcome.success });
          toolCallMessages.push({ id: uuidv4(), role: 'tool', tool_call_id: id, content: resultContent, timestamp: Date.now() });
          processedToolCalls.push({ name, args, id, result: resultContent });
          return;
        }

        // Decode the model-facing name back to (server, tool). New names use the
        // mcp_<slug>_<hash> scheme (decoded via toolNameMap); legacy conversations
        // used _-_-_SERVER_-_-_TOOL (decoded by decodeToolName's fallback).
        const decoded = decodedForUi;
        if (!decoded) {
          log.error("invalid tool format", name)
          throw new Error(`Invalid tool name format: ${name}`);
        }

        const serverName = decoded.server;
        const toolName = decoded.tool;

        // Issue #255: staleness guard. If the MCP client for this server was
        // (re)registered, or the tool's schema changed, after this call was
        // planned/advertised, do NOT dispatch it against the re-created
        // instance. Return a tool ERROR telling the model to re-check its
        // tools. Skipped for legacy/synthetic tools (no identity token). This
        // also covers the approval-resume path, which funnels through here.
        const freshness = assertToolIdentityFresh(name, decoded, mcpService);
        if (!freshness.ok) {
          log.warn(`Rejecting stale/invalid tool call ${name}: ${freshness.reason}`);
          emit?.({ type: 'tool:call', toolCallId: id, name, args: argsString });
          emit?.({ type: 'tool:result', toolCallId: id, name, result: freshness.reason, isError: true });
          const uiLink = await resolveToolUiLink(
            decoded.server,
            decoded.tool,
            undefined,
            decoded.uiResourceUri,
            invocationArgsForUi,
          );
          toolCallMessages.push({
            id: uuidv4(),
            role: 'tool',
            tool_call_id: id,
            content: freshness.reason,
            timestamp: Date.now(),
            ...(uiLink
              ? { ui: { ...uiLink, cancelledReason: freshness.reason, isError: true } }
              : {}),
          });
          processedToolCalls.push({ name, args, id, result: freshness.reason });
          return;
        }

        // Fixed server/node arguments are resolved only at dispatch time and
        // win over anything the model attempted to provide. They were removed
        // from the advertised schema, so the model never sees or controls them.
        if (input.executionExtensionContext && decoded.presetArgs
          && Object.keys(decoded.presetArgs).length > 0) {
          throw new ExecutionExtensionError('execution_tool_presets_forbidden');
        }
        args = await applyPresetArguments(args, decoded.presetArgs, decoded.context);

        emit?.({ type: 'tool:call', toolCallId: id, name, args: argsString });

        // Run-resource settings drive both the tool-args capture (below,
        // before the call) and the tool-result auto-capture (after the call).
        // Fetched once here, only when there is a store for the writes. A run
        // that saves nothing captures nothing, but still moves results over
        // the size limit to its store (#1226).
        const resultStore = input.toolResults?.store ?? conversationId;
        let runResourceSettings: RunResourceSettings | undefined;
        if (resultStore) {
          try {
            runResourceSettings = await getRunResourceSettings();
          } catch (error) {
            log.warn('Failed to load run-resource settings; skipping capture', error);
          }
        }

        // Tier 3 / issue #168: capture oversized tool-call PARAMETERS as a run
        // resource (source 'tool-args', keyed by the toolCallId) so a
        // downstream self-orchestrating adapter can render a dereferenceable
        // marker instead of dropping them. Lineage-only at execution time —
        // the active call below still runs with the FULL args. Never fails the
        // run: any store error is logged and skipped.
        if (
          conversationId &&
          runResourceSettings?.autoCaptureEnabled &&
          typeof argsString === 'string' &&
          argsString.length >= runResourceSettings.textThresholdChars
        ) {
          try {
            await commitFlowDurableMutation(durableContext, async () => {
              const writtenArgs = await writeRunResource({
                conversationId,
                mimeType: 'application/json',
                kind: 'text',
                data: { text: argsString },
                producedBy: {
                  source: 'tool-args',
                  payloadRole: 'tool-arguments',
                  nodeId: node?.nodeId,
                  server: serverName,
                  toolName,
                  toolCallId: id,
                },
              });
              if (!('skipped' in writtenArgs)) {
                emit?.({
                  type: 'resource:write',
                  node,
                  server: 'flujo',
                  uri: writtenArgs.uri,
                  name: writtenArgs.name,
                  mimeType: writtenArgs.mimeType,
                  size: writtenArgs.size,
                  source: 'tool-args',
                  toolCallId: id,
                });
              }
            });
          } catch (error) {
            rethrowFlowExecutionAuthorityError(error);
            log.error('Tool-args capture failed; continuing with the call', {
              errorClass: classifyStatisticsError(error),
            });
          }
        }

        // Call the tool via MCP service. The timeout comes from the tool's MCP
        // node (properties.toolTimeout, seconds; -1 = none), defaulting to 5
        // minutes. Server progress notifications are forwarded as live
        // tool:progress events AND reset the SDK's request timer (see
        // services/mcp/tools.ts), so a finite timeout only kills silent calls.
        const timeout = decoded.timeout ?? DEFAULT_TOOL_CALL_TIMEOUT_SECONDS;

        // Issue #357: register a per-call AbortController so the user can
        // cancel THIS tool call from the chat UI (or so whole-run Stop can
        // interrupt it) while it is already in flight. Combined with any
        // inbound signal from the caller; released in the finally below so
        // controllers never leak.
        const cancelScope = conversationId ?? runId;
        // Issue #413: ONE canonical owner key per run for MCP-side resources
        // (Bash sessions). `run:<runId>` is preferred because the run is the
        // lifetime whose end must release them; a conversation outlives it.
        const runOwnerScope = ownerScopeForRun({ runId, conversationId });
        const perCallController = cancelScope ? registerToolCall(cancelScope, id) : undefined;
        const callSignal = combineAbortSignals(signal, perCallController?.signal);
        let result: Awaited<ReturnType<typeof mcpService.callTool>>;
        try {
          // Approval, resource capture, or queueing above may have taken long
          // enough for the lease to expire. Re-check at the final side-effect
          // boundary, immediately before MCP dispatch.
          try {
            await input.beforeToolDispatch?.();
            await input.executionAuthority?.authorizePersonaCoreMcp?.(
              serverName,
              decoded.nodeId,
            );
          } catch (error) {
            executionAuthorityFailure = error;
            throw error;
          }
          const onProgress = (progress: { progress: number; total?: number; message?: string }) => emit?.({
            type: 'tool:progress',
            toolCallId: id,
            name,
            progress: progress.progress,
            total: progress.total,
            message: progress.message,
          });
          result = await mcpService.callTool(
                serverName,
                toolName,
                args,
                timeout,
                onProgress,
                decoded.nodeId,
                callSignal,
                'model',
                runOwnerScope,
                ...(conversationId || input.executionExtensionContext
                  ? [conversationId ? { conversationId } : undefined] as const
                  : [] as const),
                ...(input.executionExtensionContext ? [input.executionExtensionContext] as const : [] as const),
              );
          // The MCP abort is cooperative.  A result may arrive after the
          // Persona lease/meeting generation was replaced; reject it before
          // statistics, resource capture, lineage, or result events observe it.
          await assertFlowExecutionCurrent(durableContext);
        } finally {
          if (cancelScope) releaseToolCall(cancelScope, id);
        }

        // A completed MCP request can still return a protocol-level tool
        // error. Classify the original payload before any capture rewrites
        // it, and use this same outcome for content binding and result status.
        // Received payloads still need capture/media/context protections even
        // when the tool reports an error; those depend on transport success.
        const toolSucceeded = result.success && !Boolean(
          result.data
          && typeof result.data === 'object'
          && (result.data as CallToolResult).isError === true,
        );

        // Tier 3 data flow: auto-capture binary/large tool results as
        // run-scoped resources. The capture may rewrite the result (binary
        // items become URI stubs — base64 in a tool message costs context
        // and helps no model); everything captured is announced as a
        // resource:write event carrying the producing toolCallId (the stable
        // lineage key — runFlow rewrites tool-MESSAGE ids afterwards).
        // Capture never breaks the run: on any failure the original result
        // is kept untouched.
        let effectiveData = result.data;
        // Media captured out of this tool result. Stubbing it in the tool
        // message is only half the round-trip: these parts ride along on the
        // tool message so toApiMessages can fold them into the next user turn
        // as genuine image_url/input_audio INPUT parts. Without this a model
        // can never perceive what its own tools produced.
        let capturedMedia: ModelMediaPart[] = [];
        if (result.success && conversationId && runResourceSettings) {
          try {
            if (runResourceSettings.autoCaptureEnabled) {
              const outcome = await commitFlowDurableMutation(durableContext, async () => {
                const captured = await captureToolResult({
                  conversationId,
                  server: serverName,
                  toolName,
                  toolCallId: id,
                  nodeId: node?.nodeId,
                  result: result.data as CallToolResult,
                  settings: runResourceSettings,
                });
                for (const entry of captured.captured) {
                  emit?.({
                    type: 'resource:write',
                    node,
                    server: 'flujo',
                    uri: entry.uri,
                    name: entry.name,
                    mimeType: entry.mimeType,
                    size: entry.size,
                    source: 'tool-result',
                    toolCallId: id,
                  });
                }
                return captured;
              });
              effectiveData = outcome.result;
              // Keep compatibility with old/mocked CaptureOutcome values while
              // the new media field rolls through every call site.
              capturedMedia = outcome.media ?? [];
            }
          } catch (error) {
            rethrowFlowExecutionAuthorityError(error);
            log.error('Run-resource auto-capture failed; keeping original tool result', {
              errorClass: classifyStatisticsError(error),
            });
            effectiveData = result.data;
            capturedMedia = [];
          }
        }

        // Persistence is preferred, but media delivery must not depend on it.
        // Ephemeral subflows have no conversation id, capture can be disabled,
        // and stores can hit a cap. In every one of those cases split any
        // remaining media out of the text projection and carry it inline on
        // the tool message so toApiMessages still emits a genuine model-input
        // part. Successful captures have already replaced media with stubs, so
        // this is a no-op for the normal URI-backed path.
        if (result.success && effectiveData && typeof effectiveData === 'object') {
          const split = splitToolResultMedia(effectiveData as CallToolResult);
          if (split.hasMedia) {
            effectiveData = split.textResult;
            const inlineMedia = split.mediaItems
              .map(mediaPartFromToolItem)
              .filter((part): part is ModelMediaPart => Boolean(part));
            capturedMedia = [...capturedMedia, ...inlineMedia];
          }
        }

        // All received payloads retain the established context protections.
        // Transport failure diagnostics stay outside this content pipeline;
        // only a genuine tool success can receive the full-content binding.
        let receivedResultContent = result.success ? JSON.stringify(effectiveData) : '';

        // Keep an exact transcript-level copy of medium-large results for the
        // browser's expansion-time loader. Results over the context boundary
        // are captured by boundToolResult below instead, avoiding duplicates.
        if (
          result.success
          && conversationId
          && runResourceSettings?.autoCaptureEnabled
          && receivedResultContent.length >= runResourceSettings.textThresholdChars
        ) {
          // Same test boundToolResult applies below (#1226), so exactly one
          // of the two writes the full copy whatever the setting says.
          const resultBound = resolveToolResultBound(runResourceSettings, input.modelContextWindow, input.toolResults?.limit);
          if (!measureToolResult(receivedResultContent, resultBound).over) {
            try {
              await commitFlowDurableMutation(durableContext, async () => {
                const writtenResult = await writeRunResource({
                  conversationId,
                  mimeType: 'application/json',
                  kind: 'text',
                  data: { text: receivedResultContent },
                  producedBy: {
                    source: 'tool-result',
                    payloadRole: 'tool-message',
                    nodeId: node?.nodeId,
                    server: serverName,
                    toolName,
                    toolCallId: id,
                  },
                });
                if (!('skipped' in writtenResult)) {
                  emit?.({
                    type: 'resource:write',
                    node,
                    server: 'flujo',
                    uri: writtenResult.uri,
                    mimeType: writtenResult.mimeType,
                    size: writtenResult.size,
                    source: 'tool-result',
                    toolCallId: id,
                  });
                }
              });
            } catch (error) {
              rethrowFlowExecutionAuthorityError(error);
              log.error('Tool-result display capture failed; keeping inline result', {
                errorClass: classifyStatisticsError(error),
              });
            }
          }
        }

        // Tier-boundary bound (#251): every oversized tool result is truncated
        // to a head+tail preview and the full content spilled UNCONDITIONALLY
        // to a run resource on THIS turn — so a 5 MB result never reaches the
        // wire in full (not even on the first turn) and both ends of a long
        // log survive. Runs AFTER auto-capture (binaries already stubbed) so
        // only the remaining text form is bounded. Never breaks the run.
        if (result.success && resultStore && runResourceSettings) {
          try {
            const bounded = await commitFlowDurableMutation(durableContext, () => boundToolResult({
                conversationId: resultStore,
                toolCallId: id,
                server: serverName,
                toolName,
                nodeId: node?.nodeId,
                content: receivedResultContent,
                settings: runResourceSettings,
                contextWindow: input.modelContextWindow,
                limit: input.toolResults?.limit,
              }),
            );
            if (bounded.spilled) {
              receivedResultContent = bounded.content;
              if (bounded.uri) {
                await commitFlowDurableMutation(durableContext, async () => {
                  emit?.({
                    type: 'resource:write',
                    node,
                    server: 'flujo',
                    uri: bounded.uri!,
                    mimeType: 'text/plain',
                    size: bounded.bytes,
                    source: 'tool-result',
                    toolCallId: id,
                  });
                });
              }
            }
          } catch (error) {
            rethrowFlowExecutionAuthorityError(error);
            log.error('boundToolResult failed; keeping full tool result', {
              errorClass: classifyStatisticsError(error),
            });
          }
        }

        // Both healthy and protocol-error messages use the final protected
        // payload. Transport failures retain the existing Error diagnostic.
        const resultContent = result.success ? receivedResultContent : `Error: ${result.error}`;
        // The full result reaches the conversation as the tool message below;
        // the event carries a preview so the log stays light. Only successful
        // results carry a binding; error text still reaches the conversation.
        await commitFlowDurableMutation(durableContext, async () => {
          emit?.({
            type: 'tool:result',
            toolCallId: id,
            name,
            result: resultContent.length > 500 ? `${resultContent.slice(0, 500)}…` : resultContent,
            ...(toolSucceeded ? { resultContentBinding: {
              serialization: 'utf8-string-v1' as const,
              sha256: createHash('sha256').update(receivedResultContent, 'utf8').digest('hex'),
              bytes: Buffer.byteLength(receivedResultContent, 'utf8'),
            } } : {}),
            isError: !toolSucceeded
          });
        });

        // MCP Apps (#97): if the server linked this tool to a `ui://` UI
        // resource (SEP-1865 `_meta.ui.resourceUri`) AND has the per-server
        // opt-in enabled, attach the link so chat can render it sandboxed.
        const cancelledReason =
          !result.success
          && (
            result.errorType === 'cancelled'
            || result.errorType === 'timeout'
            || signal?.aborted
            || input.shouldAbort?.()
          )
            ? (result.error || 'Tool execution cancelled.')
            : undefined;
        const uiLink = await resolveToolUiLink(
          serverName,
          toolName,
          result.data,
          decoded.uiResourceUri,
          invocationArgsForUi,
        );

          // Add tool result message with timestamp and ID
          toolCallMessages.push({
            id: uuidv4(), // Generate unique ID
            role: "tool",
            tool_call_id: id,
            content: resultContent,
            timestamp: Date.now(), // Add timestamp
            ...(capturedMedia.length ? { media: capturedMedia } : {}),
            ...(uiLink
              ? {
                  ui: {
                    ...uiLink,
                    ...(!toolSucceeded ? { isError: true } : {}),
                    ...(cancelledReason ? { cancelledReason } : {}),
                  },
                }
              : {})
          });

        // Add to processed tool calls
        processedToolCalls.push({
          name,
          args,
          id,
          result: resultContent,
          exitCode: toolSucceeded ? 0 : 1,
        });
      } catch (error) {
        if (error === executionAuthorityFailure || isFlowExecutionAuthorityError(error)) throw error;
        const errorMessage = `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
        emit?.({ type: 'tool:result', toolCallId: id, name, result: errorMessage, isError: true });
        const wasCancelled =
          signal?.aborted
          || input.shouldAbort?.()
          || /\bcancel(?:led|ed|ation)\b/i.test(errorMessage);
        const uiLink = decodedForUi
          ? await resolveToolUiLink(
              decodedForUi.server,
              decodedForUi.tool,
              undefined,
              decodedForUi.uiResourceUri,
              invocationArgsForUi,
            )
          : undefined;
        // Add error message for this specific tool call with timestamp and ID
        toolCallMessages.push({
          id: uuidv4(), // Generate unique ID
          role: "tool",
          tool_call_id: id,
          content: errorMessage,
          timestamp: Date.now(), // Add timestamp
          ...(uiLink
            ? {
                ui: {
                  ...uiLink,
                  isError: true,
                  ...(wasCancelled ? { cancelledReason: errorMessage } : {}),
                },
              }
            : {}),
        });

        // Add to processed tool calls with error
        processedToolCalls.push({
          name,
          args: {},
          id,
          result: errorMessage
        });
      } finally {
        // Copy this call's single outcome into its index-keyed slots. Every
        // dispatch path pushes exactly one message (+ at most one processed
        // entry), so [0] is authoritative; ordering is by callIndex, never by
        // completion time.
        results[callIndex] = toolCallMessages[0] ?? null;
        const processedCall = processedToolCalls[0];
        const message = toolCallMessages[0];
        const content = typeof message?.content === 'string' ? message.content : '';
        processed[callIndex] = processedCall
          ? {
              ...processedCall,
              exitCode: processedCall.exitCode
                ?? classifyToolExitCode(content, Boolean(message?.ui?.isError)),
            }
          : null;
        if (runId) {
          const cancelled = Boolean(signal?.aborted || input.shouldAbort?.() || /\bcancel(?:led|ed|ation)\b/i.test(content));
          const failed = processed[callIndex]?.exitCode === 1;
          const kind = name.startsWith('handoff_to_') || name === 'handoff'
            ? 'handoff' as const
            : isRunResourceToolName(name) || isMCPResourceToolName(name)
              ? 'resource' as const
              : isQuestionToolName(name) || isTodoToolName(name) || isToolLoadingToolName(name) || isMcpSkillToolName(name) || isPersonaToolName(name) || isMeetingToolName(name) || isSubflowToolName(name) || isBehaviorToolName(name) || isSubflowCommunicationTool(name) || name.startsWith(SUBFLOW_DETACHED_TOOL_PREFIX) || name === 'subflow_task_get' || name === 'subflow_task_cancel'
                ? 'synthetic' as const
                : decodedForUi
                  ? 'mcp' as const
                  : 'unknown' as const;
          recordStatisticsEvent(createStatisticsEvent({
            type: 'tool.invocation',
            runId,
            node: node ? { id: node.nodeId, name: node.nodeName } : undefined,
            tool: { id: decodedForUi?.tool ?? name, name, kind },
            provider: decodedForUi ? { id: decodedForUi.server } : undefined,
            invocationId: toolInvocationId,
            outcome: cancelled ? 'cancelled' : failed ? 'error' : 'completed',
            durationMs: Math.max(0, Date.now() - toolStartedAt),
            phases: { tool: Math.max(0, Date.now() - toolStartedAt) },
            // Metadata ONLY: byte/character counts and a normalized shape
            // category. Arguments and results themselves are never recorded.
            payload: statisticsPayloadMetadata(argsString, content),
            errorClass: failed ? classifyStatisticsError(cancelled ? { type: 'cancelled' } : { type: 'tool' }) : undefined,
          }));
        }
      }
    };

    // Drive the batch: group calls by server, run each group under its own cap,
    // and run the groups concurrently. Local synthetic tools share one group.
    const groups = new Map<string, number[]>();
    for (let i = 0; i < toolCalls.length; i++) {
      if (terminalSilentCallIndex >= 0 && i > terminalSilentCallIndex) continue;
      const key = groupKeyForCall(toolCalls[i]);
      const bucket = groups.get(key);
      if (bucket) bucket.push(i);
      else groups.set(key, [i]);
    }
    // A run-level authority failure must stop new dispatch without letting
    // Promise.all close the output-consumption scope while sibling workers
    // still serialize their results. Swallow only at this pool boundary,
    // drain every started group/worker, then preserve the first failure.
    let batchFailed = false, batchFailure: unknown;
    await Promise.all(
      Array.from(groups.entries()).map(([key, indices]) =>
        runWithConcurrency(indices, limitForGroup(key), async index => {
          if (batchFailed) return;
          try { await executeOneToolCall(index); }
          catch (error) {
            if (!batchFailed) { batchFailed = true; batchFailure = error; }
          }
        })
      )
    );
    if (batchFailed) throw batchFailure;

    if (terminalSilentCallIndex >= 0) {
      const reason = 'Meeting turn ended silently before this tool call; it was not executed.';
      for (let i = terminalSilentCallIndex + 1; i < toolCalls.length; i++) {
        const call = toolCalls[i];
        results[i] = {
          id: uuidv4(),
          role: 'tool',
          tool_call_id: call.id,
          content: `Error: ${reason}`,
          timestamp: Date.now(),
        };
        processed[i] = {
          name: call.function.name,
          args: {},
          id: call.id,
          result: `Error: ${reason}`,
        };
        emit?.({
          type: 'tool:result',
          toolCallId: call.id,
          name: call.function.name,
          result: reason,
          isError: true,
        });
      }
    }

    // Defensive: any still-empty slot (a call that never ran) is answered with
    // a synthetic cancelled message so every tool_call id stays answered.
    for (let i = 0; i < toolCalls.length; i++) {
      if (results[i] === null) {
        results[i] = {
          id: uuidv4(),
          role: "tool",
          tool_call_id: toolCalls[i].id,
          content: 'Execution cancelled by user before this tool call ran.',
          timestamp: Date.now()
        };
      }
    }

    const result: Result<ToolCallProcessingResult> = {
      success: true,
      value: {
        toolCallMessages: results.filter((m): m is FlujoChatMessage => m !== null),
        processedToolCalls: processed.filter((p): p is ProcessedToolCall => p !== null)
      }
    };

    log.debug('Tool-call batch completed', {
      requested: toolCalls.length,
      completed: result.value.toolCallMessages.length,
    });

    return result;
  } catch (error) {
    const errorResult: Result<ToolCallProcessingResult> = {
      success: false,
      error: createToolError(
        'tool_processing_failed',
        error instanceof Error ? error.message : String(error),
        'unknown'
      )
    };

    log.warn('Tool-call batch failed', {
      errorClass: classifyStatisticsError(error),
    });

    return errorResult;
  }
}
