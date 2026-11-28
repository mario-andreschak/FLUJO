// Admits a turn's messages into the conversation and pins the flow of a new one.
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { traceMark, traceSpan } from './turnTrace';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import { ERROR_ACTION, type SharedState } from '@/backend/execution/flow/types';
import { FlujoChatMessage } from '@/shared/types/chat';
import { flowService } from '@/backend/services/flow/index';
import { Flow } from '@/shared/types/flow';
import { StorageKey } from '@/shared/types/storage';
import { buildConversationTitle, isDefaultConversationTitle } from '@/utils/shared/conversationTitle';
import type { FlowRunInput, FlowRunMessageInput, FlowRunResult } from './runFlowContract';
import type { RunStateSource } from './runStateLoading';

const log = createLogger('backend/execution/flow/runTurnAdmission');

/** The request fields runFlow reads (the legacy `data` shape). */
export type TurnRequest = { model?: string; messages: FlowRunMessageInput[]; processNodeId?: string };

/** What admitting a turn needs from runFlow. */
export type TurnAdmission = {
  sharedState: SharedState;
  stateSource: RunStateSource;
  input: FlowRunInput;
  data: TurnRequest;
  effectiveConvId: string;
  storageKey: StorageKey;
  userTurn: boolean;
  flujodebug: boolean;
  /** Collects the ids of messages this request brought in. */
  admittedMessageIds: Set<string>;
  finalizeRun: (result: Omit<FlowRunResult, 'runId'>) => FlowRunResult;
};

/**
 * Admits this request's messages: a new conversation resolves and pins its
 * flow, takes the caller's messages and saves its first snapshot; an existing
 * one replaces or extends its transcript and resets per-turn debugger state.
 * A keyed follow-up of a finished child starts a new turn at Start. Returns
 * the finished error result when no flow can be resolved.
 */
export async function admitTurnMessages(admission: TurnAdmission): Promise<FlowRunResult | undefined> {
  const { sharedState, stateSource, input, data, effectiveConvId, storageKey, userTurn, flujodebug, admittedMessageIds, finalizeRun } = admission;
  // --- Configure State Based on Source ---
  if (stateSource === 'new') {
    // Quick-Chats (issue #61): an in-memory flow definition is snapshotted onto
    // the state and resolved from there by the engine — it never touches the
    // flows store. Takes precedence over flowId/modelName resolution.
    if (input.flowDefinition) {
      sharedState.flowSnapshot = input.flowDefinition;
      sharedState.flowId = input.flowDefinition.id;
    }
    // Resolve the flow: prefer an explicit flowId, else the "flow-<name>" model.
    let resolvedFlowId = input.flowDefinition ? input.flowDefinition.id : input.flowId;
    let resolvedFlow: Flow | undefined;
    if (!resolvedFlowId && data.model) {
      const flowName = data.model.substring(5); // Assumes "flow-FlowName" format
      const reactFlow = await traceSpan('flow.getFlowByName', () => flowService.getFlowByName(flowName));
      if (!reactFlow) {
        log.error(`Flow not found: ${flowName}`);
        return finalizeRun({
          status: 'error',
          conversationId: effectiveConvId,
          outputText: '',
          messages: sharedState.messages,
          flowNotFound: { name: flowName },
          error: { message: `Flow not found: ${flowName}`, statusCode: 400 },
          finalAction: ERROR_ACTION,
          sharedState,
        });
      }
      resolvedFlowId = reactFlow.id;
      resolvedFlow = reactFlow;
    }
    if (!resolvedFlowId) {
      log.error('No flow specified for run (neither flowId nor model provided).');
      return finalizeRun({
        status: 'error',
        conversationId: effectiveConvId,
        outputText: '',
        messages: sharedState.messages,
        error: { message: 'No flow specified (provide flowId or model).', statusCode: 400 },
        finalAction: ERROR_ACTION,
        sharedState,
      });
    }
    sharedState.flowId = resolvedFlowId;

    // Pin the actual saved definition before the first persistence or engine
    // step. Named root runs and by-id subflow children use the same seam, so
    // later edits to the catalog cannot change an in-flight or resumed run.
    // Loaded conversations deliberately keep their original snapshot (or its
    // absence for legacy runs); current catalog data is not historical proof.
    if (!input.flowDefinition) {
      resolvedFlow ??= await flowService.getFlow(resolvedFlowId) ?? undefined;
      if (resolvedFlow) sharedState.flowSnapshot = structuredClone(resolvedFlow);
      traceMark('flow.resolved');
    }

    // Preserve caller-provided ids/timestamps (like the resume path below).
    // The chat frontend sends its optimistic message id; keeping it means the
    // canonical copy MERGES with the optimistic bubble in the live view
    // instead of appearing as a duplicate (dedupe there is by message id).
    // depth>0 messages are display-only subflow steps served by the projection
    // — they must never (re-)enter the parent transcript / model context.
    const initialMessages: FlujoChatMessage[] = (data.messages || [])
      .filter(msg => !(typeof msg.depth === 'number' && msg.depth > 0))
      .map(msg => {
        const normalized = {
          ...msg, id: msg.id || crypto.randomUUID(), timestamp: msg.timestamp || Date.now(),
          processNodeId: msg.processNodeId || undefined,
        } as FlujoChatMessage;
        delete normalized.executionOrigin;
        admittedMessageIds.add(normalized.id);
        return normalized;
      });
    sharedState.messages = initialMessages;
    // Stamp lastUserMessageAt for the initial user turn
    const _initLastUser = [...initialMessages].reverse().find(m => m.role === 'user');
    if (_initLastUser) {
      sharedState.lastUserMessageAt = _initLastUser.timestamp ?? Date.now();
    }

    try {
      sharedState.updatedAt = Date.now();
      if (isDefaultConversationTitle(sharedState.title) && sharedState.messages.length > 0) {
        const firstUserMessage = sharedState.messages.find(m => m.role === 'user');
        if (firstUserMessage && typeof firstUserMessage.content === 'string') {
          sharedState.title = buildConversationTitle(firstUserMessage.content);
          log.verbose(`Updated conversation title for ${effectiveConvId} during init to: ${sharedState.title}`);
        }
      }
      await persistConversationState(storageKey, sharedState); // chokepoint refuses ephemeral states
      log.debug(`Saved initial state for new conversation ${effectiveConvId}.`);
    } catch (error) {
      log.error(`Failed to save initial state for new conversation ${effectiveConvId}:`, error);
    }
    FlowExecutor.conversationStates.set(effectiveConvId, sharedState);

  } else { // stateSource is 'storage' or 'memory'
    if (data.messages && data.messages.length > 0) {
      // As above: drop display-only subflow step messages (depth>0) so they
      // can never round-trip from the projection into the parent transcript.
      const normalizedInputMessages = data.messages
        .filter(msg => !(typeof msg.depth === 'number' && msg.depth > 0))
        .map(msg => {
          const flujoMsg = {
            ...msg,
            id: msg.id || crypto.randomUUID(),
            timestamp: msg.timestamp || Date.now(),
            processNodeId: msg.processNodeId || undefined,
          } as FlujoChatMessage;
          delete flujoMsg.executionOrigin;
          admittedMessageIds.add(flujoMsg.id);
          return flujoMsg;
        });
      if (input.resumeAsNewTurn) {
        sharedState.messages.push(...normalizedInputMessages);
        const lastUser = [...normalizedInputMessages].reverse().find(m => m.role === 'user');
        if (lastUser) sharedState.lastUserMessageAt = lastUser.timestamp ?? Date.now();
        log.info(`Appended ${normalizedInputMessages.length} follow-up message(s) to resumed conversation ${sharedState.conversationId}`);
      } else {
        sharedState.messages = normalizedInputMessages;
        log.info(`Updated conversation ${sharedState.conversationId} with ${sharedState.messages.length} messages from request`);
      }
      // Stamp lastUserMessageAt whenever a user turn is received
      if (userTurn) {
        const _existLastUser = [...sharedState.messages].reverse().find(m => m.role === 'user');
        if (_existLastUser) {
          sharedState.lastUserMessageAt = _existLastUser.timestamp ?? Date.now();
        }
      }
    }
    if (userTurn || sharedState.debugMode === undefined) {
      sharedState.debugMode = flujodebug;
    }
    if (userTurn) {
      // A real message is allowed to recover a conversation whose debugger UI
      // was closed/reloaded while the run was parked. Treat it as a fresh run,
      // not as a hidden debugger resume: clear the parked status and, unless the
      // caller explicitly requested debugging again, disarm old breakpoints.
      if (sharedState.status === 'paused_debug') {
        sharedState.status = 'running';
        sharedState.lastResponse = undefined;
        sharedState.lastError = undefined;
        sharedState.errorEventEmitted = false;
        sharedState.isCancelled = false;
      }
      if (!flujodebug) {
        sharedState.breakpoints = [];
        sharedState.lastBreakNodeId = undefined;
      }
      sharedState.debugPendingToolCalls = undefined;
      sharedState.debugPendingAction = undefined;
      sharedState.debugBoundary = undefined;
      sharedState.debugBoundaryCounter = 0;
      sharedState.debugPauseRequested = false;
    }
  }

  if (input.resumeAsNewTurn && stateSource !== 'new') {
    // A finished child is a conversation, not a suspended call stack. A keyed
    // follow-up starts a new logical turn at the child flow's Start node while
    // retaining the complete prior transcript that was just appended to.
    sharedState.currentNodeId = undefined;
    sharedState.status = 'running';
    sharedState.lastResponse = undefined;
    sharedState.lastError = undefined;
    sharedState.errorEventEmitted = false;
    sharedState.pendingToolCalls = undefined;
    sharedState.handoffRequested = undefined;
    sharedState.handoffInput = undefined;
    sharedState.pendingSubflowReturn = undefined;
    sharedState.debugPendingToolCalls = undefined;
    sharedState.debugPendingAction = undefined;
    sharedState.debugBoundary = undefined;
    sharedState.debugPauseRequested = false;
    sharedState.isCancelled = false;
  }

  return undefined;
}
