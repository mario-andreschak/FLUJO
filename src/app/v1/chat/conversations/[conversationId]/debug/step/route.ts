import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { SharedState, ERROR_ACTION, FINAL_RESPONSE_ACTION } from '@/backend/execution/flow/types';
import { loadItem as loadItemBackend, saveItem as saveItemBackend } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';

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
    let stateSource: 'memory' | 'storage' | 'not_found' = 'not_found'; // Track source

    if (FlowExecutor.conversationStates.has(conversationId)) {
      sharedState = FlowExecutor.conversationStates.get(conversationId)!;
      stateSource = 'memory';
      log.debug(`Loaded state from memory`, { requestId, conversationId });
    } else {
      try {
          sharedState = await loadItemBackend<SharedState>(storageKey, undefined as any);
          if (sharedState) {
            stateSource = 'storage';
            log.debug(`Loaded state from storage`, { requestId, conversationId });
            FlowExecutor.conversationStates.set(conversationId, sharedState); // Add to memory map
          } else {
             log.info(`State not found in storage`, { requestId, conversationId });
          }
      } catch (loadError) {
          log.error(`Error loading state from storage for debug step`, { requestId, conversationId, loadError });
          // Proceed to check if state is undefined below
      }
    }

    // This check is now redundant due to the one below, removing duplication.
    // if (!sharedState) {
    //   log.warn(`Conversation state not found for debug step (source: ${stateSource})`, { requestId, conversationId });
    //   return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    // }

    // Log current state details before stepping (Moved this check down after the main !sharedState check)
    // log.debug("State details before debug step", {
    //     requestId,
    //     conversationId,
    //     status: sharedState.status,
    //     currentNodeId: sharedState.currentNodeId,
    //     traceLength: sharedState.executionTrace?.length || 0
    // });

    // 2. Check if the state is actually paused in debug mode
        // This block was duplicated, removing it.
    //     FlowExecutor.conversationStates.set(conversationId, sharedState); // Add to memory map
    //   }
    // }

    if (!sharedState) {
      log.warn(`Conversation state not found for debug step (source: ${stateSource})`, { requestId, conversationId }); // Keep the primary check
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

     // Log current state details before stepping (Moved here)
    log.debug("State details before debug step", {
        requestId,
        conversationId,
        status: sharedState.status,
        currentNodeId: sharedState.currentNodeId,
        traceLength: sharedState.executionTrace?.length || 0
    });


    // 2. Check if the state is actually paused in debug mode
    if (sharedState.status !== 'paused_debug') {
      log.warn(`Debug step requested but conversation status is not 'paused_debug'`, { requestId, conversationId, status: sharedState.status });
      // Return current state without stepping? Or return error? Let's return error for now.
      return NextResponse.json({ error: `Cannot step, conversation status is '${sharedState.status}'` }, { status: 409 }); // 409 Conflict
    }

    // 3. Execute one step
    log.info(`Executing debug step for conversation`, { requestId, conversationId, currentNodeId: sharedState.currentNodeId });
    const stepResult = await FlowExecutor.executeStep(sharedState);
    sharedState = stepResult.sharedState; // Update state reference
    const currentAction = stepResult.action;

    // 4. Update status based on action
    if (currentAction !== ERROR_ACTION && currentAction !== FINAL_RESPONSE_ACTION) {
      sharedState.status = 'paused_debug'; // Remain paused
    } else if (currentAction === FINAL_RESPONSE_ACTION) {
      sharedState.status = 'completed'; // Flow finished
    } else {
      sharedState.status = 'error'; // Step resulted in error
    }
    log.info(`Debug step executed. Action: ${currentAction}, New Status: ${sharedState.status}`, { requestId, conversationId });

    // 5. Save updated state (memory map already updated by executeStep)
    try {
      sharedState.updatedAt = Date.now();
      // Title update logic (optional, but good practice)
      if (sharedState.title === 'New Conversation' && sharedState.messages.length > 0) {
          const firstUserMessage = sharedState.messages.find(m => m.role === 'user');
          if (firstUserMessage && typeof firstUserMessage.content === 'string') {
              sharedState.title = firstUserMessage.content.split(' ').slice(0, 5).join(' ') + '...';
          }
      }
      await saveItemBackend(storageKey, sharedState);
      log.debug(`Saved state after debug step`, { requestId, conversationId });
    } catch (saveError) {
      log.error(`Failed to save state after debug step`, { requestId, conversationId, saveError });
      // Continue, but log the error
    }

    // 6. Return the updated state
    return NextResponse.json({
      status: sharedState.status,
      conversation_id: sharedState.conversationId,
      debugState: sharedState // Return the full state
    });

  } catch (error) {
    log.error('Error during debug step execution', {
      requestId,
      conversationId,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error)
    });
    // Attempt to update state with error status if possible
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
