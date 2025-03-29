import { NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { ChatCompletionRequest } from './requestParser';
import { FlowExecutionResponse, ErrorResult, SuccessResult } from '@/shared/types/flow/response';
import OpenAI from 'openai';
import { SharedState, TOOL_CALL_ACTION, FINAL_RESPONSE_ACTION, ERROR_ACTION, STAY_ON_NODE_ACTION, ErrorDetails } from '@/backend/execution/flow/types'; // Import types and actions
import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler'; // Import ModelHandler
import { BaseNode, Flow as PocketFlow } from '@/backend/execution/flow/temp_pocket'; // Use Flow as PocketFlow
// Import the flowService instance and the FlowService class type directly
import { flowService } from '@/backend/services/flow/index';
import type { FlowService as FlowServiceType } from '@/backend/services/flow/index'; // Use 'type' import for the class
import { Flow } from '@/shared/types/flow'; // Import Flow type
// Import backend storage functions directly
import { loadItem as loadItemBackend, saveItem as saveItemBackend } from '@/utils/storage/backend'; 
import { StorageKey } from '@/shared/types/storage'; // Import StorageKey

const log = createLogger('app/v1/chat/completions/chatCompletionService');

// Simple token counter (approximation) - Keep as is
export function countTokens(text: string): number {
  const tokenCount = Math.ceil((text || '').length / 4);
  return tokenCount;
}

// Using OpenAI's type for token usage - Keep as is
export type TokenUsage = OpenAI.CompletionUsage;

// isRetryableError - Keep as is
export function isRetryableError(error: any): boolean {
  log.debug('Checking if error is retryable', { errorType: typeof error, status: error.status, code: error.code, message: error.message });
  if (error.status === 429) return true;
  if (error.status >= 500 && error.status < 600) return true;
  if (error.message?.includes('timeout') || error.code === 'ETIMEDOUT') return true;
  if (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET') return true;
  log.debug('Error is not retryable', { error });
  return false;
}

// --- Add getFlowByName to flowService if it doesn't exist ---
// Use a simpler approach by directly assigning to the service object (accepting 'any' temporarily)
if (!(flowService as any).getFlowByName) {
  (flowService as any).getFlowByName = async (name: string): Promise<Flow | null> => {
    const flows = await flowService.loadFlows(); // Use the existing instance
    return flows.find(flow => flow.name === name) || null;
  };
  log.info("Added getFlowByName method directly to flowService instance.");
}
// Type assertion for usage within this file, assuming the method now exists
const flowServiceWithGetByName = flowService as FlowServiceType & { getFlowByName: (name: string) => Promise<Flow | null> };


// Process chat completion request with the new step-by-step logic
export async function processChatCompletion(
  data: ChatCompletionRequest,
  flujo: boolean, // Add flujo flag
  conversationId?: string // Add optional conversationId
) {
  const startTime = Date.now();
  const requestId = `proc-${Date.now()}`;
  log.info('Processing chat completion request', {
    requestId,
    model: data.model,
    messageCount: data.messages?.length || 0,
    stream: data.stream, // Note: Streaming logic needs separate adaptation later
    flujo,
    conversationId
  });

  // --- 1. Initialize or Retrieve State ---
  let sharedState: SharedState | undefined = undefined; // Initialize as undefined
  const convId = conversationId || crypto.randomUUID(); // Use provided ID or generate new
  const storageKey = `conversations/${convId}` as StorageKey; // Define storage key
  let stateSource: 'storage' | 'memory' | 'new' = 'new'; // Track where state came from

  // Try loading from storage first if conversationId is provided
  if (conversationId) {
    try {
      sharedState = await loadItemBackend<SharedState>(storageKey, undefined as any); // Load or get undefined
      if (sharedState) {
        log.info(`Loaded conversation state from storage: ${conversationId}`);
        stateSource = 'storage';
        // Update the in-memory map as well
        FlowExecutor.conversationStates.set(conversationId, sharedState); 
      } else {
        log.info(`No state found in storage for conversation: ${conversationId}. Will check memory.`);
      }
    } catch (error) {
      log.warn(`Error loading conversation state from storage for ${conversationId}:`, error);
      // Proceed to check in-memory map or create new state
    }
  }

  // If not loaded from storage, check in-memory map
  if (!sharedState && conversationId && FlowExecutor.conversationStates.has(conversationId)) {
    // Resume existing conversation from memory
    sharedState = FlowExecutor.conversationStates.get(conversationId)!;
    log.info(`Resuming conversation ${conversationId} from memory`, { currentNodeId: sharedState.currentNodeId });
    stateSource = 'memory';
  } 
  
  // If still no state after checking storage and memory, create a new one
  if (!sharedState) {
    stateSource = 'new';
    log.info(`Creating new conversation ${convId}`);
    const flowName = data.model.substring(5); // Assumes "flow-FlowName" format
    const reactFlow = await flowServiceWithGetByName.getFlowByName(flowName);
    if (!reactFlow) {
      log.error(`Flow not found: ${flowName}`);
      return NextResponse.json({ error: { message: `Flow not found: ${flowName}`, type: 'invalid_request_error', code: 'flow_not_found' } }, { status: 400 });
    }

    sharedState = {
      trackingInfo: { executionId: crypto.randomUUID(), startTime: Date.now(), nodeExecutionTracker: [] },
      messages: data.messages || [], // Start with messages from the request
      flowId: reactFlow.id,
      conversationId: convId,
      currentNodeId: undefined // Start from the beginning
      // lastResponse, mcpContext, handoffRequested will be populated during execution
    };
    // Save the newly created state immediately
    try {
      await saveItemBackend(storageKey, sharedState);
      log.info(`Saved initial state for new conversation ${convId} to storage.`);
    } catch (error) {
      log.error(`Failed to save initial state for new conversation ${convId}:`, error);
      // Decide if this is a critical error - maybe return 500? For now, log and continue.
    }
    FlowExecutor.conversationStates.set(convId, sharedState); // Also keep in memory
  }

  // If state was loaded or resumed, handle potential updates (like adding new messages)
  if (stateSource === 'storage' || stateSource === 'memory') {
      // Check for ID mismatch (if loaded from storage with a different ID than requested)
      if (sharedState.conversationId !== convId) {
         log.warn(`Mismatch between requested convId (${conversationId}) and actual state convId (${sharedState.conversationId}). Using actual state ID.`);
         // It's generally safer to trust the ID within the loaded state.
         // The storageKey used for saving later should ideally use sharedState.conversationId
      }

      // Add new messages from the current request to the existing state
      if (data.messages && data.messages.length > 0) {
        const lastRequestMessage = data.messages[data.messages.length - 1];
        const lastStateMessage = sharedState.messages.length > 0 ? sharedState.messages[sharedState.messages.length - 1] : null;

        // Add user message if it's new
        if (lastRequestMessage.role === 'user') {
          if (!lastStateMessage || lastStateMessage.role !== 'user' || lastStateMessage.content !== lastRequestMessage.content) {
            log.info(`Adding new user message to conversation ${sharedState.conversationId}`);
            sharedState.messages.push(lastRequestMessage);
          } else {
            log.debug(`Duplicate user message detected for conv ${sharedState.conversationId}, skipping add.`);
          }
        }
        // Add tool response if it's provided
        else if (lastRequestMessage.role === 'tool') {
           // Simple check: add if the last message isn't an identical tool response
           if (!lastStateMessage || lastStateMessage.role !== 'tool' || lastStateMessage.tool_call_id !== lastRequestMessage.tool_call_id || lastStateMessage.content !== lastRequestMessage.content) {
              log.info(`Adding new tool response message to conversation ${sharedState.conversationId}`);
              sharedState.messages.push(lastRequestMessage);
           } else {
              log.debug(`Duplicate tool response detected for conv ${sharedState.conversationId}, skipping add.`);
           }
        }
      }
  }

  // --- 2. Main Execution Loop ---
  let currentAction: string | undefined = undefined;
  const MAX_INTERNAL_ITERATIONS = 15; // Safety break for flujo=true loop
  let internalIterations = 0;

  try {
    while (internalIterations < MAX_INTERNAL_ITERATIONS) {
      internalIterations++;
      log.info(`--- Starting Execution Step ${internalIterations} for Conv ${convId} ---`);

      // 2a. Execute one step of the flow
      const stepResult = await FlowExecutor.executeStep(sharedState);
      sharedState = stepResult.sharedState; // Update state with results from the step
      currentAction = stepResult.action;
      
      // Save state after each step
      try {
        await saveItemBackend(storageKey, sharedState);
        log.debug(`Saved state after step ${internalIterations} for conv ${convId}`);
      } catch (error) {
        log.error(`Failed to save state after step ${internalIterations} for conv ${convId}:`, error);
      }

      log.info(`Step ${internalIterations} completed for conv ${convId}. Action: ${currentAction}`, { currentNodeId: sharedState.currentNodeId });
      log.verbose(`Shared state after step ${internalIterations}`, JSON.stringify(sharedState));


      // 2b. Handle the action returned by the step
      if (currentAction === ERROR_ACTION) {
        log.error(`Error action received during step ${internalIterations} for conv ${convId}`, { error: sharedState.lastResponse });
        break; // Exit loop to return error
      }

      if (currentAction === FINAL_RESPONSE_ACTION) {
        log.info(`Final response action received at step ${internalIterations} for conv ${convId}`);
        break; // Exit loop to return final response
      }

      if (currentAction === TOOL_CALL_ACTION) {
        log.info(`Tool call action received at step ${internalIterations} for conv ${convId}`);
        const lastAssistantMsg = sharedState.messages.length > 0 ? sharedState.messages[sharedState.messages.length - 1] : null;

        if (lastAssistantMsg?.role === 'assistant' && lastAssistantMsg.tool_calls) {
          if (flujo) {
            // Process tools internally and continue loop
            log.info(`[flujo=true] Processing ${lastAssistantMsg.tool_calls.length} tools internally for conv ${convId}`);
            const toolProcessingResult = await ModelHandler.processToolCalls({ toolCalls: lastAssistantMsg.tool_calls });

            if (!toolProcessingResult.success) {
               log.error(`Internal tool processing failed for conv ${convId}`, { error: toolProcessingResult.error });
               sharedState.lastResponse = { success: false, error: "Tool processing failed", errorDetails: toolProcessingResult.error };
               currentAction = ERROR_ACTION; // Set error action
               break; // Exit loop on tool processing error
            }

            // Add tool results to messages
            log.info(`Adding ${toolProcessingResult.value.toolCallMessages.length} tool result messages for conv ${convId}`);
            sharedState.messages.push(...toolProcessingResult.value.toolCallMessages);
            FlowExecutor.conversationStates.set(convId, sharedState); // Update state map
            // State is updated, continue to the next iteration of the while loop
            log.info(`Continuing loop for conv ${convId} after internal tool processing.`);
            continue;
          } else {
            // Return tool calls to external caller
            log.info(`[flujo=false] Returning tool calls to external caller for conv ${convId}`);
            break; // Exit loop to return response with tool_calls
          }
        } else {
           log.warn(`TOOL_CALL_ACTION received for conv ${convId} but no tool_calls found in last message. Treating as final.`);
           currentAction = FINAL_RESPONSE_ACTION; // Treat as final if no tools found
           break;
        }
      }

      // Check if action is an edgeId (Handoff)
      // We need the PocketFlow instance to find the current node and its successors
      // Accessing private methods directly is not ideal, consider refactoring FlowExecutor if possible
      const pocketFlow = await FlowExecutor['loadAndConvertFlow'](sharedState.flowId);
      const currentNode = sharedState.currentNodeId ? await FlowExecutor['findNodeById'](pocketFlow, sharedState.currentNodeId) : undefined;

      if (currentNode && currentAction && currentNode.successors.has(currentAction)) {
         log.info(`Handoff action received for conv ${convId}. Edge: ${currentAction}`);
         const nextNode = currentNode.getSuccessor(currentAction); // Gets a clone
         if (nextNode) {
            const nextNodeId = nextNode.node_params?.id;
            if (typeof nextNodeId === 'string' && nextNodeId.length > 0) {
                sharedState.currentNodeId = nextNodeId; // Update state to the next node's ID
                sharedState.handoffRequested = undefined; // Clear handoff request flag
                log.info(`Transitioning conv ${convId} to node ${sharedState.currentNodeId}`);
                FlowExecutor.conversationStates.set(convId, sharedState); // Update state map
                // State updated, continue loop for the next step (automatic handoff)
                log.info(`Continuing loop for conv ${convId} after handoff.`);
                continue;
            } else {
                 log.error(`Handoff failed for conv ${convId}: Successor node for edge ${currentAction} has invalid ID.`);
                 sharedState.lastResponse = { success: false, error: `Handoff failed: Target node for edge ${currentAction} has invalid ID.` };
                 currentAction = ERROR_ACTION;
                 break;
            }
         } else {
            log.error(`Handoff failed for conv ${convId}: Successor node not found for edge ${currentAction}`);
            sharedState.lastResponse = { success: false, error: `Handoff failed: Cannot find target node for edge ${currentAction}` };
            currentAction = ERROR_ACTION;
            break;
         }
      }

      // Handle STAY_ON_NODE or other potential actions
      if (currentAction === STAY_ON_NODE_ACTION) {
         log.info(`Stay on node action received for conv ${convId} at step ${internalIterations}`);
         break; // Exit loop, return current state
      }

      // If action is unrecognized after checking handoffs, treat as error or final?
      log.warn(`Unrecognized action '${currentAction}' received at step ${internalIterations} for conv ${convId}. Treating as final response.`);
      currentAction = FINAL_RESPONSE_ACTION;
      break;

    } // --- End while loop ---

    // Safety break check
    if (internalIterations >= MAX_INTERNAL_ITERATIONS) {
       log.warn(`Max internal iterations (${MAX_INTERNAL_ITERATIONS}) reached for conv ${convId}. Returning current state as error.`);
       if (currentAction !== ERROR_ACTION) { // Avoid overwriting existing error
          sharedState.lastResponse = { success: false, error: "Maximum internal iterations reached." };
          currentAction = ERROR_ACTION;
       }
    }

  } catch (loopError) {
     // Catch errors originating from within the loop logic itself (e.g., state handling)
     log.error(`Unhandled error during execution loop for conv ${convId}`, { loopError });
     if (currentAction !== ERROR_ACTION) {
        sharedState.lastResponse = { success: false, error: loopError instanceof Error ? loopError.message : String(loopError) };
        currentAction = ERROR_ACTION;
     }
  }

  // --- 3. Format and Return Response ---
  const finalExecutionTime = Date.now() - startTime;
  log.info(`Execution finished for conv ${convId}. Final Action: ${currentAction}`, { duration: `${finalExecutionTime}ms` });

  // Save final state before returning
  try {
    await saveItemBackend(storageKey, sharedState);
    log.info(`Saved final state for conversation ${convId} before returning response.`);
  } catch (error) {
    log.error(`Failed to save final state for conversation ${convId}:`, error);
  }
  // Update state map one last time before returning (optional, depending on strategy)
  FlowExecutor.conversationStates.set(convId, sharedState); 

  // Handle Error Response
  if (currentAction === ERROR_ACTION) {
    let errorMessage = 'Unknown error during execution';
    let errorDetails: ErrorDetails | undefined = undefined;
    let statusCode = 500;

    // Safely check the structure of lastResponse
    if (typeof sharedState.lastResponse === 'object' && sharedState.lastResponse !== null) {
        // Check if it looks like our ErrorResult structure (success: false, error: string)
        if ('success' in sharedState.lastResponse && sharedState.lastResponse.success === false && 'error' in sharedState.lastResponse && typeof sharedState.lastResponse.error === 'string') {
             // It matches ErrorResult structure
             errorMessage = sharedState.lastResponse.error;
             // Check if errorDetails exists and is an object before assigning
             if ('errorDetails' in sharedState.lastResponse && typeof sharedState.lastResponse.errorDetails === 'object' && sharedState.lastResponse.errorDetails !== null) {
                 // Assign and ensure it conforms to ErrorDetails shape
                 const details = sharedState.lastResponse.errorDetails as Partial<ErrorDetails>;
                 errorDetails = {
                     message: typeof details.message === 'string' ? details.message : errorMessage, // Ensure message exists
                     type: typeof details.type === 'string' ? details.type : undefined,
                     code: typeof details.code === 'string' ? details.code : undefined,
                     param: typeof details.param === 'string' ? details.param : undefined,
                     status: typeof details.status === 'number' ? details.status : undefined,
                     stack: typeof details.stack === 'string' ? details.stack : undefined,
                     name: typeof details.name === 'string' ? details.name : undefined,
                 };
                 if (errorDetails.status) {
                     statusCode = errorDetails.status;
                 }
             }
        } else {
            // If it's an object but not ErrorResult, stringify it safely
            try {
                errorMessage = `Unexpected error state object: ${JSON.stringify(sharedState.lastResponse)}`;
            } catch {
                errorMessage = 'Unexpected error state object (unserializable)';
            }
        }
    } else if (typeof sharedState.lastResponse === 'string') {
        // If lastResponse is just a string error message
        errorMessage = sharedState.lastResponse;
    }

    // Ensure errorDetails has at least a message if it's still undefined
    if (!errorDetails) {
        errorDetails = { message: errorMessage };
    } else {
        // Ensure message is set if errorDetails exists but message is missing
        errorDetails.message = errorDetails.message || errorMessage;
    }

    log.error(`Returning error response for conv ${convId}`, { errorMessage, errorDetails, statusCode });

    return NextResponse.json({
      error: {
        message: errorMessage,
        // Safely access properties of errorDetails
        type: errorDetails.type || 'api_error',
        code: errorDetails.code || 'internal_error',
        param: errorDetails.param,
        details: errorDetails // Include full details object
      }
    }, { status: statusCode });
  } // End of if (currentAction === ERROR_ACTION)

  // Handle Success Response (Final, Tool Call, or Stay)
  const lastMessage = sharedState.messages.length > 0 ? sharedState.messages[sharedState.messages.length - 1] : null;

  // Determine the content for the response message
  let responseContent = '';
  if (typeof sharedState.lastResponse === 'string') {
      responseContent = sharedState.lastResponse;
  } else if (lastMessage?.role === 'assistant' && typeof lastMessage.content === 'string') {
      // Use content from the last assistant message if lastResponse isn't a string
      responseContent = lastMessage.content;
  } else {
      // Fallback if no suitable content found
      responseContent = (currentAction === TOOL_CALL_ACTION) ? '' : 'Processing complete.'; // Empty content if expecting tool calls
  }


  // Construct the primary response message
  const responseMessage: OpenAI.ChatCompletionAssistantMessageParam = {
     role: "assistant",
     content: responseContent,
     // Include tool_calls ONLY if returning to external caller AND the action indicates it
     tool_calls: (!flujo && currentAction === TOOL_CALL_ACTION && lastMessage?.role === 'assistant') ? lastMessage.tool_calls : undefined
  };

  // Determine finish reason
  let finish_reason: OpenAI.ChatCompletion.Choice['finish_reason'] = 'stop'; // Default to stop
  if (currentAction === TOOL_CALL_ACTION && !flujo) {
      finish_reason = 'tool_calls';
  } else if (currentAction === STAY_ON_NODE_ACTION) {
      finish_reason = 'length'; // Indicate more input might be needed
  }
  // Add other reasons if needed (e.g., 'content_filter')

  // Calculate usage (simplified)
  const promptTokens = countTokens(sharedState.messages.map(m => m.content || '').join('\n')); // Rough estimate
  const completionTokens = countTokens(responseContent);
  const usage: TokenUsage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens
  };

  // Construct the final response data object
  const responseData = {
    id: `chatcmpl-${Date.now()}`, // Use a more robust ID generation if needed
    object: "chat.completion",
    created: Math.floor(startTime / 1000), // Use start time
    model: data.model, // Echo back the requested model
    choices: [{
      index: 0,
      message: responseMessage,
      finish_reason: finish_reason
    }],
    usage,
    // Return all messages in the shared state for context
    messages: sharedState.messages,
    // Include conversation ID for stateful interactions
    conversation_id: sharedState.conversationId
  };

  log.info(`Returning success response for conv ${convId}`, { action: currentAction, flujo, finish_reason });
  log.verbose(`Final response data for conv ${convId}`, JSON.stringify(responseData));

  // TODO: Adapt streaming response logic if needed.
  // The current logic assumes non-streaming. Streaming would require yielding chunks
  // during the loop, especially for content generation and tool calls.
  if (data.stream === true) {
     log.warn('Streaming requested but not fully implemented with new loop logic. Returning non-streaming response.');
     // Fallback to non-streaming for now
     // return createStreamingResponse(data.model, responseContent, usage, sharedState.messages, sharedState.conversationId);
  }

  return NextResponse.json(responseData);
}

// Create a streaming response using Server-Sent Events (SSE) - Needs adaptation for the new loop
export function createStreamingResponse(
  modelParam: string,
  content: string,
  usage: TokenUsage,
  messages?: OpenAI.ChatCompletionMessageParam[],
  conversationId?: string
) {
  // ... (Existing streaming implementation - needs significant changes to work with the new step-by-step logic)
  log.warn("createStreamingResponse needs adaptation for the new step-by-step execution loop.");
  // Placeholder implementation returning an error or simple stream
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
      start(controller) {
          const errorChunk = { error: { message: "Streaming not fully implemented with new logic." } };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
      }
  });
   return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    }
  });
}
