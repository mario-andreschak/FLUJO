import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { isPersonaOwnedConversationState } from '@/backend/execution/flow/personaConversationOwnership';
import { StorageKey } from '@/shared/types/storage';
import { processChatCompletion } from '@/app/v1/chat/completions/chatCompletionService'; // Import the main service
import { ChatCompletionRequest } from '@/app/v1/chat/completions/requestParser'; // Import request type
import { flowService } from '@/backend/services/flow/index'; // Import flowService
import { normalizeChatError } from '@/backend/execution/flow/normalizeError';
import { resumePersonaFlowDispatch } from '@/backend/services/enduringAgents/personaDispatcher';

const log = createLogger('app/v1/chat/conversations/[conversationId]/debug/continue/route');

async function POST_handler(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const _lock = await assertUnlocked({ openai: true });
  if (_lock) return _lock;
  // Defense-in-depth localhost / DNS-rebinding guard (#143).
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  const conversationId = (await params).conversationId;
  const requestId = `debug-continue-${Date.now()}`;
  log.info('Handling POST request for debug continue', { requestId, conversationId });

  if (!conversationId) {
    log.warn('Missing conversationId parameter', { requestId });
    return NextResponse.json({ error: 'Missing conversationId parameter' }, { status: 400 });
  }

  const storageKey = `conversations/${conversationId}` as StorageKey;

  try {
    // 1. Load state (prioritize memory, then storage)
    const sharedState = await loadConversationState(conversationId);

    if (!sharedState) {
      log.warn(`Conversation state not found for debug continue`, { requestId, conversationId });
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    if (isPersonaOwnedConversationState(sharedState)) {
      const notLoopback = assertLocalRequest(request, { strictLoopback: true });
      if (notLoopback) return notLoopback;
    }
    if (sharedState.personaArchived) {
      return NextResponse.json(
        { error: 'An anonymized Persona archive cannot be resumed.' },
        { status: 409 },
      );
    }
    if (isPersonaOwnedConversationState(sharedState) && !sharedState.personaAttribution) {
      return NextResponse.json({
        error: 'Persona conversation attribution is incomplete; refusing an unfenced resume.',
      }, { status: 409 });
    }

    // 2. Continue is also "leave the debugger". Only a parked debugger run has
    // something meaningful to continue; accepting this on arbitrary states can
    // accidentally start a second execution for an already-running conversation.
    if (sharedState.status !== 'paused_debug') {
      log.warn(`Debug continue requested but conversation status is not 'paused_debug'`, { requestId, conversationId, status: sharedState.status });
      return NextResponse.json({ error: `Cannot continue, conversation status is '${sharedState.status}'` }, { status: 409 });
    }

    if (sharedState.personaAttribution) {
      const { personaId, activityId, behaviorRevisionId } = sharedState.personaAttribution;
      if (!activityId || !behaviorRevisionId) {
        return NextResponse.json({
          error: 'Persona conversation attribution is incomplete; refusing an unfenced resume.',
        }, { status: 409 });
      }
      const dispatch = await resumePersonaFlowDispatch({
        personaId,
        activityId,
        behaviorRevisionId,
        conversationId,
        reason: 'debug',
        flowInputPatch: {
          messages: sharedState.messages,
          requireApproval: sharedState.requireApproval ?? false,
          debug: false,
          continueDebug: true,
          userTurn: false,
        },
        prepare: async ({ installExecutionAuthority }) => {
          installExecutionAuthority(sharedState);
          sharedState.debugMode = false;
          sharedState.debugPauseRequested = false;
          sharedState.breakpoints = [];
          sharedState.lastBreakNodeId = undefined;
          sharedState.status = 'running';
          sharedState.debugResumeAfterDetach = true;
          FlowExecutor.conversationStates.set(conversationId, sharedState);
          await persistConversationState(storageKey, sharedState);
          return 'resume' as const;
        },
      });
      const state = await loadConversationState(conversationId);
      if (dispatch.state === 'error' || dispatch.state === 'cancelled') {
        return NextResponse.json({
          error: dispatch.error?.message ?? `Persona dispatch ended in ${dispatch.state}.`,
          code: dispatch.error?.code ?? `persona_dispatch_${dispatch.state}`,
          dispatch_id: dispatch.id,
        }, { status: dispatch.state === 'cancelled' ? 409 : 500 });
      }
      return NextResponse.json({
        status: state?.status ?? dispatch.outcome?.status ?? dispatch.state,
        conversation_id: conversationId,
        ...(state?.status === 'paused_debug' ? { debugState: state } : {}),
        pendingToolCalls: state?.pendingToolCalls,
        messages: state?.messages,
        dispatch_id: dispatch.id,
      }, { status: dispatch.state === 'queued' || dispatch.state === 'running' ? 202 : 200 });
    }

    // 3. Prepare data for processChatCompletion
    // We need to simulate a ChatCompletionRequest. We'll use the existing messages
    // and flow information from the sharedState.
    // We need the original model name (e.g., "flow-MyFlow") which isn't directly in SharedState.
    // We might need to load the flow definition to get the name.
    // For now, let's assume we can reconstruct it or find a way to pass it.
    // TODO: Refine how model name is retrieved if needed. Maybe store it in SharedState?
    const flow = await flowService.getFlow(sharedState.flowId);
    if (!flow) {
        log.error(`Flow definition not found for flowId ${sharedState.flowId}`, { requestId, conversationId });
        return NextResponse.json({ error: `Flow definition not found for ID ${sharedState.flowId}` }, { status: 500 });
    }
    const modelName = `flow-${flow.name}`; // Reconstruct model name

    const simulatedRequestData: ChatCompletionRequest = {
        model: modelName,
        messages: sharedState.messages, // Use current messages
        // Other parameters like temperature etc., are not relevant for continuation
    };

    // 4. Atomically detach before resuming. "Continue" means leave debugging,
    // not "run freely but keep an invisible debug session alive". Preserve the
    // pending action/tool batch: runFlow consumes it exactly once on resume.
    sharedState.debugMode = false;
    sharedState.debugPauseRequested = false;
    sharedState.breakpoints = [];
    sharedState.lastBreakNodeId = undefined;
    sharedState.status = 'running';
    sharedState.debugResumeAfterDetach = true;
    FlowExecutor.conversationStates.set(conversationId, sharedState);
    await persistConversationState(storageKey, sharedState);

    // 5. Call processChatCompletion with debugger stepping disabled.
    // Use the conversation's persisted requireApproval setting.
    const useRequireApproval = sharedState.requireApproval ?? false; // Default to false if not set
    log.info(`Calling processChatCompletion to continue execution`, {
        requestId,
        conversationId,
        flujo: true,
        requireApproval: useRequireApproval,
        continueDebug: true
    });
    const response = await processChatCompletion(
      simulatedRequestData,
      true, // flujo flag (always true for flow execution)
      useRequireApproval, // Use the original setting from the state
      false, // flujodebug param is only consulted for NEW states; ignored on resume
      conversationId, // Pass the conversation ID to ensure state is used
      true // continueDebug: do not single-step any legacy state during detach
    );

    log.info(`Debug continue execution finished. Returning response.`, { requestId, conversationId, status: response.status });

    // 6. Return the response from processChatCompletion
    // This response will reflect the next natural stop point (tool call, final response, error).
    // The state (including trace) would have been updated and saved by processChatCompletion.
    return response;

  } catch (error) {
    log.error('Error during debug continue execution', {
      requestId,
      conversationId,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error)
    });
    // Attempt to update state with error status if possible
     if (
       FlowExecutor.conversationStates.has(conversationId)
       && !isPersonaOwnedConversationState(FlowExecutor.conversationStates.get(conversationId))
     ) {
        const state = FlowExecutor.conversationStates.get(conversationId)!;
        state.status = 'error';
        const errorMessage = error instanceof Error ? error.message : 'Unknown error during debug continue processing';
        state.lastResponse = { success: false, error: errorMessage };
        // Issue #383: keep lastError in sync so the GET route / summary can
        // serve a message + code for this route-level (outside-runFlow) failure.
        state.lastError = normalizeChatError(error);
        FlowExecutor.conversationStates.set(conversationId, state);
        try { await persistConversationState(storageKey, state); } catch { /* ignore save error */ }
    }
    return NextResponse.json({ error: 'Internal server error during debug continue' }, { status: 500 });
  }
}

export const POST = withWorkspaceRoute(POST_handler);
