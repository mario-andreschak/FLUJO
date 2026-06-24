import { NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import { ChatCompletionRequest } from './requestParser';
import OpenAI from 'openai';
import { TOOL_CALL_ACTION, FINAL_RESPONSE_ACTION, STAY_ON_NODE_ACTION } from '@/backend/execution/flow/types';
import { FlujoChatMessage } from '@/shared/types/chat'; // Import FlujoChatMessage from shared types
import { StorageKey } from '@/shared/types/storage'; // Import StorageKey
import { runFlow } from '@/backend/execution/flow/runFlow';

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
  log.verbose('Checking if error is retryable', { errorType: typeof error, status: error.status, code: error.code, message: error.message }); // Changed to verbose
  if (error.status === 429) return true;
  if (error.status >= 500 && error.status < 600) return true;
  if (error.message?.includes('timeout') || error.code === 'ETIMEDOUT') return true;
  if (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET') return true;
  log.verbose('Error is not retryable', { error }); // Changed to verbose
  return false;
}

// Persist conversation state WITHOUT the in-memory-only debug execution trace
// (keeps the on-disk conversation lean). See persistConversationState.
const persistState = persistConversationState;

// Internal function: now a thin OpenAI adapter on top of the flow-as-callable
// keystone (runFlow). It maps the OpenAI request → FlowRunInput, runs the flow,
// and maps the typed FlowRunResult back to the exact OpenAI-compatible response
// shapes the chat UI and external API clients expect. All execution, state
// persistence, and live-event emission happen inside runFlow.
async function processChatCompletionInternal(
  data: ChatCompletionRequest,
  flujo: boolean,
  requireApproval: boolean,
  flujodebug: boolean,
  conversationId?: string,
  // When true, a debug session (debugMode) runs freely until a terminal/
  // approval/breakpoint state instead of pausing after every step. Used by the
  // "Continue" control; "Step" leaves this false so it pauses each step.
  continueDebug: boolean = false,
  // True only for a fresh user-initiated turn (the public completions route).
  // Such a turn re-syncs debugMode to the request's flujodebug flag so toggling
  // the "Execute in Debugger" checkbox takes effect on an existing conversation.
  // Internal resumes (step/continue/respond) leave this false to preserve the
  // session's debugMode.
  userTurn: boolean = false
) {
  const startTime = Date.now();
  log.info('Processing chat completion request', {
    model: data.model,
    messageCount: data.messages?.length || 0,
    stream: data.stream,
    flujo,
    requireApproval,
    flujodebug,
    conversationId,
  });

  const result = await runFlow({
    modelName: data.model,
    messages: data.messages,
    processNodeId: data.processNodeId,
    mode: 'conversation',
    conversationId,
    flujo,
    requireApproval,
    debug: flujodebug,
    continueDebug,
    userTurn,
  });

  // --- Flow not found → 400 (OpenAI invalid_request) ---
  if (result.flowNotFound) {
    return NextResponse.json({
      error: { message: `Flow not found: ${result.flowNotFound.name}`, type: 'invalid_request_error', code: 'flow_not_found' },
    }, { status: 400 });
  }

  // --- Paused debug → custom structure with the full debug state ---
  if (result.status === 'paused_debug') {
    log.info(`Returning paused debug state for conv ${result.conversationId}`);
    return NextResponse.json({
      status: 'paused_debug',
      conversation_id: result.conversationId,
      debugState: result.sharedState,
    });
  }

  // --- Error → OpenAI-compatible error envelope ---
  if (result.status === 'error') {
    const errorMessage = result.error?.message ?? 'Unknown error during execution';
    const errorDetails = result.error?.details ?? { message: errorMessage };
    const statusCode = result.error?.statusCode ?? 500;
    log.error(`Returning error response for conv ${result.conversationId}`, { errorMessage, errorDetails, statusCode });
    return NextResponse.json({
      error: {
        message: errorMessage,
        type: errorDetails.type || 'api_error',
        code: errorDetails.code || 'internal_error',
        param: errorDetails.param,
        details: errorDetails,
      },
    }, { status: statusCode });
  }

  // --- Success (Final, Tool Call, Stay, or Awaiting Approval) ---
  const responseMessage: OpenAI.ChatCompletionAssistantMessageParam = {
    role: 'assistant',
    content: result.outputText,
    tool_calls: result.toolCalls,
  };

  // Determine finish reason. Order matters: awaiting_tool_approval reports as a
  // plain stop (the frontend keys off status, not this reason).
  let finish_reason: OpenAI.ChatCompletion.Choice['finish_reason'] = 'stop';
  if (result.sharedState.status === 'awaiting_tool_approval') {
    finish_reason = 'stop';
  } else if (result.finalAction === TOOL_CALL_ACTION && responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
    finish_reason = 'tool_calls';
  } else if (result.finalAction === STAY_ON_NODE_ACTION) {
    finish_reason = 'length';
  }

  // Calculate usage (simplified, mirrors the legacy behavior).
  const promptTokens = countTokens(result.messages.map(m => m.content || '').join('\n'));
  const completionTokens = countTokens(result.outputText);
  const usage: TokenUsage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };

  const responseData = {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(startTime / 1000),
    model: data.model,
    choices: [{
      index: 0,
      message: responseMessage,
      finish_reason,
    }],
    usage,
    messages: result.messages as FlujoChatMessage[],
    conversation_id: result.conversationId,
    status: result.sharedState.status || (result.finalAction === FINAL_RESPONSE_ACTION ? 'completed' : 'running'),
    pendingToolCalls: result.sharedState.pendingToolCalls,
  };

  log.info(`Returning success response for conv ${result.conversationId}`, { action: result.finalAction, status: responseData.status, flujo, requireApproval, flujodebug, finish_reason });
  log.verbose(`Final response data for conv ${result.conversationId}`, JSON.stringify(responseData));

  return NextResponse.json(responseData);
}

// Main entry point for chat completion processing
export async function processChatCompletion(
  data: ChatCompletionRequest,
  flujo: boolean,
  requireApproval: boolean,
  flujodebug: boolean,
  conversationId?: string,
  continueDebug: boolean = false,
  userTurn: boolean = false
) {
  // Handle streaming requests differently
  if (data.stream === true) {
    // Generate a conversation ID if not provided
    const effectiveConvId = conversationId || crypto.randomUUID();
    log.info(`Streaming requested for conversation ${effectiveConvId}. Starting async processing.`);

    // Start processing asynchronously (don't await)
    // The reference in FlowExecutor.conversationStates will prevent garbage collection
    processChatCompletionInternal(data, flujo, requireApproval, flujodebug, effectiveConvId, continueDebug, userTurn)
      .catch(error => {
        // Log any errors that occur during processing
        log.error(`Error in background processing for conversation ${effectiveConvId}:`, error);

        // Ensure the conversation state reflects the error
        const errorState = FlowExecutor.conversationStates.get(effectiveConvId);
        if (errorState) {
          errorState.status = 'error';
          errorState.lastResponse = {
            success: false,
            error: error instanceof Error ? error.message : String(error)
          };
          FlowExecutor.conversationStates.set(effectiveConvId, errorState);

          // Also save to storage
          const storageKey = `conversations/${effectiveConvId}` as StorageKey;
          persistState(storageKey, errorState).catch(storageError => {
            log.error(`Failed to save error state for conversation ${effectiveConvId}:`, storageError);
          });
        }
      });

    // Return streaming response immediately
    return createStreamingResponse(data.model, effectiveConvId);
  } else {
    // Non-streaming path - use the internal function directly
    return processChatCompletionInternal(data, flujo, requireApproval, flujodebug, conversationId, continueDebug, userTurn);
  }
}

// Create a streaming response using Server-Sent Events (SSE)
export function createStreamingResponse(
  model: string,
  conversationId: string
) {
  const encoder = new TextEncoder();
  const chunkId = `chatcmpl-${Date.now()}`; // Use the same ID for all chunks in this stream
  const createdTimestamp = Math.floor(Date.now() / 1000);
  log.debug(`create streaming response`)
  // Create a ReadableStream for SSE
  const stream = new ReadableStream({
    async start(controller) {
      let lastState: any = null;
      let lastAssistantContent: string = '';
      let lastAssistantId: string | undefined = undefined;
      let retryCount = 0;

      // Send initial response with role
      const initialChunk = JSON.stringify({
        id: chunkId,
        object: "chat.completion.chunk",
        created: createdTimestamp,
        model: model,
        choices: [{
          index: 0,
          delta: { role: "assistant", content: "" },
          finish_reason: null
        }]
      });
      controller.enqueue(encoder.encode(`data: ${initialChunk}\n\n`));

      // Poll until processing is complete
      while (true) {
        try {
          // Fetch current conversation state
          const response = await fetch(`http://localhost:4200/v1/chat/conversations/${conversationId}`);

          if (!response.ok) {
            log.error(`Failed to fetch conversation: ${response.status}`)
            throw new Error(`Failed to fetch conversation: ${response.status}`);
          }

          const currentState = await response.json();

          // Calculate and send delta if we have a previous state
          if (lastState) {
            // Check if the state has changed
            if (JSON.stringify(lastState) !== JSON.stringify(currentState)) {
              // Find the last assistant message to extract content
              const messages = currentState.messages || [];
              const lastAssistantMsg = [...messages].reverse().find(m => m.role === 'assistant');

              if (lastAssistantMsg && typeof lastAssistantMsg.content === 'string') {
                const currentContent = lastAssistantMsg.content;
                const currentAssistantId = lastAssistantMsg.id;

                // Check if this is a new message or an update to an existing one
                const isNewMessage = currentAssistantId !== lastAssistantId;

                // If it's a new message, send the entire content
                // If it's an existing message with changed content, send only the delta
                if (isNewMessage) {
                  log.debug(`New assistant message detected with ID: ${currentAssistantId}`);
                  lastAssistantId = currentAssistantId;
                  lastAssistantContent = currentContent;

                  // For a new message, send the entire content as the delta
                  // This ensures we don't miss any content
                  const newContent = currentContent;

                  // Send a unified chunk with both content and conversation state
                  const unifiedChunk = JSON.stringify({
                    id: chunkId,
                    object: "chat.completion.chunk",
                    created: createdTimestamp,
                    model: model,
                    choices: [{
                      index: 0,
                      delta: {
                        content: newContent,
                        conversation: currentState
                      },
                      finish_reason: null
                    }]
                  });
                  controller.enqueue(encoder.encode(`data: ${unifiedChunk}\n\n`));
                }
                // If content has changed and it's longer than before, calculate the delta
                else if (currentContent !== lastAssistantContent && currentContent.length > lastAssistantContent.length) {
                  // Get the new content that was added
                  const newContent = currentContent.slice(lastAssistantContent.length);

                  // Send a unified chunk with both content delta and conversation state
                  const unifiedChunk = JSON.stringify({
                    id: chunkId,
                    object: "chat.completion.chunk",
                    created: createdTimestamp,
                    model: model,
                    choices: [{
                      index: 0,
                      delta: {
                        content: newContent,
                        conversation: currentState
                      },
                      finish_reason: null
                    }]
                  });
                  controller.enqueue(encoder.encode(`data: ${unifiedChunk}\n\n`));

                  // Update the last assistant content
                  lastAssistantContent = currentContent;
                }
                // If the state changed but the content didn't, still send the state update
                else if (currentContent === lastAssistantContent) {
                  // Send a unified chunk with empty content delta but updated conversation state
                  const stateOnlyChunk = JSON.stringify({
                    id: chunkId,
                    object: "chat.completion.chunk",
                    created: createdTimestamp,
                    model: model,
                    choices: [{
                      index: 0,
                      delta: {
                        content: "",
                        conversation: currentState
                      },
                      finish_reason: null
                    }]
                  });
                  controller.enqueue(encoder.encode(`data: ${stateOnlyChunk}\n\n`));
                }
              } else {
                // No assistant message found, but state changed - send state update only
                const stateOnlyChunk = JSON.stringify({
                  id: chunkId,
                  object: "chat.completion.chunk",
                  created: createdTimestamp,
                  model: model,
                  choices: [{
                    index: 0,
                    delta: {
                      content: "",
                      conversation: currentState
                    },
                    finish_reason: null
                  }]
                });
                controller.enqueue(encoder.encode(`data: ${stateOnlyChunk}\n\n`));
              }
            }

            // Check if processing is complete by checking the status in FlowExecutor.conversationStates
            // This is more reliable than checking the conversation endpoint which might not have the latest status
            const memoryState = FlowExecutor.conversationStates.get(conversationId);
            const status = memoryState?.status || 'running';

            if (status === 'completed' || status === 'error') {
              // Send final chunk with both empty delta and the final conversation state
              const finalChunk = JSON.stringify({
                id: chunkId,
                object: "chat.completion.chunk",
                created: createdTimestamp,
                model: model,
                choices: [{
                  index: 0,
                  delta: {
                    content: "",
                    conversation: currentState
                  },
                  finish_reason: status === 'error' ? "error" : "stop"
                }]
              });
              controller.enqueue(encoder.encode(`data: ${finalChunk}\n\n`));

              // Send standard OpenAI empty delta chunk
              const openAiFinalChunk = JSON.stringify({
                id: chunkId,
                object: "chat.completion.chunk",
                created: createdTimestamp,
                model: model,
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: status === 'error' ? "error" : "stop"
                }]
              });
              controller.enqueue(encoder.encode(`data: ${openAiFinalChunk}\n\n`));

              // Send [DONE] to indicate end of stream
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              break;
            }
          }

          // Update last state and reset retry count
          lastState = currentState;
          retryCount = 0;

          // Wait 1 second before next poll
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          log.error(`Error during streaming for conversation ${conversationId}:`, error);

          // Handle error with retry
          if (retryCount < 1) {
            retryCount++;
            log.info(`Retrying after error (attempt ${retryCount}) for conversation ${conversationId}`);
            // Wait 5 seconds before retry
            await new Promise(resolve => setTimeout(resolve, 5000));
          } else {
            // Send error with unified format
            const errorChunk = JSON.stringify({
              id: chunkId,
              object: "chat.completion.chunk",
              created: createdTimestamp,
              model: model,
              choices: [{
                index: 0,
                delta: {
                  content: "Error during streaming: " + (error instanceof Error ? error.message : "Unknown error"),
                  conversation: { error: error instanceof Error ? error.message : "Unknown error" }
                },
                finish_reason: "error"
              }]
            });
            controller.enqueue(encoder.encode(`data: ${errorChunk}\n\n`));

            // Also send standard OpenAI error format for compatibility
            const openAiErrorChunk = JSON.stringify({
              error: {
                message: error instanceof Error ? error.message : "Unknown error during streaming",
                type: "streaming_error",
                code: "streaming_failed"
              }
            });
            controller.enqueue(encoder.encode(`data: ${openAiErrorChunk}\n\n`));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            break;
          }
        }
      }

      // Close the stream
      controller.close();
    }
  });

  // Return the stream as a Response
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    }
  });
}
