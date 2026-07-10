import { createLogger, LOG_LEVEL } from '@/utils/logger';
import {
  ModelCallInput,
  ModelCallResult,
  ToolCallProcessingInput,
  ToolCallProcessingResult
} from '../types/modelHandler';
import { ToolCallInfo } from '../types'; // Import ToolCallInfo
import { FlujoChatMessage } from '@/shared/types/chat'; // Correct import path for FlujoChatMessage
import { Result, ExecutionError } from '../errors';
import { createModelError, createToolError } from '../errorFactory';
import { decodeToolName } from './toolNamespace';
import { toApiMessages } from '../buildNodeContext';
import OpenAI from 'openai';
import { modelService } from '@/backend/services/model';
import { resolveEffectiveMaxTurns } from './maxTurns';
import { getCompletionAdapter } from '@/backend/services/model/adapters';
import { mcpService } from '@/backend/services/mcp';
import { DEFAULT_TOOL_CALL_TIMEOUT_SECONDS } from '@/shared/types/mcp';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { registerPendingApproval, listPendingToolCalls } from '@/backend/execution/flow/toolApprovalRegistry';
import { upsertMessageById } from '@/backend/execution/flow/conversationMessages';
import { v4 as uuidv4 } from 'uuid'; // Import uuid

const log = createLogger('backend/flow/execution/handlers/ModelHandler'
  // , LOG_LEVEL.VERBOSE // override for the current file
);

export class ModelHandler {
  /**
   * Normalize a provider error body into a detailed, human-readable message
   * plus structured detail fields.
   *
   * The same provider error shape reaches us two ways: when the provider
   * returns HTTP 200 with an `error` object in the body, and when the SDK
   * throws an `OpenAI.APIError` (whose `.error` is that same body). Both paths
   * call this so the extraction stays consistent. OpenRouter in particular
   * nests the real upstream reason under `metadata` — `raw` is usually a plain
   * human-readable string (occasionally a JSON string), and `provider_name` /
   * `retry_after_seconds` are the actionable bits. Requesty tags every error
   * body with `origin` ("router" = its own validation, "provider" = a relayed
   * upstream error) — surfaced in the message because it decides whether the
   * request was actually malformed or the upstream backend just rejected it.
   *
   * @param body       The provider error object (chatCompletion.error or APIError.error).
   * @param baseMessage Optional prefix (e.g. the SDK's "429 ..." message) to build on.
   */
  private static extractProviderErrorDetails(
    body: any,
    baseMessage?: string
  ): {
    message: string;
    code?: unknown;
    type?: unknown;
    param?: unknown;
    retryAfter?: string;
    providerError?: unknown;
  } {
    let message =
      baseMessage || body?.message || 'Provider returned an unspecified error in the response body.';

    // When a base message is supplied (SDK path), append the body's own message
    // if it adds something beyond the prefix.
    if (
      baseMessage &&
      typeof body?.message === 'string' &&
      body.message &&
      body.message !== baseMessage
    ) {
      message = `${baseMessage} - ${body.message}`;
    }

    const meta = body?.metadata;
    if (meta) {
      let rawMsg: string | undefined;
      if (typeof meta.raw === 'string') {
        try {
          const parsed = JSON.parse(meta.raw);
          rawMsg = parsed?.error?.message || parsed?.message || meta.raw;
        } catch {
          rawMsg = meta.raw; // not JSON — use the string as-is
        }
      } else if (meta.raw && typeof meta.raw === 'object') {
        rawMsg = meta.raw.error?.message || meta.raw.message;
      }
      const upstreamParts: string[] = [];
      if (meta.provider_name) upstreamParts.push(String(meta.provider_name));
      if (rawMsg) upstreamParts.push(rawMsg);
      if (upstreamParts.length > 0) {
        message = `${message} (upstream: ${upstreamParts.join(': ')})`;
      }
    }

    // Requesty's origin tag: "router" vs "provider" (see doc comment above).
    if (typeof body?.origin === 'string' && body.origin) {
      message = `${message} (origin: ${body.origin})`;
    }

    return {
      message,
      code: body?.code,
      type: body?.type,
      param: body?.param,
      retryAfter: meta?.retry_after_seconds != null ? String(meta.retry_after_seconds) : undefined,
      providerError: body,
    };
  }

  /**
   * Fold a message streamed from a self-orchestrating adapter (Claude
   * subscription) into the conversation's live in-memory SharedState AS it is
   * produced (keyed by id, so it is idempotent w.r.t. the same message being
   * materialized again at end-of-run).
   *
   * Crash/error safety no longer needs a full-file state write here: the
   * caller emits the same message on the event bus immediately before this
   * call, and the bus tap APPENDS it to the conversation log — if the run
   * dies mid-loop, tool calls/results that already executed (SAP objects
   * created, tickets opened, ...) are recovered from the log when the
   * snapshot is next loaded (recoverMessagesFromLog). Dropping the write
   * removed the per-streamed-message O(file size) rewrite on long agentic
   * runs (execution-core v2 Phase 3).
   *
   * Best-effort: it must never throw into (or block) the streaming path.
   */
  private static persistStreamedMessage(conversationId: string, message: FlujoChatMessage): void {
    try {
      // Lazy require to avoid a static import cycle
      // (FlowExecutor -> ProcessNode -> ModelHandler).
      const { FlowExecutor } = require('@/backend/execution/flow/FlowExecutor');
      const state = FlowExecutor.conversationStates.get(conversationId);
      if (!state || !Array.isArray(state.messages)) {
        // Conversation not tracked in memory yet; the normal end-of-run save covers it.
        return;
      }
      upsertMessageById(state.messages, message);
      state.updatedAt = Date.now();
    } catch (err) {
      log.warn(`Failed to fold streamed message into conversation ${conversationId}`, { err });
    }
  }

  /**
   * Call model with tool support - performs a SINGLE API call.
   * Does NOT handle tool execution loops internally.
   */
  static async callModel(input: ModelCallInput): Promise<Result<ModelCallResult>> {
    // Remove iteration parameters as they are no longer handled here
    const { modelId, prompt, messages, tools, nodeName, nodeId, toolNameMap, maxTurns, conversationId, requireToolApproval } = input; // Added nodeId

    // Fetch model information for display name (and the model's own maxTurns cap)
    let modelDisplayName = '';
    let modelTechnicalName = '';
    let modelMaxTurns: number | undefined;
    const nodeDisplayName = nodeName;
    try {
      const model = await modelService.getModel(modelId);
      if (model) {
        modelDisplayName = model.displayName || model.name;
        modelTechnicalName = model.name;
        modelMaxTurns = model.maxTurns;
      }
    } catch (error) {
      log.warn(`Failed to fetch model information for prefix: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Resolve the effective agentic-turn cap. Precedence: per-node override →
    // bound-model setting → system default (50). This replaces the former
    // hard-coded 30 that ProcessNode passed straight through as maxTurns and
    // caused long agentic runs (Claude subscription) to abort mid-execution (#48).
    const effectiveMaxTurns = resolveEffectiveMaxTurns(maxTurns, modelMaxTurns);

    log.info(`callModel - Single execution`, {
      modelId,
      messagesCount: messages.length,
      toolsCount: tools?.length || 0,
      nodeName,
      nodeId // Log nodeId
    });

    // Add verbose logging of the entire input
    log.verbose('callModel input', input);

    // When approval is required and we have a conversation to surface it on, build
    // a human-in-the-loop gate for self-orchestrating adapters (Claude
    // subscription). It registers each tool call in the shared approval registry,
    // announces it on the conversation's event stream (the existing
    // run:awaiting_approval UI), and blocks until the /respond route resolves it.
    // One emit function bound to this conversation, reused for the approval gate
    // and the live transcript sink below.
    const emit = conversationId ? executionEventBus.emitterFor(conversationId) : undefined;

    const requestToolApproval =
      requireToolApproval && emit && conversationId
        ? async (call: { id: string; name: string; args: Record<string, unknown> }): Promise<boolean> => {
            const toolCall: OpenAI.ChatCompletionMessageToolCall = {
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
            };
            return new Promise<boolean>((resolve) => {
              registerPendingApproval(conversationId, toolCall, resolve);
              emit({ type: 'run:awaiting_approval', pendingToolCalls: listPendingToolCalls(conversationId) });
            });
          }
        : undefined;

    // Live sink for self-orchestrating adapters (Claude subscription): surface
    // each assistant/tool message on the conversation's event stream AS it is
    // produced inside the adapter's agentic loop, rather than only when the whole
    // (possibly hour-long) call returns. The message carries a stable id that the
    // transcript materialization below reuses, so this live copy and the final
    // persisted copy dedupe in the UI. Emitting also keeps the frontend's
    // "no activity" timer reset while background tool calls are in flight.
    const onTranscriptMessage = emit
      ? (message: FlujoChatMessage) => {
          const withNode: FlujoChatMessage = nodeId ? { ...message, processNodeId: nodeId } : message;
          emit({ type: 'message', message: withNode, node: nodeId ? { nodeId } : undefined });
          // Also fold it into the live shared state and persist immediately, so a
          // failure mid-loop (before the normal end-of-run save) doesn't discard
          // tool calls/results that already executed (e.g. SAP objects, tickets).
          if (conversationId) ModelHandler.persistStreamedMessage(conversationId, withNode);
        }
      : undefined;

    // Call generateCompletion ONCE
    const response = await this.generateCompletion(modelId, prompt, messages, tools, {
      toolNameMap,
      maxTurns: effectiveMaxTurns,
      requestToolApproval,
      onTranscriptMessage,
    });

    if (!response.success) {
      // Add verbose logging of the error response
      log.verbose('callModel error response', response);

      // Ensure we're returning the complete error response with all details
      return {
        success: false,
        error: response.error
      };
    }

    const modelResponse = response.value;
    const content = modelResponse.content || '';
    const finalMessages: FlujoChatMessage[] = [...messages]; // Start with input messages (already FlujoChatMessage)

    // // Check if content already starts with a heading pattern like "## ... says:"
    // const hasHeadingPattern = /^## .+says:\s*\n\n/i.test(content);
    
    // // Format content with prefix only if it doesn't already have a heading pattern
    // const prefixedContent = modelDisplayName && !hasHeadingPattern
    //   ? `## ${nodeDisplayName} - ${modelDisplayName} (${modelTechnicalName}) says:\n\n${content}`
    //   : content;
    
    const prefixedContent = content;

    // Extract provider-reported token usage, if present, so the UI can show
    // per-message and aggregated token/cost figures.
    const rawUsage = modelResponse.fullResponse?.usage;
    const usage = rawUsage
      ? {
          promptTokens: rawUsage.prompt_tokens ?? 0,
          completionTokens: rawUsage.completion_tokens ?? 0,
          totalTokens: rawUsage.total_tokens ?? 0,
        }
      : undefined;

    if (modelResponse.transcript && modelResponse.transcript.length > 0) {
      // Self-orchestrating adapter (Claude subscription): the adapter already ran
      // the agentic tool loop in-process and handed back the full assistant/tool
      // sequence. Materialize each into the conversation so the tool calls +
      // results are visible, attaching usage to the final message.
      const baseTs = Date.now();
      const transcript = modelResponse.transcript;
      transcript.forEach((msg, idx) => {
        const isLast = idx === transcript.length - 1;
        finalMessages.push({
          ...msg,
          // Preserve the id/timestamp the adapter assigned (and live-emitted via
          // onTranscriptMessage) so the persisted message dedupes against the
          // already-streamed copy instead of duplicating it in the UI.
          id: msg.id ?? uuidv4(),
          timestamp: msg.timestamp ?? baseTs + idx, // keep ordering stable
          processNodeId: nodeId,
          ...(isLast && usage ? { usage } : {}),
        } as FlujoChatMessage);
      });
    } else {
      // Create the assistant message with timestamp and ID
      const assistantMessage: FlujoChatMessage = {
        id: uuidv4(), // Generate unique ID
        role: 'assistant',
        content: prefixedContent,
        // IMPORTANT: Include tool_calls if they exist in the raw response
        tool_calls: modelResponse.fullResponse?.choices?.[0]?.message?.tool_calls,
        timestamp: Date.now(), // Add timestamp
        processNodeId: nodeId, // Attach the process node ID
        ...(usage ? { usage } : {}),
      };
      finalMessages.push(assistantMessage);
    }

    // Map tool calls for the result structure (if they exist)
    // This provides structured info about requested calls, but doesn't execute them
    const toolCalls = modelResponse.fullResponse?.choices?.[0]?.message?.tool_calls?.map((tc: OpenAI.ChatCompletionMessageToolCall) => { // Add type annotation for tc
       try {
         return {
           name: tc.function.name,
           args: JSON.parse(tc.function.arguments),
           id: tc.id,
           result: '' // Result is empty as it's not processed here
         };
       } catch (e) {
         log.warn(`Failed to parse tool arguments for call ${tc.id}`, { args: tc.function.arguments, error: e });
         return {
           name: tc.function.name,
           args: {}, // Use empty object on parse failure
           id: tc.id,
           result: ''
         };
       }
    }).filter(Boolean) as ToolCallInfo[] | undefined; // Ensure type safety and filter out potential nulls if parse fails badly


    // Return the result of this single step
    const result: Result<ModelCallResult> = {
      success: true,
      value: {
        content, // Final assistant text (from the model response / adapter)
        messages: finalMessages, // Include the new assistant message (now FlujoChatMessage[])
        fullResponse: modelResponse.fullResponse,
        toolCalls // Pass the structured tool calls info
      }
    };

    log.verbose('callModel single step result', result);
    return result;
  }



  /**
   * Generate completion using model service - pure function
   */
  private static async generateCompletion(
    modelId: string,
    prompt: string,
    messages: FlujoChatMessage[], // Expect FlujoChatMessage
    tools?: OpenAI.ChatCompletionTool[],
    opts?: {
      toolNameMap?: Record<string, { server: string; tool: string }>;
      maxTurns?: number;
      requestToolApproval?: (call: {
        id: string;
        name: string;
        args: Record<string, unknown>;
      }) => Promise<boolean>;
      onTranscriptMessage?: (message: FlujoChatMessage) => void;
    }
  ): Promise<Result<ModelCallResult>> {
    // Add verbose logging of the input parameters
    log.verbose('generateCompletion input', ({
      modelId,
      prompt,
      messages,
      tools
    }));
    try {
      // Get the model
      const model = await modelService.getModel(modelId);
      if (!model) {
        return {
          success: false,
          error: createModelError(
            'model_not_found',
            `Model not found: ${modelId}`,
            modelId
          )
        };
      }

      // Extract model settings
      const temperature = model.temperature ? parseFloat(model.temperature) : 0.0;

      // Resolve and decrypt the API key
      const decryptedApiKey = await modelService.resolveAndDecryptApiKey(model.ApiKey);
      if (!decryptedApiKey) {
        return {
          success: false,
          error: createModelError(
            'api_key_error',
            'Failed to resolve or decrypt API key',
            modelId
          )
        };
      }
      log.verbose(`decrypted api key ${decryptedApiKey}`)
      log.verbose(` baseurl ${model.baseUrl}`)

      // Create the request parameters - the adapters expect ChatCompletionMessageParam,
      // not FlujoChatMessage, so strip ALL FLUJO-internal fields (id, timestamp,
      // processNodeId, usage, ...) before sending — strict providers 400 on unknown
      // message fields. Also strips handoff plumbing (the handoff tool-call turn,
      // its result, the synthetic "Continue") from the WIRE view only — the threaded
      // history kept in SharedState is untouched. So a node handed off to sees a
      // clean conversation. See ~/.claude/plans/execution-core-v2.md.
      const apiMessages: OpenAI.ChatCompletionMessageParam[] = toApiMessages(messages);

      // Sanitize tool schemas for broad provider compatibility (handles string
      // properties with unsupported `format` values, etc.). Done once here so
      // every adapter receives clean tool definitions.
      let sanitizedTools: OpenAI.ChatCompletionTool[] | undefined;
      if (tools && tools.length > 0) {
        const { ToolHandler } = require('../handlers/ToolHandler');
        sanitizedTools = tools.map(tool => {
          if (tool.type === 'function' && tool.function.parameters) {
            return {
              ...tool,
              function: {
                ...tool.function,
                parameters: ToolHandler.sanitizeSchema(tool.function.parameters)
              }
            };
          }
          return tool;
        });
      }

      // Select the completion adapter for this model's provider/SDK. The
      // OpenAI-compatible adapter wraps the original hardened-client path; the
      // native adapters (Anthropic, Gemini, Claude CLI) translate to/from their
      // own APIs but return the same OpenAI-shaped response, so everything below
      // is provider-agnostic.
      const adapter = getCompletionAdapter(model);

      log.debug(`calling chatcompletion`)
      log.verbose('calling chatcompletion now with ADAPTER', model.adapter || 'openai')
      log.verbose('calling chatcompletion now with MODEL', model.name)
      log.verbose('calling chatcompletion now with TEMP', temperature)
      log.verbose('calling chatcompletion now with MESSAGES', apiMessages)
      log.verbose('calling chatcompletion now with TOOLS', sanitizedTools)

      // --- Log the exact request being sent ---
      log.debug('[ModelHandler.generateCompletion] Sending request via adapter', { adapter: model.adapter || 'openai', model: model.name });

      // Make the API request through the selected adapter.
      const { completion: chatCompletion, transcript } = await adapter.createCompletion({
        model,
        apiKey: decryptedApiKey,
        messages: apiMessages,
        tools: sanitizedTools,
        temperature,
        toolNameMap: opts?.toolNameMap,
        maxTurns: opts?.maxTurns,
        requestToolApproval: opts?.requestToolApproval,
        onTranscriptMessage: opts?.onTranscriptMessage,
      });

      // --- Log the raw response received ---
      log.debug('[ModelHandler.generateCompletion] Received raw response from OpenAI API', { response: chatCompletion }); // Use debug level

      log.verbose(`chatcompletion returned`) // Keep verbose for backward compatibility if needed
      log.verbose('chatcompletion returned', chatCompletion) // Keep verbose

      // --- Check for top-level error in the response ---
      // Some providers (like OpenRouter for certain errors) might return a 200 OK
      // with an error object in the body instead of throwing an HTTP error.
      if (chatCompletion && typeof chatCompletion === 'object' && 'error' in chatCompletion && chatCompletion.error) {
        log.warn('API call returned successfully but contained an error object:', JSON.stringify(chatCompletion.error));
        const errorObj = chatCompletion.error as any; // Type assertion for easier access

        // Shape the message + details consistently with the thrown-error path.
        const extracted = ModelHandler.extractProviderErrorDetails(errorObj);

        const errorResult: Result<ModelCallResult> = {
            success: false,
            error: createModelError(
                'api_error', // Treat as API error
                extracted.message,
                modelId,
                undefined,
                {
                    code: extracted.code,
                    type: extracted.type,
                    param: extracted.param,
                    retryAfter: extracted.retryAfter,
                    // The full parsed provider body is the richest source of truth.
                    providerError: extracted.providerError,
                }
            )
        };
        log.verbose('generateCompletion returning error from response body', errorResult);
        return errorResult;
      }
      // --- End error check ---


      // Create a standardized response with OpenAI-compatible structure
      // Ensure choices exist before accessing them
      const choice = chatCompletion?.choices?.[0];
      if (!choice) {
        log.error('API response missing choices array or first choice.', { response: chatCompletion });
        return {
          success: false,
          error: createModelError(
            'api_error',
            'Invalid response structure from API: Missing choices.',
            modelId,
            undefined,
            { rawResponse: chatCompletion }
          )
        };
      }

      const result: Result<ModelCallResult> = {
        success: true,
        // Use the validated choice object
        value: {
          content: choice.message?.content || '',
          messages: [...messages], // Return original messages with timestamps
          fullResponse: chatCompletion, // Return the full original response
          transcript // Present only for self-orchestrating adapters (Claude subscription)
        }
      };

      // Add verbose logging of the successful result
      log.verbose('generateCompletion success result', result);

      return result;
    } catch (error) {
      // --- Log the raw error object caught ---
      log.error('[ModelHandler.generateCompletion] Caught error during OpenAI API call', { rawError: error });

      // --- Enhanced Error Logging ---
      log.error('--- Error during openai.chat.completions.create ---');
      if (error instanceof Error) {
        log.error(`Error Name: ${error.name}`);
        log.error(`Error Message: ${error.message}`);
        log.error(`Error Stack: ${error.stack}`);
      } else {
        log.error('Caught non-Error object:', error); // Log the raw object if it's not an Error instance
      }
      if (error instanceof OpenAI.APIError) {
        log.error(`API Error Status: ${error.status}`);
        log.error(`API Error Type: ${error.type}`);
        log.error(`API Error Code: ${error.code}`);
        log.error(`API Error Param: ${error.param}`);
        log.error(`API Error Headers: ${JSON.stringify(error.headers)}`);
      }
      log.error('--- End Error Details ---');
      // --- End Enhanced Error Logging ---

      // Handle API errors
      if (error instanceof OpenAI.APIError) {
        // The SDK's APIError.message is often terse (e.g. "429 Provider returned
        // error"). The real reason lives in the parsed response body
        // (error.error); extractProviderErrorDetails digs it out so the user
        // sees something actionable instead of a generic line.
        const body = (error as any).error as any; // parsed response body, if any
        const extracted = ModelHandler.extractProviderErrorDetails(body, error.message);

        // Prefer the response header retry-after; fall back to the body's
        // metadata.retry_after_seconds (already surfaced by the helper).
        const headers = (error.headers || {}) as Record<string, unknown>;
        const headerRetryAfter = headers['retry-after'] ?? headers['Retry-After'];
        const retryAfter =
          headerRetryAfter !== undefined ? String(headerRetryAfter) : extracted.retryAfter;
        const rateLimitReset =
          headers['x-ratelimit-reset'] ?? headers['x-ratelimit-reset-requests'];

        const errorResult: Result<ModelCallResult> = {
          success: false,
          error: createModelError(
            'api_error',
            extracted.message,
            modelId,
            undefined,
            {
              status: error.status,
              // Prefer the body's values; fall back to the SDK's.
              type: extracted.type ?? error.type,
              code: extracted.code ?? error.code,
              param: extracted.param ?? error.param,
              retryAfter,
              rateLimitReset: rateLimitReset !== undefined ? String(rateLimitReset) : undefined,
              // The full parsed provider body is the richest source of truth.
              providerError: extracted.providerError,
              // Include stack trace if available
              stack: error.stack
            }
          )
        };

        // Add verbose logging of the API error
        log.verbose('generateCompletion API error', errorResult);

        return errorResult;
      }

      // Handle other errors
      const errorResult: Result<ModelCallResult> = {
        success: false,
        error: createModelError(
          'unknown_error',
          error instanceof Error ? error.message : String(error),
          modelId,
          undefined,
          {
            // Include stack trace if available
            stack: error instanceof Error ? error.stack : undefined
          }
        )
      };

      // Add verbose logging of the unknown error
      log.verbose('generateCompletion unknown error', errorResult);

      return errorResult;
    }
  }

  /**
   * Process tool calls - pure function
   */
  public static async processToolCalls( // Make public static
    input: ToolCallProcessingInput
  ): Promise<Result<ToolCallProcessingResult>> {
    const { toolCalls, toolNameMap, emit } = input;

    // Add verbose logging of the input
    log.verbose('processToolCalls input', input);

    if (!toolCalls || toolCalls.length === 0) {
      const emptyResult: Result<ToolCallProcessingResult> = {
        success: true,
        value: {
          toolCallMessages: [],
          processedToolCalls: []
        }
      };

      // Add verbose logging of the empty result
      log.verbose('processToolCalls empty result', emptyResult);

      return emptyResult;
    }

    try {
      // Array to collect new messages with tool results (using FlujoChatMessage)
      const toolCallMessages: FlujoChatMessage[] = [];
      const processedToolCalls: Array<{
        name: string;
        args: Record<string, unknown>;
        id: string;
        result: string;
      }> = [];

      // Process each tool call
      for (const toolCall of toolCalls) {
        const { id, function: { name, arguments: argsString } } = toolCall;

        try {
          // Parse the arguments
          const args = JSON.parse(argsString);
          log.info("trying to call tool", name)
          // Check if it's a handoff tool
          if (name.startsWith('handoff_to_') || name === 'handoff') {
            // Process handoff tool directly
            log.info(`Processing handoff tool: ${name}`);

            // Return success for handoff tools
            const result = {
              success: true,
              data: { handoff: true, args }
            };

            // Format the result
            const resultContent = JSON.stringify(result.data);

            // Add tool result message with timestamp and ID
            toolCallMessages.push({
              id: uuidv4(), // Generate unique ID
              role: "tool",
              tool_call_id: id,
              content: resultContent,
              timestamp: Date.now() // Add timestamp
            });

            // Add to processed tool calls
            processedToolCalls.push({
              name,
              args,
              id,
              result: resultContent
            });

            // Skip to the next tool call
            continue;
          }

          // Decode the model-facing name back to (server, tool). New names use the
          // mcp_<slug>_<hash> scheme (decoded via toolNameMap); legacy conversations
          // used _-_-_SERVER_-_-_TOOL (decoded by decodeToolName's fallback).
          const decoded = decodeToolName(name, toolNameMap);
          if (!decoded) {
            log.error("invalid tool format", name)
            throw new Error(`Invalid tool name format: ${name}`);
          }

          const serverName = decoded.server;
          const toolName = decoded.tool;

          emit?.({ type: 'tool:call', toolCallId: id, name, args: argsString });

          // Call the tool via MCP service. The timeout comes from the tool's MCP
          // node (properties.toolTimeout, seconds; -1 = none), defaulting to 5
          // minutes. Server progress notifications are forwarded as live
          // tool:progress events AND reset the SDK's request timer (see
          // services/mcp/tools.ts), so a finite timeout only kills silent calls.
          const timeout = decoded.timeout ?? DEFAULT_TOOL_CALL_TIMEOUT_SECONDS;
          const result = await mcpService.callTool(
            serverName,
            toolName,
            args,
            timeout,
            (progress) => emit?.({
              type: 'tool:progress',
              toolCallId: id,
              name,
              progress: progress.progress,
              total: progress.total,
              message: progress.message
            })
          );

          // Format the result
          const resultContent = result.success
            ? JSON.stringify(result.data)
            : `Error: ${result.error}`;

          // The full result reaches the conversation as the tool message below;
          // the event carries a preview so the log stays light.
          emit?.({
            type: 'tool:result',
            toolCallId: id,
            name,
            result: resultContent.length > 500 ? `${resultContent.slice(0, 500)}…` : resultContent,
            isError: !result.success
          });

            // Add tool result message with timestamp and ID
            toolCallMessages.push({
              id: uuidv4(), // Generate unique ID
              role: "tool",
              tool_call_id: id,
              content: resultContent,
              timestamp: Date.now() // Add timestamp
            });

          // Add to processed tool calls
          processedToolCalls.push({
            name,
            args,
            id,
            result: resultContent
          });
        } catch (error) {
          const errorMessage = `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
          emit?.({ type: 'tool:result', toolCallId: id, name, result: errorMessage, isError: true });
          // Add error message for this specific tool call with timestamp and ID
          toolCallMessages.push({
            id: uuidv4(), // Generate unique ID
            role: "tool",
            tool_call_id: id,
            content: errorMessage,
            timestamp: Date.now() // Add timestamp
          });

          // Add to processed tool calls with error
          processedToolCalls.push({
            name,
            args: {},
            id,
            result: errorMessage
          });
        }
      }

      const result: Result<ToolCallProcessingResult> = {
        success: true,
        value: {
          toolCallMessages,
          processedToolCalls
        }
      };

      // Add verbose logging of the successful result
      log.verbose('processToolCalls success result', result);

      return result;
    } catch (error) {
      const errorResult: Result<ToolCallProcessingResult> = {
        success: false,
        error: createToolError(
          'tool_processing_failed',
          error instanceof Error ? error.message : String(error),
          'unknown'
        )
      };

      // Add verbose logging of the error result
      log.verbose('processToolCalls error result', errorResult);

      return errorResult;
    }
  }

  /**
   * Check if response has tool calls - pure function
   */
  private static hasToolCalls(response: ModelCallResult): boolean {
    return !!(
      response.fullResponse?.choices?.[0]?.message?.tool_calls &&
      response.fullResponse.choices[0].message.tool_calls.length > 0
    );
  }
}
