// Debugger pauses of a run: boundary snapshots, attach requests, breakpoints and the pause events.
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import { EmitFn } from '@/shared/types/execution/events';
import OpenAI from 'openai';
import { SharedState, type DebugBoundary } from '@/backend/execution/flow/types';
import cloneDeep from 'lodash/cloneDeep';
import { StorageKey } from '@/shared/types/storage';
import { decodeToolName } from '@/backend/execution/flow/handlers/toolNamespace';
import { ATTACH_BREAKPOINT, matchToolBreakpoint } from '@/utils/shared/debugBreakpoints';

const log = createLogger('backend/execution/flow/runDebugPause');

/** Where a debugger pause stops: before or after a node, model call, tool batch or hand-off. */
export type DebugPausePhase =
  | 'before-node'
  | 'after-node'
  | 'before-model'
  | 'after-model'
  | 'before-tool'
  | 'after-tool'
  | 'before-handoff'
  | 'after-handoff';

/** The tool breakpoint (if any) armed for this batch of tool calls. Decodes
 *  namespaced MCP names so `tool:read_file` matches `mcp_<slug>_<hash>`. */
export const matchedToolBreakpointName = (sharedState: SharedState, toolCalls: readonly { function?: { name?: string } }[] | undefined) =>
  matchToolBreakpoint(
    sharedState.breakpoints,
    toolCalls,
    (name) => decodeToolName(name, sharedState.toolNameMap),
  );

export const hasAttachRequest = (sharedState: SharedState) =>
  !!sharedState.debugPauseRequested
  || !!sharedState.breakpoints?.includes(ATTACH_BREAKPOINT);

export const consumeAttachRequest = (sharedState: SharedState) => {
  const requested = hasAttachRequest(sharedState);
  if (!requested) return false;
  sharedState.debugPauseRequested = false;
  // Backward compatibility for clients that still arm the legacy sentinel.
  sharedState.breakpoints = (sharedState.breakpoints ?? []).filter(b => b !== ATTACH_BREAKPOINT);
  return true;
};

/** A debugger boundary before runFlow numbers, stamps and snapshots it. */
export type BoundaryDetails = Omit<DebugBoundary, 'index' | 'timestamp' | 'stateSnapshot'>;

export const toolNodeIdsFor = (sharedState: SharedState,
  toolCalls: readonly OpenAI.ChatCompletionMessageFunctionToolCall[] | undefined,
): string[] | undefined => {
  if (!toolCalls?.length) return undefined;
  const ids = Array.from(new Set(toolCalls
    .map(call => sharedState.toolNameMap?.[call.function.name]?.nodeId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)));
  return ids.length > 0 ? ids : undefined;
};

export const latestModelInput = (sharedState: SharedState) => {
  const step = sharedState.executionTrace?.[sharedState.executionTrace.length - 1];
  return step?.modelInputs?.[step.modelInputs.length - 1] ?? step?.modelInput;
};

export const previewNextModelInput = async (sharedState: SharedState, effectiveConvId: string) => {
  // Some focused tests replace FlowExecutor with a deliberately small mock;
  // keep the preview additive so those legacy seams and recovered runtimes
  // still fall back to the ordinary conversation/state inspector.
  const preview = (FlowExecutor as typeof FlowExecutor & {
    previewNextModelInput?: typeof FlowExecutor.previewNextModelInput;
  }).previewNextModelInput;
  if (typeof preview !== 'function') return null;
  try {
    return await preview.call(FlowExecutor, sharedState);
  } catch (error) {
    log.warn(`Could not prepare debugger wire preview for conv ${effectiveConvId}`, error);
    return null;
  }
};

export const captureBoundaryState = (sharedState: SharedState) => {
  const lastMessage = sharedState.messages[sharedState.messages.length - 1];
  return {
    status: sharedState.status,
    currentNodeId: sharedState.currentNodeId,
    messageCount: sharedState.messages.length,
    ...(lastMessage ? {
      lastMessage: {
        id: lastMessage.id,
        role: lastMessage.role,
        processNodeId: lastMessage.processNodeId,
        ...(lastMessage.tool_calls?.length
          ? { toolCallIds: lastMessage.tool_calls.map(call => call.id) }
          : {}),
      },
    } : {}),
    ...(sharedState.variables ? { variables: cloneDeep(sharedState.variables) } : {}),
    ...(sharedState.usage ? { usage: cloneDeep(sharedState.usage) } : {}),
    ...(sharedState.lastResponse !== undefined
      ? { lastResponse: cloneDeep(sharedState.lastResponse) }
      : {}),
    ...(sharedState.handoffInput ? { handoffInput: cloneDeep(sharedState.handoffInput) } : {}),
    ...(sharedState.pendingSubflowReturn
      ? { pendingSubflowReturn: cloneDeep(sharedState.pendingSubflowReturn) }
      : {}),
  };
};

export const inferredBoundary = (sharedState: SharedState,
  phase: DebugPausePhase | undefined,
  nodeId: string | undefined,
): BoundaryDetails | undefined => {
  if (!phase) return undefined;
  if (phase === 'before-node' || phase === 'after-node') {
    return { operation: 'node', phase: phase === 'before-node' ? 'before' : 'after', nodeId };
  }
  if (phase === 'before-model' || phase === 'after-model') {
    return {
      operation: 'model',
      phase: phase === 'before-model' ? 'before' : 'after',
      nodeId,
      ...(latestModelInput(sharedState) ? { modelInput: latestModelInput(sharedState) } : {}),
    };
  }
  if (phase === 'before-tool' || phase === 'after-tool') {
    return { operation: 'tool', phase: phase === 'before-tool' ? 'before' : 'after', nodeId };
  }
  return { operation: 'handoff', phase: phase === 'before-handoff' ? 'before' : 'after', nodeId };
};

export const pauseForDebug = (sharedState: SharedState, emit: EmitFn, options: {
  reason?: 'debug' | 'breakpoint';
  phase?: DebugPausePhase;
  nodeId?: string;
  kind?: 'node' | 'tool' | 'attach';
  toolName?: string;
  boundary?: BoundaryDetails;
} = {}) => {
  const nodeId = options.nodeId ?? sharedState.currentNodeId;
  const boundary = options.boundary ?? inferredBoundary(sharedState, options.phase, nodeId);
  if (boundary) {
    const index = (sharedState.debugBoundaryCounter ?? 0) + 1;
    sharedState.debugBoundaryCounter = index;
    sharedState.debugBoundary = {
      ...boundary,
      index,
      timestamp: new Date().toISOString(),
      stateSnapshot: captureBoundaryState(sharedState),
    };
  }
  sharedState.status = 'paused_debug';
  sharedState.debugMode = true;
  if (options.kind && nodeId) {
    emit({
      type: 'breakpoint:hit',
      node: { nodeId },
      kind: options.kind,
      ...(options.toolName ? { toolName: options.toolName } : {}),
    });
  }
  emit({
    type: 'run:paused',
    reason: options.reason ?? 'debug',
    ...(nodeId ? { node: { nodeId } } : {}),
    ...(options.phase ? { phase: options.phase } : {}),
    ...(options.toolName ? { toolName: options.toolName } : {}),
  });
};

export const pauseForAttachAtSafePoint = async (sharedState: SharedState, emit: EmitFn, effectiveConvId: string, storageKey: StorageKey,
  phase: DebugPausePhase,
  boundary?: BoundaryDetails,
): Promise<boolean> => {
  if (!consumeAttachRequest(sharedState)) return false;
  pauseForDebug(sharedState, emit, { reason: 'breakpoint', phase, kind: 'attach', boundary });
  FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
  try {
    sharedState.updatedAt = Date.now();
    await persistConversationState(storageKey, sharedState);
  } catch (error) {
    log.error(`Failed to save state while attaching debugger for conv ${effectiveConvId}:`, error);
  }
  return true;
};
