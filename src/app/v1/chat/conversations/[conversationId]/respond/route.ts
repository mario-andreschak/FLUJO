import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { SharedState, TOOL_CALL_ACTION } from '@/backend/execution/flow/types';
import { loadItem as loadItemBackend, saveItem as saveItemBackend } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import OpenAI from 'openai';

const log = createLogger('app/v1/chat/conversations/[conversationId]/respond/route');

interface RespondRequestBody {
  action: 'approve' | 'reject';
  toolCallId: string;
}

export async function POST(
  request: NextRequest,
  { params }: { params: { conversationId: string } }
) {
  const { conversationId } = params;
  const requestId = `conv-respond-${Date.now()}`;
  log.info('Handling POST request for conversation response (Approve/Reject)', { requestId, conversationId });

  if (!conversationId) {
    log.warn('Missing conversationId parameter', { requestId });
    return NextResponse.json({ error: 'Missing conversationId parameter' }, { status: 400 });
  }

  let requestBody: RespondRequestBody;
  try {
    requestBody = await request.json();
    if (!requestBody.action || !requestBody.toolCallId || (requestBody.action !== 'approve' && requestBody.action !== 'reject')) {
      throw new Error('Invalid request body. Required fields: action ("approve" or "reject"), toolCallId (string)');
    }
  } catch (error) {
    log.warn('Invalid request body', { requestId, error: error instanceof Error ? error.message : error });
    return NextResponse.json({ error: 'Invalid request body', details: error instanceof Error ? error.message : 'Unknown error' }, { status: 400 });
  }

  const { action, toolCallId } = requestBody;
  log.info(`Processing response action`, { requestId, conversationId, action, toolCallId });

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
          FlowExecutor.conversationStates.set(conversationId, sharedState); // Add to memory map
        }
      } catch (storageError) {
        log.warn(`Error loading state from storage`, { requestId, conversationId, error: storageError });
        // Proceed, maybe state just doesn't exist
      }
    }

    // 2. Validate state
    if (!sharedState) {
      log.warn(`Conversation state not found`, { requestId, conversationId });
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    if (sharedState.status !== 'awaiting_tool_approval' || !sharedState.pendingToolCalls) {
      log.warn(`Conversation is not awaiting tool approval`, { requestId, conversationId, status: sharedState.status });
      return NextResponse.json({ error: 'Conversation is not awaiting tool approval' }, { status: 400 });
    }

    const toolCallToProcess = sharedState.pendingToolCalls.find(tc => tc.id === toolCallId);
    if (!toolCallToProcess) {
      log.warn(`Pending tool call not found`, { requestId, conversationId, toolCallId });
      return NextResponse.json({ error: `Pending tool call with ID ${toolCallId} not found` }, { status: 404 });
    }

    // 3. Process action
    if (action === 'approve') {
      log.info(`Approving tool call`, { requestId, conversationId, toolCallId });
      // Process *only* the approved tool call
      const toolProcessingResult = await ModelHandler.processToolCalls({ toolCalls: [toolCallToProcess] });

      if (!toolProcessingResult.success) {
        log.error(`Internal tool processing failed after approval`, { requestId, conversationId, toolCallId, error: toolProcessingResult.error });
        // Add an error message to the chat? Or just fail the request? Let's add a message.
        const errorMessage: OpenAI.ChatCompletionToolMessageParam = {
          role: 'tool',
          tool_call_id: toolCallId,
          content: `Error processing approved tool call ${toolCallToProcess.function.name}: ${toolProcessingResult.error?.message || 'Unknown error'}`,
        };
        sharedState.messages.push(errorMessage);
        // Keep state as 'awaiting_tool_approval' but remove the failed call? Or mark as error?
        // Let's remove the call and stay awaiting for others, or transition if it was the last one.
        sharedState.pendingToolCalls = sharedState.pendingToolCalls.filter(tc => tc.id !== toolCallId);
        if (sharedState.pendingToolCalls.length === 0) {
           sharedState.status = 'running'; // Or maybe 'error'? Let's try 'running'
           sharedState.pendingToolCalls = undefined;
        }

      } else {
        // Add tool result message(s)
        log.info(`Adding ${toolProcessingResult.value.toolCallMessages.length} tool result message(s) after approval`, { requestId, conversationId });
        sharedState.messages.push(...toolProcessingResult.value.toolCallMessages);
        // Remove the processed tool call from pending list
        sharedState.pendingToolCalls = sharedState.pendingToolCalls.filter(tc => tc.id !== toolCallId);
      }

    } else { // action === 'reject'
      log.info(`Rejecting tool call`, { requestId, conversationId, toolCallId });
      // Create a tool message indicating rejection
      const rejectionMessage: OpenAI.ChatCompletionToolMessageParam = {
        role: 'tool',
        tool_call_id: toolCallId,
        content: `User rejected tool call: ${toolCallToProcess.function.name}`,
      };
      sharedState.messages.push(rejectionMessage);
      // Remove the rejected tool call from pending list
      sharedState.pendingToolCalls = sharedState.pendingToolCalls.filter(tc => tc.id !== toolCallId);
    }

    // 4. Update state status if no more pending calls
    if (sharedState.pendingToolCalls && sharedState.pendingToolCalls.length === 0) {
      log.info(`No more pending tool calls, resuming execution`, { requestId, conversationId });
      sharedState.status = 'running'; // Set status back to running
      sharedState.pendingToolCalls = undefined; // Clear the array
    } else {
       log.debug(`Still pending tool calls`, { requestId, conversationId, count: sharedState.pendingToolCalls?.length });
    }

    // 5. Save updated state
    sharedState.lastResponse = undefined; // Clear last response before potentially resuming
    FlowExecutor.conversationStates.set(conversationId, sharedState); // Update memory map
    await saveItemBackend(storageKey, sharedState); // Save to storage
    log.info(`Saved updated state after processing tool response`, { requestId, conversationId, newStatus: sharedState.status });

    // 6. Return success
    // The frontend will restart polling by setting isLoading=true
    return NextResponse.json({ success: true, status: sharedState.status });

  } catch (error) {
    log.error('Error processing tool response action', {
      requestId,
      conversationId,
      action,
      toolCallId,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error
    });
    return NextResponse.json({ error: 'Internal server error processing tool response' }, { status: 500 });
  }
}
