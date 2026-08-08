import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { SharedState } from '@/backend/execution/flow/types';
import { loadItem as loadItemBackend } from '@/utils/storage/backend';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import { StorageKey } from '@/shared/types/storage';
import { listPendingToolCalls, clearPendingApprovals } from '@/backend/execution/flow/toolApprovalRegistry';
import { cancelAllToolCalls } from '@/backend/execution/flow/toolCancelRegistry';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { repairDanglingToolCalls, appendRawForState } from '@/backend/execution/flow/conversationLog';
import { clearSteeringInbox } from '@/backend/execution/flow/steeringInbox';
import { commitRecoveryTransition } from '@/backend/execution/flow/recoveryCheckpoint';

const log = createLogger('app/v1/chat/conversations/[conversationId]/cancel/route');

async function POST_handler(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const _lock = await assertUnlocked({ openai: true });
  if (_lock) return _lock;
  // Defense-in-depth localhost / DNS-rebinding guard (#143).
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  const { conversationId } = await params;
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

    // 3. Durably record the cancellation request BEFORE signalling the live
    // state. The legacy isCancelled flag remains the cooperative abort signal;
    // recovery metadata distinguishes this from provider/tool failure.
    log.info(`Persisting cancellation transition for conversation`, { requestId, conversationId });
    await commitRecoveryTransition(storageKey, sharedState, 'cancelled', {
      failure: {
        category: 'user_cancelled',
        message: 'Execution was cancelled by the user.',
        retryable: false,
      },
      cancellationRequestedAt: Date.now(),
    }, executionEventBus.emitterFor(conversationId));
    log.info(`Setting cancellation flag for conversation`, { requestId, conversationId });
    sharedState.isCancelled = true;

    // Stopping the run also discards any mid-run steering message that has not
    // been folded in yet: the user stopped this run, so a correction aimed at it
    // must not silently resurface at the start of the next one.
    clearSteeringInbox(conversationId);

    // Issue #357: Stop must also interrupt tool calls that are ALREADY in
    // flight — the isCancelled flag alone is only polled before the next call,
    // so a stalling MCP request used to keep the run alive until its timeout.
    const abortedInFlight = cancelAllToolCalls(conversationId);
    if (abortedInFlight > 0) {
      log.info(`Aborted in-flight tool call(s) on cancel`, { requestId, conversationId, abortedInFlight });
    }

    // 3a. In-request agentic approvals (Claude subscription): the run is live,
    // blocked inside canUseTool. Reject every pending call so the adapter
    // unblocks; the run loop then observes isCancelled and terminates itself
    // (emitting its own run:done), so no state finalization is needed here.
    const hadLiveApprovals = listPendingToolCalls(conversationId).length > 0;
    if (hadLiveApprovals) {
      log.info(`Rejecting live in-request tool approvals on cancel`, { requestId, conversationId });
      clearPendingApprovals(conversationId);
    }

    // 3b. Parked runs (pause/resume tool approval, debug pause) have NO live
    // loop that could ever observe the flag — without finalizing here the
    // conversation stays 'awaiting_tool_approval'/'paused_debug' forever and
    // the approval prompt resurrects on the next detail fetch. Mirror the run
    // loop's own cancellation outcome (status 'error' + cancelled message).
    const wasParked =
      !hadLiveApprovals &&
      (sharedState.status === 'awaiting_tool_approval' || sharedState.status === 'paused_debug');
    if (wasParked) {
      log.info(`Finalizing parked conversation on cancel`, { requestId, conversationId, parkedStatus: sharedState.status });
      sharedState.status = 'error';
      sharedState.pendingToolCalls = undefined;
      sharedState.lastResponse = { success: false, error: 'Execution cancelled by user.' };
      // Issue #256: clearing pendingToolCalls leaves the paused assistant
      // tool_calls turn unanswered in the transcript, which every provider 400s
      // on when the conversation is later continued. Synthesize a cancellation
      // result for each dangling call and fold it into the append-only log so
      // the conversation is left well-formed and the repair is auditable.
      try {
        const repaired = repairDanglingToolCalls(sharedState, 'Tool execution cancelled by user before it finished.');
        if (repaired.length) {
          log.info(`Synthesized ${repaired.length} tool result(s) for cancelled parked run`, { requestId, conversationId });
          await appendRawForState(sharedState, repaired.map(m => ({ type: 'message', message: m })));
        }
      } catch (repairError) {
        log.warn(`Failed to synthesize tool results on cancel; continuing`, { requestId, conversationId, repairError });
      }
      sharedState.debugMode = false;
      sharedState.debugPauseRequested = false;
      sharedState.debugResumeAfterDetach = false;
      sharedState.debugPendingAction = undefined;
      sharedState.debugPendingToolCalls = undefined;
      sharedState.breakpoints = [];
      sharedState.lastBreakNodeId = undefined;
    }

    // 4. Save updated state (both memory and storage)
    FlowExecutor.conversationStates.set(conversationId, sharedState); // Update memory map
    try {
      await persistConversationState(storageKey, sharedState); // Save to storage (trace stripped)
      log.info(`Saved updated state after setting cancel flag`, { requestId, conversationId });
    } catch (saveError) {
       log.error(`Failed to save cancelled state`, { requestId, conversationId, saveError });
       // Return error as saving failed, cancellation might not persist
       return NextResponse.json({ error: 'Failed to save cancellation state' }, { status: 500 });
    }

    // 4a. A parked run emits no events on its own, so broadcast the terminal
    // state — this is what flips the sidebar dot and closes any live view
    // (including other clients') without waiting for the next list poll.
    if (wasParked) {
      executionEventBus.emit(conversationId, { type: 'run:done', status: 'error' });
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

export const POST = withWorkspaceRoute(POST_handler);
