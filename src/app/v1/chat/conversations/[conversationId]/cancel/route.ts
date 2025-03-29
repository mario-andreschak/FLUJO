import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { SharedState } from '@/backend/execution/flow/types';
import { loadItem as loadItemBackend, saveItem as saveItemBackend } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';

const log = createLogger('app/v1/chat/conversations/[conversationId]/cancel/route');

export async function POST(
  request: NextRequest,
  { params }: { params: { conversationId: string } }
) {
  const { conversationId } = params;
  const requestId = `conv-cancel-${Date.now()}`;
  log.info('Handling POST request to cancel conversation execution', { requestId, conversationId });

  if (!conversationId) {
    log.warn('Missing conversationId parameter', { requestId });
    return NextResponse.json({ error: 'Missing conversationId parameter' }, { status: 400 });
  }

  try {
    let sharedState: SharedState | undefined = undefined;
    const storageKey = `conversations/${conversationId}` as StorageKey;

    // 1. Load state (prefer memory, fallback to storage)
    if (FlowExecutor.conversationStates.has(conversationId)) {
      sharedState = FlowExecutor.conversationStates.get(conversationId);
      log.debug(`Loaded state from memory`, { requestId, conversationId });
    } else {
      try {
        sharedState = await loadItemBackend<SharedState>(storageKey, undefined as any);
        if (sharedState) {
          log.debug(`Loaded state from storage`, { requestId, conversationId });
          // Add to memory map if loaded from storage, so the flag is checked
          FlowExecutor.conversationStates.set(conversationId, sharedState);
        }
      } catch (storageError) {
        log.warn(`Error loading state from storage for cancellation`, { requestId, conversationId, error: storageError });
        // If we can't load state, we can't cancel, but maybe return success anyway?
        // Let's return an error for clarity.
        return NextResponse.json({ error: 'Failed to load conversation state for cancellation' }, { status: 500 });
      }
    }

    // 2. Check if state exists
    if (!sharedState) {
      log.warn(`Conversation state not found for cancellation`, { requestId, conversationId });
      // If the conversation doesn't exist, cancellation is technically successful (it's not running)
      return NextResponse.json({ success: true, message: 'Conversation not found, assumed cancelled.' });
    }

    // 3. Set the cancellation flag
    log.info(`Setting cancellation flag for conversation`, { requestId, conversationId });
    sharedState.isCancelled = true;
    // Optionally update status if needed, e.g., sharedState.status = 'error'; sharedState.lastResponse = { success: false, error: 'Cancelled by user' };

    // 4. Save updated state (both memory and storage)
    FlowExecutor.conversationStates.set(conversationId, sharedState); // Update memory map
    try {
      await saveItemBackend(storageKey, sharedState); // Save to storage
      log.info(`Saved updated state after setting cancel flag`, { requestId, conversationId });
    } catch (saveError) {
       log.error(`Failed to save cancelled state`, { requestId, conversationId, saveError });
       // Return error as saving failed, cancellation might not persist
       return NextResponse.json({ error: 'Failed to save cancellation state' }, { status: 500 });
    }

    // 5. Return success
    return NextResponse.json({ success: true, message: 'Cancellation request processed.' });

  } catch (error) {
    log.error('Error processing cancellation request', {
      requestId,
      conversationId,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error
    });
    return NextResponse.json({ error: 'Internal server error processing cancellation' }, { status: 500 });
  }
}
