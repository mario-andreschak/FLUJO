import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { SharedState } from '@/backend/execution/flow/types';
import { loadItem as loadItemBackend, saveItem as saveItemBackend } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { processChatCompletion } from '@/app/v1/chat/completions/chatCompletionService';
import { ChatCompletionRequest } from '@/app/v1/chat/completions/requestParser';
import { flowService } from '@/backend/services/flow/index';

const log = createLogger('app/v1/chat/conversations/[conversationId]/debug/step/route');

export async function POST(
  request: NextRequest,
  { params }: { params: { conversationId: string } }
) {
  const conversationId = params.conversationId;
  const requestId = `debug-step-${Date.now()}`;
  log.info('Handling POST request for debug step', { requestId, conversationId });

  if (!conversationId) {
    log.warn('Missing conversationId parameter', { requestId });
    return NextResponse.json({ error: 'Missing conversationId parameter' }, { status: 400 });
  }

  const storageKey = `conversations/${conversationId}` as StorageKey;

  try {
    // 1. Load state (prioritize memory, then storage)
    let sharedState: SharedState | undefined = undefined;
    if (FlowExecutor.conversationStates.has(conversationId)) {
      sharedState = FlowExecutor.conversationStates.get(conversationId)!;
      log.debug(`Loaded state from memory`, { requestId, conversationId });
    } else {
      try {
        sharedState = await loadItemBackend<SharedState>(storageKey, undefined as any);
        if (sharedState) {
          log.debug(`Loaded state from storage`, { requestId, conversationId });
          FlowExecutor.conversationStates.set(conversationId, sharedState); // Add to memory map
        }
      } catch (loadError) {
        log.error(`Error loading state from storage for debug step`, { requestId, conversationId, loadError });
      }
    }

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
      sharedState.originalRequireApproval ?? false,
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
      try { await saveItemBackend(storageKey, state); } catch { /* ignore save error */ }
    }
    return NextResponse.json({ error: 'Internal server error during debug step' }, { status: 500 });
  }
}
