import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { SharedState } from '@/backend/execution/flow/types';
import { loadItem as loadItemBackend, saveItem as saveItemBackend } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { processChatCompletion } from '@/app/v1/chat/completions/chatCompletionService'; // Import the main service
import { ChatCompletionRequest } from '@/app/v1/chat/completions/requestParser'; // Import request type
import { flowService } from '@/backend/services/flow/index'; // Import flowService

const log = createLogger('app/v1/chat/conversations/[conversationId]/debug/continue/route');

export async function POST(
  request: NextRequest,
  { params }: { params: { conversationId: string } }
) {
  const conversationId = params.conversationId;
  const requestId = `debug-continue-${Date.now()}`;
  log.info('Handling POST request for debug continue', { requestId, conversationId });

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
      sharedState = await loadItemBackend<SharedState>(storageKey, undefined as any);
      if (sharedState) {
        log.debug(`Loaded state from storage`, { requestId, conversationId });
        FlowExecutor.conversationStates.set(conversationId, sharedState); // Add to memory map
      }
    }

    if (!sharedState) {
      log.warn(`Conversation state not found for debug continue`, { requestId, conversationId });
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    // 2. Check if the state is paused in debug mode (optional, could allow continue from other states too)
    if (sharedState.status !== 'paused_debug') {
      log.warn(`Debug continue requested but conversation status is not 'paused_debug'`, { requestId, conversationId, status: sharedState.status });
      // Allow continuing anyway? Or return error? Let's allow it for flexibility.
      // return NextResponse.json({ error: `Cannot continue, conversation status is '${sharedState.status}'` }, { status: 409 });
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

    // 4. Call processChatCompletion, forcing debug mode OFF for this run
    // Use the original requireApproval setting stored in the state
    const useRequireApproval = sharedState.originalRequireApproval ?? false; // Default to false if not set
    log.info(`Calling processChatCompletion to continue execution`, {
        requestId,
        conversationId,
        flujo: true,
        requireApproval: useRequireApproval,
        flujodebug: false // Force debug off for continue
    });
    const response = await processChatCompletion(
      simulatedRequestData,
      true, // flujo flag (always true for flow execution)
      useRequireApproval, // Use the original setting from the state
      false, // FORCE flujodebug to false for this continuation run
      conversationId // Pass the conversation ID to ensure state is used
    );

    log.info(`Debug continue execution finished. Returning response.`, { requestId, conversationId, status: response.status });

    // 5. Return the response from processChatCompletion
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
     if (FlowExecutor.conversationStates.has(conversationId)) {
        const state = FlowExecutor.conversationStates.get(conversationId)!;
        state.status = 'error';
        const errorMessage = error instanceof Error ? error.message : 'Unknown error during debug continue processing';
        state.lastResponse = { success: false, error: errorMessage };
        FlowExecutor.conversationStates.set(conversationId, state);
        try { await saveItemBackend(storageKey, state); } catch { /* ignore save error */ }
    }
    return NextResponse.json({ error: 'Internal server error during debug continue' }, { status: 500 });
  }
}
