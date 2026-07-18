import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { StorageKey } from '@/shared/types/storage';
import { processChatCompletion } from '@/app/v1/chat/completions/chatCompletionService';
import { ChatCompletionRequest } from '@/app/v1/chat/completions/requestParser';
import { flowService } from '@/backend/services/flow/index';

const log = createLogger('app/v1/chat/conversations/[conversationId]/debug/step/route');

export async function POST(
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

    // 2. Must be paused in debug mode to step.
    if (sharedState.status !== 'paused_debug') {
      log.warn(`Debug step requested but conversation status is not 'paused_debug'`, { requestId, conversationId, status: sharedState.status });
      return NextResponse.json({ error: `Cannot step, conversation status is '${sharedState.status}'` }, { status: 409 });
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

    // 4. Run exactly one productive step. Because the conversation is in debug
    // mode (debugMode true) and continueDebug is left false, processChatCompletion
    // executes one node, processes its action (handoff/tool/etc.) so currentNodeId
    // actually advances, and then pauses (status back to paused_debug). This is
    // the fix for the old behavior, which ran the node but never resolved its
    // action — leaving execution stuck on the same node every step.
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
    if (FlowExecutor.conversationStates.has(conversationId)) {
      const state = FlowExecutor.conversationStates.get(conversationId)!;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error during debug step processing';
      state.status = 'error';
      state.lastResponse = { success: false, error: errorMessage };
      FlowExecutor.conversationStates.set(conversationId, state);
      try { await persistConversationState(storageKey, state); } catch { /* ignore save error */ }
    }
    return NextResponse.json({ error: 'Internal server error during debug step' }, { status: 500 });
  }
}
