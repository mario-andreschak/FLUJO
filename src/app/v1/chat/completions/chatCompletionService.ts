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
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { ExecutionEvent } from '@/shared/types/execution/events';
import { modelService } from '@/backend/services/model';

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
    // Tag origin so GET /api/runs/active can distinguish ad-hoc completions
    // runs from scheduled fires (issue #113).
    source: 'api',
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
  log.verbose(`Final response data for conv ${result.conversationId}`, responseData);

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
  // --- Direct model completions (`model-<identifier>`) ---
  // Issue #53: `/v1/chat/completions` differentiates `flow-` vs `model-`
  // requests. `model-` routes to a single-turn ModelService completion (no
  // flow, no conversation persistence, no MCP tool loop). Everything else
  // (`flow-` or legacy/unprefixed ids) keeps the existing flow path unchanged.
  if (typeof data.model === 'string' && data.model.startsWith('model-')) {
    // Flow-only flags are meaningless here; ignore them (but note it).
    if (flujo || requireApproval || flujodebug || conversationId) {
      log.debug('Ignoring flow-only flags on a direct model completion', {
        flujo,
        requireApproval,
        flujodebug,
        conversationId,
      });
    }
    return processDirectModelCompletion(data);
  }

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

        // Make sure any open SSE stream for this conversation terminates even if
        // the run threw before emitting run:done (runFlow emits run:done on its
        // own error paths, but a throw before/around it would otherwise hang the
        // stream).
        executionEventBus.emitterFor(effectiveConvId)({ type: 'run:done', status: 'error' });
      });

    // Return streaming response immediately
    return createStreamingResponse(data.model, effectiveConvId);
  } else {
    // Non-streaming path - use the internal function directly
    return processChatCompletionInternal(data, flujo, requireApproval, flujodebug, conversationId, continueDebug, userTurn);
  }
}

// --- Direct model completions (Issue #53) ---
//
// Single-turn pass-through to a configured FLUJO model via
// ModelService.generateChatCompletion. No flow, no conversation persistence,
// no MCP tool loop: one request → one provider call → one OpenAI-shaped
// response. Tools supplied by the client are forwarded per standard OpenAI
// semantics (the client executes its own tools).
async function processDirectModelCompletion(data: ChatCompletionRequest) {
  const identifier = data.model.slice('model-'.length);
  log.info('Processing direct model completion', {
    model: data.model,
    messageCount: data.messages?.length || 0,
    stream: data.stream,
    hasTools: Boolean(data.tools && data.tools.length > 0),
  });

  const result = await modelService.generateChatCompletion({
    modelIdentifier: identifier,
    messages: data.messages,
    temperature: data.temperature,
    tools: data.tools,
  });

  if (!result.success) {
    log.warn('Direct model completion failed', {
      model: data.model,
      code: result.error.code,
      statusCode: result.statusCode,
    });
    return NextResponse.json(
      {
        error: {
          message: result.error.message,
          type: result.error.type,
          code: result.error.code,
          param: result.error.param ?? null,
        },
      },
      { status: result.statusCode }
    );
  }

  if (data.stream === true) {
    return createDirectModelStreamingResponse(data.model, result.completion);
  }

  return NextResponse.json(result.completion);
}

// Emulate SSE streaming for a completion that already arrived in full — the
// same emulation the flow path uses for complete assistant messages: role
// chunk → one content chunk (+ tool_calls deltas if present) → empty-delta
// finish chunk → [DONE]. Deliberately NOT createStreamingResponse: that helper
// is coupled to FlowExecutor.conversationStates / the execution event bus,
// which this path bypasses entirely.
function createDirectModelStreamingResponse(
  model: string,
  completion: OpenAI.Chat.Completions.ChatCompletion
) {
  const encoder = new TextEncoder();
  const chunkId = completion.id || `chatcmpl-${Date.now()}`;
  const createdTimestamp = completion.created || Math.floor(Date.now() / 1000);
  const choice = completion.choices?.[0];
  const finishReason = choice?.finish_reason ?? 'stop';

  const stream = new ReadableStream({
    start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      const baseChunk = (delta: unknown, finish_reason: string | null) => ({
        id: chunkId,
        object: 'chat.completion.chunk',
        created: createdTimestamp,
        model,
        choices: [{ index: 0, delta, finish_reason }],
      });

      // Initial chunk announcing the assistant role (OpenAI convention).
      send(baseChunk({ role: 'assistant', content: '' }, null));

      const content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
      if (content.length > 0) {
        send(baseChunk({ content }, null));
      }

      const toolCalls = choice?.message?.tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        // Delta-shaped tool calls: each carries its index within the array.
        send(
          baseChunk(
            { tool_calls: toolCalls.map((tc, index) => ({ index, ...tc })) },
            null
          )
        );
      }

      // Standard OpenAI empty-delta terminator chunk, then [DONE].
      send(baseChunk({}, finishReason));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// Create a streaming response using Server-Sent Events (SSE).
//
// This subscribes to the in-process ExecutionEventBus (the same stream the live
// chat view uses) rather than polling the conversation over HTTP. The previous
// implementation fetched `http://localhost:4200/v1/chat/conversations/{id}`
// once per second and diffed the assistant content — an HTTP round-trip to the
// server's own port plus up-to-1s latency. Because the model layer is
// non-streamed, each assistant message arrives complete in a single `message`
// event, so we forward its content as one OpenAI chunk; the (non-standard)
// `conversation` field is read from the in-memory conversationStates map.
export function createStreamingResponse(
  model: string,
  conversationId: string
) {
  const encoder = new TextEncoder();
  const chunkId = `chatcmpl-${Date.now()}`; // Use the same ID for all chunks in this stream
  const createdTimestamp = Math.floor(Date.now() / 1000);
  log.debug('create streaming response (event-bus driven)', { conversationId });

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let unsubscribe: (() => void) | null = null;
      // Replay + live can both deliver an event; de-dupe on monotonic seq.
      let lastSeq = -1;

      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };

      const baseChunk = (delta: unknown, finish_reason: string | null) => ({
        id: chunkId,
        object: 'chat.completion.chunk',
        created: createdTimestamp,
        model,
        choices: [{ index: 0, delta, finish_reason }],
      });

      const finish = (status: 'completed' | 'error' | 'stop') => {
        if (closed) return;
        closed = true;
        const finishReason = status === 'error' ? 'error' : 'stop';
        const currentState = FlowExecutor.conversationStates.get(conversationId);
        // Final unified chunk: empty content delta + the final conversation state.
        send(baseChunk({ content: '', conversation: currentState }, finishReason));
        // Standard OpenAI empty-delta terminator chunk.
        send(baseChunk({}, finishReason));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        if (unsubscribe) unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const handleEvent = (event: ExecutionEvent) => {
        if (closed) return;
        if (event.seq <= lastSeq) return; // de-dupe replay vs live
        lastSeq = event.seq;

        if (event.type === 'message') {
          const msg = event.message;
          if (msg && msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.length > 0) {
            // Content chunks carry ONLY the delta. The full conversation state
            // (the non-standard `conversation` field) is attached once, on the
            // final chunk in finish() — embedding it per chunk serialized the
            // entire growing conversation O(chunks) times per run.
            send(baseChunk({ content: msg.content }, null));
          }
        } else if (event.type === 'run:done') {
          finish(event.status === 'error' ? 'error' : 'completed');
        } else if (event.type === 'run:awaiting_approval' || event.type === 'run:paused') {
          // A streaming run that pauses (tool approval / debug) produces no more
          // content on this request; close the stream cleanly instead of hanging
          // (the old poller would have spun until the client disconnected).
          finish('stop');
        }
      };

      // Initial chunk announcing the assistant role (OpenAI convention).
      send(baseChunk({ role: 'assistant', content: '' }, null));

      // Subscribe for live events, then replay anything already buffered (the run
      // is fired just before this, so the buffer is normally empty; replay covers
      // a run that completed unusually fast). seq de-dup keeps ordering correct.
      unsubscribe = executionEventBus.subscribe(conversationId, handleEvent);
      for (const buffered of executionEventBus.getBufferedSince(conversationId, 0)) {
        handleEvent(buffered);
      }

      // If the conversation is already terminal (e.g. resumed and complete),
      // close immediately so the client isn't left waiting for an event that
      // will never come.
      if (!closed) {
        const existing = FlowExecutor.conversationStates.get(conversationId);
        if (existing && (existing.status === 'completed' || existing.status === 'error')) {
          finish(existing.status === 'error' ? 'error' : 'completed');
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
