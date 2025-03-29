import { NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { ChatCompletionRequest } from './requestParser';
import { FlowExecutionResponse, ErrorResult, SuccessResult } from '@/shared/types/flow/response';
import OpenAI from 'openai';
import { SharedState, TOOL_CALL_ACTION, FINAL_RESPONSE_ACTION, ERROR_ACTION, STAY_ON_NODE_ACTION, ErrorDetails } from '@/backend/execution/flow/types'; // Import types and actions
import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler'; // Import ModelHandler
import { BaseNode, Flow as PocketFlow } from '@/backend/execution/flow/temp_pocket'; // Use Flow as PocketFlow
import { toolNameInternalRegex } from '@/utils/shared/common'; // Import the regex
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
  flujo: boolean,
  requireApproval: boolean, // Add requireApproval flag
  conversationId?: string
) {
  const startTime = Date.now();
  const requestId = `proc-${Date.now()}`;
  log.info('Processing chat completion request', {
    requestId,
    model: data.model,
    messageCount: data.messages?.length || 0,
    stream: data.stream, // Note: Streaming logic needs separate adaptation later
    flujo,
    requireApproval, // Log the new flag
    conversationId
  });

  // --- 1. Initialize or Retrieve State ---
  let sharedState: SharedState | undefined = undefined;
  // Use the provided conversationId if it exists, otherwise generate a new one.
  const effectiveConvId = conversationId || crypto.randomUUID();
  const storageKey = `conversations/${effectiveConvId}` as StorageKey;
  let stateSource: 'storage' | 'memory' | 'new' = 'new';

  log.info(`Effective Conversation ID for this request: ${effectiveConvId}`, { providedId: conversationId });

  // Try loading state using the effectiveConvId
  // Prioritize in-memory state
  if (FlowExecutor.conversationStates.has(effectiveConvId)) {
    sharedState = FlowExecutor.conversationStates.get(effectiveConvId)!;
    log.info(`Resuming conversation ${effectiveConvId} from memory`, { currentNodeId: sharedState.currentNodeId });
    stateSource = 'memory';
  }
  // If not in memory, try storage
  else {
    try {
      sharedState = await loadItemBackend<SharedState>(storageKey, undefined as any);
      if (sharedState) {
        log.info(`Loaded conversation state from storage: ${effectiveConvId}`);
        stateSource = 'storage';
        // Ensure it's in the memory map as well
        FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
      } else {
        log.info(`No state found in storage for conversation: ${effectiveConvId}.`);
        // If a conversationId was provided but not found, should we error?
        // For now, we proceed to create a new one, which might hide the frontend/backend ID mismatch.
        // Consider adding a stricter check later if needed.
      }
    } catch (error) {
      log.warn(`Error loading conversation state from storage for ${effectiveConvId}:`, error);
      // Proceed to create new state if loading failed
    } // Added missing catch block
  }

  // If still no state found (neither in memory nor storage), create a new one
  if (!sharedState) {
    // This block should only run if conversationId was NOT provided,
    // OR if it was provided but loading failed/returned nothing.
    stateSource = 'new';
    log.info(`Creating new conversation state for ID: ${effectiveConvId}`);
    const flowName = data.model.substring(5); // Assumes "flow-FlowName" format
    const reactFlow = await flowServiceWithGetByName.getFlowByName(flowName);
    if (!reactFlow) {
      log.error(`Flow not found: ${flowName}`);
      return NextResponse.json({ error: { message: `Flow not found: ${flowName}`, type: 'invalid_request_error', code: 'flow_not_found' } }, { status: 400 });
    }

    sharedState = {
      trackingInfo: { executionId: crypto.randomUUID(), startTime: Date.now(), nodeExecutionTracker: [] },
      messages: data.messages || [],
      flowId: reactFlow.id,
      conversationId: effectiveConvId, // Use the determined ID
      currentNodeId: undefined,
      status: 'running', // Initial status
      // --- Initialize new fields ---
      title: 'New Conversation', // Default title
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    // Save the newly created state immediately
    try {
      // --- Update timestamps before saving ---
      sharedState.updatedAt = Date.now();
      // Title update logic (only needed if messages are present initially, unlikely but safe)
      if (sharedState.title === 'New Conversation' && sharedState.messages.length > 0) {
        const firstUserMessage = sharedState.messages.find(m => m.role === 'user');
        if (firstUserMessage && typeof firstUserMessage.content === 'string') {
            sharedState.title = firstUserMessage.content.split(' ').slice(0, 5).join(' ') + '...';
            log.debug(`Updated conversation title for ${effectiveConvId} during init to: ${sharedState.title}`);
        }
      }
      await saveItemBackend(storageKey, sharedState);
      log.info(`Saved initial state for new conversation ${effectiveConvId} to storage.`);
    } catch (error) {
      log.error(`Failed to save initial state for new conversation ${effectiveConvId}:`, error);
      // Decide if this is a critical error - maybe return 500? For now, log and continue.
    }
    // Ensure the state is in the memory map
    FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
  }

  // If state was loaded or resumed (not new), handle potential updates
  if (stateSource === 'storage' || stateSource === 'memory') {
      // Ensure the correct conversationId is used internally
      if (sharedState.conversationId !== effectiveConvId) {
         log.warn(`State's internal conversationId (${sharedState.conversationId}) differs from effectiveConvId (${effectiveConvId}). Using effectiveConvId.`);
         sharedState.conversationId = effectiveConvId; // Correct the state object if needed
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
      log.info(`--- Starting Execution Step ${internalIterations} for Conv ${effectiveConvId} ---`);

      // Check for cancellation flag before executing the step
      if (sharedState.isCancelled) {
        log.info(`Cancellation flag detected for conv ${effectiveConvId}. Terminating execution.`);
        // Optionally set a specific error state/message
        sharedState.status = 'error';
        sharedState.lastResponse = { success: false, error: 'Execution cancelled by user.' };
        currentAction = ERROR_ACTION; // Treat as error to ensure proper response formatting
        break; // Exit the loop immediately
      }

      // Log message history before executing step (for debugging tool call issues)
      if (sharedState.messages.length > 0) {
        const lastFewMessages = sharedState.messages.slice(-3); // Log last 3 messages
        log.debug(`Message history before step ${internalIterations}`, JSON.stringify(lastFewMessages));
      } else {
        log.debug(`No messages in history before step ${internalIterations}`);
      }


      // 2a. Execute one step of the flow
      const stepResult = await FlowExecutor.executeStep(sharedState);
      sharedState = stepResult.sharedState; // Update state with results from the step
      currentAction = stepResult.action;
      
      // Save state after each step (using the correct storageKey based on effectiveConvId)
      try {
        // --- Update timestamps and title before saving ---
        sharedState.updatedAt = Date.now();
        if (sharedState.title === 'New Conversation' && sharedState.messages.length > 0) {
            const firstUserMessage = sharedState.messages.find(m => m.role === 'user');
            if (firstUserMessage && typeof firstUserMessage.content === 'string') {
                sharedState.title = firstUserMessage.content.split(' ').slice(0, 5).join(' ') + '...';
                log.debug(`Updated conversation title for ${effectiveConvId} after step ${internalIterations} to: ${sharedState.title}`);
            }
        }
        await saveItemBackend(storageKey, sharedState);
        log.debug(`Saved state after step ${internalIterations} for conv ${effectiveConvId}`);
      } catch (error) {
        log.error(`Failed to save state after step ${internalIterations} for conv ${effectiveConvId}:`, error);
      }

      log.info(`Step ${internalIterations} completed for conv ${effectiveConvId}. Action: ${currentAction}`, { currentNodeId: sharedState.currentNodeId });
      log.verbose(`Shared state after step ${internalIterations}`, JSON.stringify(sharedState));


      // 2b. Handle the action returned by the step
      if (currentAction === ERROR_ACTION) {
        log.error(`Error action received during step ${internalIterations} for conv ${effectiveConvId}`, { error: sharedState.lastResponse });
        break; // Exit loop to return error
      }

      if (currentAction === FINAL_RESPONSE_ACTION) {
        log.info(`Final response action received at step ${internalIterations} for conv ${effectiveConvId}`);
        break; // Exit loop to return final response
      }

      if (currentAction === TOOL_CALL_ACTION) {
        log.info(`Tool call action received at step ${internalIterations} for conv ${effectiveConvId}`);
        const lastAssistantMsg = sharedState.messages.length > 0 ? sharedState.messages[sharedState.messages.length - 1] : null;

        if (lastAssistantMsg?.role === 'assistant' && lastAssistantMsg.tool_calls) {
          if (flujo) {
            // --- Flujo=true: Handle optional approval ---
            if (requireApproval) {
              // Pause execution and wait for user approval
              log.info(`[flujo=true, requireApproval=true] Pausing execution for tool approval for conv ${effectiveConvId}`);
              sharedState.status = 'awaiting_tool_approval';
              sharedState.pendingToolCalls = lastAssistantMsg.tool_calls; // Assign the actual tool calls
              sharedState.lastResponse = undefined; // Clear last response
              // Update state map before breaking
              FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
              // Save state before breaking
              try {
                // --- Update timestamps and title before saving ---
                sharedState.updatedAt = Date.now();
                 if (sharedState.title === 'New Conversation' && sharedState.messages.length > 0) {
                    const firstUserMessage = sharedState.messages.find(m => m.role === 'user');
                    if (firstUserMessage && typeof firstUserMessage.content === 'string') {
                        sharedState.title = firstUserMessage.content.split(' ').slice(0, 5).join(' ') + '...';
                        log.debug(`Updated conversation title for ${effectiveConvId} before pausing to: ${sharedState.title}`);
                    }
                }
                await saveItemBackend(storageKey, sharedState);
                log.debug(`Saved state before pausing for approval for conv ${effectiveConvId}`);
              } catch (error) {
                log.error(`Failed to save state before pausing for approval for conv ${effectiveConvId}:`, error);
              }
              break; // Exit the loop, response formatting will handle the paused state
            } else {
              // Process tools internally without approval and continue loop
              log.info(`[flujo=true, requireApproval=false] Processing ${lastAssistantMsg.tool_calls.length} tools internally for conv ${effectiveConvId}`);
              const toolProcessingResult = await ModelHandler.processToolCalls({ toolCalls: lastAssistantMsg.tool_calls });

              if (!toolProcessingResult.success) {
               log.error(`Internal tool processing failed for conv ${effectiveConvId}`, { error: toolProcessingResult.error });
               sharedState.lastResponse = { success: false, error: "Tool processing failed", errorDetails: toolProcessingResult.error };
               currentAction = ERROR_ACTION;
               break; // Exit loop on tool processing error
            }

            // Add tool results to messages
            log.info(`Adding ${toolProcessingResult.value.toolCallMessages.length} tool result messages for conv ${effectiveConvId}`);
            sharedState.messages.push(...toolProcessingResult.value.toolCallMessages);
            FlowExecutor.conversationStates.set(effectiveConvId, sharedState); // Update state map
              // State is updated, continue to the next iteration of the while loop
              log.info(`Continuing loop for conv ${effectiveConvId} after internal tool processing (no approval needed).`);
              continue; // Continue loop
            }
          } else {
            // --- flujo=false: Handle internal vs external tools ---
            log.info(`[flujo=false] Tool call action received for conv ${effectiveConvId}. Checking tool types.`);
            const allToolCalls = lastAssistantMsg.tool_calls || [];
            const internalTools: OpenAI.ChatCompletionMessageToolCall[] = [];
            const externalTools: OpenAI.ChatCompletionMessageToolCall[] = [];

            // Reset the regex state before each test
            toolNameInternalRegex.lastIndex = 0; 
            allToolCalls.forEach(tc => {
              if (tc.type === 'function' && toolNameInternalRegex.test(tc.function.name)) {
                log.debug("tool is internal:", tc.function.name)
                internalTools.push(tc);
                toolNameInternalRegex.lastIndex = 0; // Reset after successful test
              } else {
                log.debug("tool is external:", tc.function.name)
                externalTools.push(tc);
              }
            });

            if (internalTools.length > 0) {
              // Process internal tools and continue the loop
              log.info(`[flujo=false] Processing ${internalTools.length} internal tools for conv ${effectiveConvId}. External tools (${externalTools.length}) will be ignored this step.`);
              const toolProcessingResult = await ModelHandler.processToolCalls({ toolCalls: internalTools });

              if (!toolProcessingResult.success) {
                 log.error(`[flujo=false] Internal tool processing failed for conv ${effectiveConvId}`, { error: toolProcessingResult.error });
                 sharedState.lastResponse = { success: false, error: "Internal tool processing failed", errorDetails: toolProcessingResult.error };
                 currentAction = ERROR_ACTION;
                 break; // Exit loop on tool processing error
              }

              // Add tool results to messages
              log.info(`Adding ${toolProcessingResult.value.toolCallMessages.length} internal tool result messages for conv ${effectiveConvId}`);
              sharedState.messages.push(...toolProcessingResult.value.toolCallMessages);
              FlowExecutor.conversationStates.set(effectiveConvId, sharedState); // Update state map
              // State is updated, continue to the next iteration of the while loop
              log.info(`Continuing loop for conv ${effectiveConvId} after internal tool processing (flujo=false).`);
              continue; // Go to next loop iteration

            } else if (externalTools.length > 0) {
              // Only external tools present: Wrap them in XML and return
              log.info(`[flujo=false] Found ${externalTools.length} external tools for conv ${effectiveConvId}. Wrapping in XML and returning.`);
              
              const xmlToolStrings: string[] = [];
              for (const toolCall of externalTools) {
                if (toolCall.type === 'function') {
                  try {
                    const args = JSON.parse(toolCall.function.arguments || '{}');
                    let paramsXml = '';
                    for (const key in args) {
                      // Basic XML escaping for values - consider a more robust library if needed
                      const value = String(args[key]).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');                      paramsXml += `\n<${key}>${value}</${key}>`;
                    }
                    xmlToolStrings.push(`<${toolCall.function.name}>${paramsXml}\n</${toolCall.function.name}>`);
                  } catch (parseError) {
                    log.error(`[flujo=false] Failed to parse arguments for external tool ${toolCall.function.name}`, { args: toolCall.function.arguments, error: parseError, convId: effectiveConvId });
                    // Optionally include an error marker in the output?
                    xmlToolStrings.push(`<${toolCall.function.name}>\n<error>Failed to parse arguments: ${parseError instanceof Error ? parseError.message : String(parseError)}</error>\n</${toolCall.function.name}>`);
                  }
                }
              }
              
              // Append XML to the content that will be used for the response
              // We need to modify the 'responseContent' variable later in the response formatting section
              sharedState.lastResponse = { // Store XML temporarily in lastResponse for retrieval later
                 _flujo_xml_tools: xmlToolStrings.join('\n\n') 
              }; 
              
              // Ensure tool_calls are NOT included in the final response object later
              // The logic below in response formatting will handle this.
              // Set finish_reason to 'stop' as we are not returning structured tool calls
              currentAction = FINAL_RESPONSE_ACTION; // Treat as final response for exiting loop
              log.info(`[flujo=false] Prepared XML for external tools. Exiting loop for conv ${effectiveConvId}.`);
              break; // Exit loop to return response with XML in content

            } else {
              // No tools found (should have been caught earlier, but safety check)
              log.warn(`[flujo=false] TOOL_CALL_ACTION received for conv ${effectiveConvId} but no tools found after classification. Treating as final.`);
              currentAction = FINAL_RESPONSE_ACTION;
              break;
            }
          }
        } else {
           log.warn(`TOOL_CALL_ACTION received for conv ${effectiveConvId} but no tool_calls found in last message. Treating as final.`);
           currentAction = FINAL_RESPONSE_ACTION;
           break; // Treat as final if no tools found
        }
      }

      // Check if action is an edgeId (Handoff)
      // We need the PocketFlow instance to find the current node and its successors
      // Accessing private methods directly is not ideal, consider refactoring FlowExecutor if possible
      const pocketFlow = await FlowExecutor['loadAndConvertFlow'](sharedState.flowId);
      const currentNode = sharedState.currentNodeId ? await FlowExecutor['findNodeById'](pocketFlow, sharedState.currentNodeId) : undefined;

      if (currentNode && currentAction && currentNode.successors.has(currentAction)) {
         log.info(`Handoff action received for conv ${effectiveConvId}. Edge: ${currentAction}`);
         const nextNode = currentNode.getSuccessor(currentAction);
         if (nextNode) {
            const nextNodeId = nextNode.node_params?.id;
            if (typeof nextNodeId === 'string' && nextNodeId.length > 0) {
                sharedState.currentNodeId = nextNodeId;
                sharedState.handoffRequested = undefined;
                log.info(`Transitioning conv ${effectiveConvId} to node ${sharedState.currentNodeId}`);
                FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
                // State updated, continue loop for the next step (automatic handoff)
                log.info(`Continuing loop for conv ${effectiveConvId} after handoff.`);
                continue;
            } else {
                 log.error(`Handoff failed for conv ${effectiveConvId}: Successor node for edge ${currentAction} has invalid ID.`);
                 sharedState.lastResponse = { success: false, error: `Handoff failed: Target node for edge ${currentAction} has invalid ID.` };
                 currentAction = ERROR_ACTION;
                 break;
            }
         } else {
            log.error(`Handoff failed for conv ${effectiveConvId}: Successor node not found for edge ${currentAction}`);
            sharedState.lastResponse = { success: false, error: `Handoff failed: Cannot find target node for edge ${currentAction}` };
            currentAction = ERROR_ACTION;
            break;
         }
      }

      // Handle STAY_ON_NODE or other potential actions
      if (currentAction === STAY_ON_NODE_ACTION) {
         log.info(`Stay on node action received for conv ${effectiveConvId} at step ${internalIterations}`);
         break; // Exit loop, return current state
      }

      // If action is unrecognized after checking handoffs, treat as error or final?
      log.warn(`Unrecognized action '${currentAction}' received at step ${internalIterations} for conv ${effectiveConvId}. Treating as final response.`);
      currentAction = FINAL_RESPONSE_ACTION;
      break;

    } // --- End while loop ---

    // Safety break check
    if (internalIterations >= MAX_INTERNAL_ITERATIONS) {
       log.warn(`Max internal iterations (${MAX_INTERNAL_ITERATIONS}) reached for conv ${effectiveConvId}. Returning current state as error.`);
       if (currentAction !== ERROR_ACTION) { // Avoid overwriting existing error
          sharedState.lastResponse = { success: false, error: `Maximum internal iterations (${MAX_INTERNAL_ITERATIONS}) reached.` };
          currentAction = ERROR_ACTION;
       }
    }

  } catch (loopError) {
     // Catch errors originating from within the loop logic itself (e.g., state handling)
     log.error(`Unhandled error during execution loop for conv ${effectiveConvId}`, { loopError });
     if (currentAction !== ERROR_ACTION) {
        sharedState.lastResponse = { success: false, error: loopError instanceof Error ? loopError.message : String(loopError), errorDetails: loopError instanceof Error ? { name: loopError.name, message: loopError.message, stack: loopError.stack } : undefined };
        currentAction = ERROR_ACTION;
     }
  }

  // --- 3. Format and Return Response ---
  const finalExecutionTime = Date.now() - startTime;
  log.info(`Execution finished for conv ${effectiveConvId}. Final Action: ${currentAction}`, { duration: `${finalExecutionTime}ms` });

  // Save final state before returning
  try {
    // --- Update timestamps and title before final save ---
    sharedState.updatedAt = Date.now();
    if (sharedState.title === 'New Conversation' && sharedState.messages.length > 0) {
        const firstUserMessage = sharedState.messages.find(m => m.role === 'user');
        if (firstUserMessage && typeof firstUserMessage.content === 'string') {
            sharedState.title = firstUserMessage.content.split(' ').slice(0, 5).join(' ') + '...';
            log.debug(`Updated conversation title for ${effectiveConvId} before final return to: ${sharedState.title}`);
        }
    }
    await saveItemBackend(storageKey, sharedState);
    log.info(`Saved final state for conversation ${effectiveConvId} before returning response.`);
  } catch (error) {
    log.error(`Failed to save final state for conversation ${effectiveConvId}:`, error);
  }
  // Update state map one last time before returning
  FlowExecutor.conversationStates.set(effectiveConvId, sharedState);

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

    log.error(`Returning error response for conv ${effectiveConvId}`, { errorMessage, errorDetails, statusCode });

    // Ensure status is set correctly on error
    sharedState.status = 'error';

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

  // Handle Success Response (Final, Tool Call, Stay, or Awaiting Approval)
  const lastMessage = sharedState.messages.length > 0 ? sharedState.messages[sharedState.messages.length - 1] : null;

  // Determine the content for the response message
  let responseContent = '';
  let externalToolsXml = ''; // Variable to hold XML if generated

  // Check if we stored XML for external tools
  if (typeof sharedState.lastResponse === 'object' && sharedState.lastResponse !== null && '_flujo_xml_tools' in sharedState.lastResponse) {
      externalToolsXml = sharedState.lastResponse._flujo_xml_tools as string;
      // Use the last assistant message's content as the base, if available
      if (lastMessage?.role === 'assistant' && typeof lastMessage.content === 'string') {
          responseContent = lastMessage.content;
      } else {
          responseContent = ''; // Start with empty if no prior assistant content
      }
      // Append the XML
      responseContent += (responseContent ? '\n\n' : '') + externalToolsXml;
      // Clear the temporary marker from lastResponse if needed, though it won't be returned directly
      sharedState.lastResponse = responseContent; // Or set to something neutral

  } else if (typeof sharedState.lastResponse === 'string') {
      // Standard case: lastResponse is the content
      responseContent = sharedState.lastResponse;
  } else if (lastMessage?.role === 'assistant' && typeof lastMessage.content === 'string') {
      // Fallback: Use content from the last assistant message if lastResponse isn't suitable
      responseContent = lastMessage.content;
  } else {
      // Final fallback if no suitable content found
      responseContent = (currentAction === TOOL_CALL_ACTION && !flujo) ? '' : 'Processing complete.'; // Empty content if expecting tool calls externally (before XML wrapping)
  }


  // Construct the primary response message
  const responseMessage: OpenAI.ChatCompletionAssistantMessageParam = {
     role: "assistant",
     content: responseContent,
     // Include tool_calls ONLY if flujo=true OR if flujo=false AND we DIDN'T wrap external tools (shouldn't happen with current logic)
     // If externalToolsXml is present, tool_calls MUST be undefined.
     tool_calls: externalToolsXml ? undefined : (lastMessage?.role === 'assistant' ? lastMessage.tool_calls : undefined)
     // Simplified: tool_calls: externalToolsXml ? undefined : lastMessage?.tool_calls
  };

  // Determine finish reason
  let finish_reason: OpenAI.ChatCompletion.Choice['finish_reason'] = 'stop'; // Default to stop
  if (sharedState.status === 'awaiting_tool_approval') {
      // Although we paused, from the API perspective, it stopped to wait.
      // The frontend relies on polling status, not this reason.
      finish_reason = 'stop'; 
      log.debug(`Setting finish_reason to 'stop' for awaiting_tool_approval status`);
  } else if (externalToolsXml) {
      finish_reason = 'stop'; // We wrapped tools in content, so it's a stop from the API's perspective
  } else if (currentAction === TOOL_CALL_ACTION && responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
      // Only set tool_calls reason if we are actually returning tool_calls in the response object
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
    conversation_id: sharedState.conversationId, // Ensure this uses the correct ID
    // Include status and pending calls if relevant
    status: sharedState.status || (currentAction === FINAL_RESPONSE_ACTION ? 'completed' : 'running'), // Infer status if not explicitly set
    pendingToolCalls: sharedState.pendingToolCalls
  };

  log.info(`Returning success response for conv ${effectiveConvId}`, { action: currentAction, status: responseData.status, flujo, requireApproval, finish_reason });
  log.verbose(`Final response data for conv ${effectiveConvId}`, JSON.stringify(responseData));

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
