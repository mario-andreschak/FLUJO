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
import { processChatCompletion } from '@/app/v1/chat/completions/chatCompletionService';
import { ChatCompletionRequest } from '@/app/v1/chat/completions/requestParser';
import { flowService } from '@/backend/services/flow/index';
import { normalizeChatError } from '@/backend/execution/flow/normalizeError';
import { resumePersonaFlowDispatch } from '@/backend/services/enduringAgents/personaDispatcher';

const log = createLogger('app/v1/chat/conversations/[conversationId]/debug/step/route');

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
  const requestId = `debug-step-${Date.now()}`;
  log.info('Handling POST request for debug step', { requestId, conversationId });

  if (!conversationId) {
    log.warn('Missing conversationId parameter', { requestId });
    return NextResponse.json({ error: 'Missing conversationId parameter' }, { status: 400 });
  }

  const storageKey = `conversations/${conversationId}` as StorageKey;

  try {
    // 1. Load state (prioritize memory, then storage)
    const sharedState = await loadConversationState(conversationId);

    if (!sharedState) {
      log.warn(`Conversation state not found for debug step`, { requestId, conversationId });
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    if (isPersonaOwnedConversationState(sharedState)) {
      const notLoopback = assertLocalRequest(request);
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

    // 2. Must be paused in debug mode to step.
    if (sharedState.status !== 'paused_debug') {
      log.warn(`Debug step requested but conversation status is not 'paused_debug'`, { requestId, conversationId, status: sharedState.status });
      return NextResponse.json({ error: `Cannot step, conversation status is '${sharedState.status}'` }, { status: 409 });
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
          debug: true,
          continueDebug: false,
          userTurn: false,
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

    // 3. Reconstruct the model name from the flow (SharedState doesn't store it).
    const flow = await flowService.getFlow(sharedState.flowId);
    if (!flow) {
      log.error(`Flow definition not found for flowId ${sharedState.flowId}`, { requestId, conversationId });
      return NextResponse.json({ error: `Flow definition not found for ID ${sharedState.flowId}` }, { status: 500 });
    }

    const simulatedRequestData: ChatCompletionRequest = {
      model: `flow-${flow.name}`,
      messages: sharedState.messages,
    };

    // 4. Run exactly one debugger-safe boundary. A Process-node model turn
    // pauses after its completed narration/arguments and before its action;
    // the next step consumes that saved action without invoking the model again.
    // Non-model nodes still advance through their graph transition in one step.
    log.info(`Executing debug step via processChatCompletion`, { requestId, conversationId, currentNodeId: sharedState.currentNodeId });
    const response = await processChatCompletion(
      simulatedRequestData,
      true, // flujo
      sharedState.requireApproval ?? false,
      false, // flujodebug param ignored on resume (debugMode already set in state)
      conversationId,
      false // continueDebug: false → single step then pause
    );

    log.info(`Debug step finished. Returning response.`, { requestId, conversationId, status: response.status });
    return response;

  } catch (error) {
    log.error('Error during debug step execution', {
      requestId,
      conversationId,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error)
    });
    if (
      FlowExecutor.conversationStates.has(conversationId)
      && !isPersonaOwnedConversationState(FlowExecutor.conversationStates.get(conversationId))
    ) {
      const state = FlowExecutor.conversationStates.get(conversationId)!;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error during debug step processing';
      state.status = 'error';
      state.lastResponse = { success: false, error: errorMessage };
      // Issue #383: keep lastError in sync for this route-level failure.
      state.lastError = normalizeChatError(error);
      FlowExecutor.conversationStates.set(conversationId, state);
      try { await persistConversationState(storageKey, state); } catch { /* ignore save error */ }
    }
    return NextResponse.json({ error: 'Internal server error during debug step' }, { status: 500 });
  }
}

export const POST = withWorkspaceRoute(POST_handler);
