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
import { resolveEffectiveMaxTokens } from './maxTokens';
import { normalizeMaxTokens } from '@/shared/types/model';
import { getCompletionAdapter } from '@/backend/services/model/adapters';
import { mapOpenAiUsage } from '@/backend/services/model/adapters/openaiUsage';
import { mcpService } from '@/backend/services/mcp';
import { DEFAULT_TOOL_CALL_TIMEOUT_SECONDS } from '@/shared/types/mcp';
import { extractUiResourceUri } from '@/shared/utils/mcpApps';
import { getRunResourceSettings, writeRunResource, listRunResources } from '@/backend/services/runResources';
import { captureToolResult } from '@/backend/services/runResources/capture';
import { isRunResourceToolName, executeRunResourceTool, WRITE_RESOURCE_TOOL_NAME, READ_RESOURCE_TOOL_NAME } from './runResourceTools';
import type { RunResourceSettings } from '@/shared/types/runResources';
import type { ToolResourceMarker } from '@/backend/services/model/adapters/types';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { registerPendingApproval, listPendingToolCalls } from '@/backend/execution/flow/toolApprovalRegistry';
import { upsertMessageById } from '@/backend/execution/flow/conversationMessages';
import { v4 as uuidv4 } from 'uuid'; // Import uuid

const log = createLogger('backend/flow/execution/handlers/ModelHandler'
  // , LOG_LEVEL.VERBOSE // override for the current file
);

// How often the in-flight-completion cancellation watch polls the conversation's
// isCancelled flag. The flag lives in process memory (set by the cancel route),
// so polling is cheap; 250ms keeps Stop feeling immediate.
const CANCEL_POLL_MS = 250;

export class ModelHandler {
  /**
   * MCP Apps (#97): resolve a tool result's linked `ui://` UI resource, honoring
   * the per-server opt-in. Returns the `{ uri, serverName }` link only when the
   * result carries a SEP-1865 `_meta.ui.resourceUri` AND the server has
   * `enableMcpApps` turned on. The opt-in is enforced here (server-side) so an
   * un-opted server's HTML is never even referenced to the browser. The config
   * lookup only runs when a UI link is actually present (rare), so it adds no
   * per-call cost to ordinary tools.
   */
  private static async resolveToolUiLink(
    serverName: string,
    resultData: unknown
  ): Promise<{ uri: string; serverName: string } | undefined> {
    const meta = (resultData as { _meta?: unknown } | null | undefined)?._meta;
    const uri = extractUiResourceUri(meta);
    if (!uri) return undefined;
    try {
      const configs = await mcpService.loadServerConfigs();
      if (!Array.isArray(configs)) return undefined;
      const config = configs.find((c) => c.name === serverName);
      if (!config?.enableMcpApps) return undefined;
      return { uri, serverName };
    } catch (error) {
      log.warn(`resolveToolUiLink: failed to check MCP Apps opt-in for ${serverName}`, error);
      return undefined;
    }
  }

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
   * Whether the conversation (or any ancestor, for subflow children) has been
   * cancelled. Read from the live in-memory states — the same source the run
   * loop's own guard uses — via lazy requires to avoid the static import cycle
   * (FlowExecutor -> ProcessNode -> ModelHandler). Best-effort: any failure
   * reads as "not cancelled".
   */
  private static isConversationCancelled(conversationId: string): boolean {
    try {
      const { FlowExecutor } = require('@/backend/execution/flow/FlowExecutor');
      const { isCancelledByAncestry } = require('@/backend/execution/flow/cancellation');
      return isCancelledByAncestry(conversationId, FlowExecutor.conversationStates);
    } catch (err) {
      log.warn(`Cancellation check failed for conversation ${conversationId}`, { err });
      return false;
    }
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
   * Build the resource-aware truncation-marker lookup (issue #168): captured
   * run resources for oversized PRIOR tool results/args, keyed by the producing
   * tool_call_id. Only `tool-result` / `tool-args` captures carry a toolCallId
   * and are relevant here. Best-effort — any failure yields `undefined` and the
   * adapter falls back to plain truncation. The store index is cached, so this
   * is cheap per call.
   */
  private static async buildRunResourceMarkers(
    conversationId: string
  ): Promise<Map<string, ToolResourceMarker> | undefined> {
    try {
      const entries = await listRunResources(conversationId);
      let markers: Map<string, ToolResourceMarker> | undefined;
      for (const entry of entries) {
        const id = entry.producedBy?.toolCallId;
        if (!id) continue;
        const source = entry.producedBy.source;
        if (source !== 'tool-result' && source !== 'tool-args') continue;
        if (!markers) markers = new Map();
        const slot = markers.get(id) ?? {};
        if (source === 'tool-result') slot.result = entry;
        else slot.args = entry;
        markers.set(id, slot);
      }
      return markers;
    } catch (error) {
      log.warn(`Failed to build run-resource markers for conversation ${conversationId}`, error);
      return undefined;
    }
  }

  /**
   * Call model with tool support - performs a SINGLE API call.
   * Does NOT handle tool execution loops internally.
   */
  static async callModel(input: ModelCallInput): Promise<Result<ModelCallResult>> {
    // Remove iteration parameters as they are no longer handled here
    const { modelId, prompt, messages, wireMessages, tools, nodeName, nodeId, toolNameMap, maxTurns, maxTokens, conversationId, requireToolApproval } = input; // Added nodeId

    // Fetch model information for display name (and the model's own maxTurns / maxTokens caps)
    let modelDisplayName = '';
    let modelTechnicalName = '';
    let modelMaxTurns: number | undefined;
    let modelMaxTokens: number | undefined;
    const nodeDisplayName = nodeName;
    try {
      const model = await modelService.getModel(modelId);
      if (model) {
        modelDisplayName = model.displayName || model.name;
        modelTechnicalName = model.name;
        modelMaxTurns = model.maxTurns;
        modelMaxTokens = model.maxTokens;
      }
    } catch (error) {
      log.warn(`Failed to fetch model information for prefix: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Resolve the effective agentic-turn cap. Precedence: per-node override →
    // bound-model setting → system default (50). This replaces the former
    // hard-coded 30 that ProcessNode passed straight through as maxTurns and
    // caused long agentic runs (Claude subscription) to abort mid-execution (#48).
    const effectiveMaxTurns = resolveEffectiveMaxTurns(maxTurns, modelMaxTurns);

    // Resolve the effective per-completion output-token cap (#189). Precedence:
    // per-node override → bound-model maxTokens → adapter default. `undefined`
    // here means "let the adapter decide" (there is no numeric system default).
    const effectiveMaxTokens = resolveEffectiveMaxTokens(maxTokens, modelMaxTokens);

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

    // Cancellation watch for the in-flight provider call: pressing Stop sets the
    // conversation's isCancelled flag (own or an ancestor's, for subflow
    // children); generateCompletion polls this and aborts the call mid-stream
    // instead of letting the current model turn run to completion.
    const shouldAbort = conversationId
      ? () => ModelHandler.isConversationCancelled(conversationId)
      : undefined;

    // Run-resource tools (issue #161): self-orchestrating adapters (Claude
    // subscription) run their own tool loop and never surface tool calls to
    // FLUJO's loop, so the synthetic `write_resource` tool must be executed
    // in-loop via a localToolExecutor. Built only when the tool is actually
    // present + we have a conversation to scope the write to; the request/
    // response path handles the same tool in processToolCalls instead.
    const runResourceNode = nodeId ? { nodeId, nodeName: nodeDisplayName, nodeType: 'process' as const } : undefined;
    const localToolExecutors =
      conversationId && (tools ?? []).some((t) => t.type === 'function' && isRunResourceToolName(t.function.name))
        ? {
            [WRITE_RESOURCE_TOOL_NAME]: async (args: Record<string, unknown>): Promise<unknown> => {
              const outcome = await executeRunResourceTool(WRITE_RESOURCE_TOOL_NAME, args, {
                conversationId,
                node: runResourceNode,
                emit,
              });
              if (!outcome.success) throw new Error(outcome.error ?? 'write_resource failed');
              return outcome.data;
            },
            // read_resource (issue #168): lets a self-orchestrating model
            // dereference a flujo://run/... marker back to full content in-loop.
            [READ_RESOURCE_TOOL_NAME]: async (args: Record<string, unknown>): Promise<unknown> => {
              const outcome = await executeRunResourceTool(READ_RESOURCE_TOOL_NAME, args, {
                conversationId,
                node: runResourceNode,
                emit,
              });
              if (!outcome.success) throw new Error(outcome.error ?? 'read_resource failed');
              return outcome.data;
            },
          }
        : undefined;

    // Resource-aware truncation markers (issue #168): build a lookup of captured
    // run resources for oversized PRIOR tool results/args, keyed by the producing
    // tool_call_id, so the Claude-subscription adapter can emit a head excerpt +
    // a dereferenceable flujo://run/... marker instead of a plain `…[truncated]`.
    // Built once here (cheap — the store index is cached) and passed to the
    // adapter; request/response adapters ignore it.
    const runResourceMarkers = conversationId
      ? await ModelHandler.buildRunResourceMarkers(conversationId)
      : undefined;

    // Call generateCompletion ONCE. The provider sees `wireMessages` when a node
    // scoped its input (latest-message / isolated); otherwise it sees the full
    // `messages`. `finalMessages` below is always built from `messages`, so the
    // persisted/returned transcript keeps the complete history regardless.
    const response = await this.generateCompletion(modelId, prompt, wireMessages ?? messages, tools, {
      toolNameMap,
      maxTurns: effectiveMaxTurns,
      maxTokens: effectiveMaxTokens,
      requestToolApproval,
      onTranscriptMessage,
      shouldAbort,
      conversationId,
      nodeId,
      localToolExecutors,
      runResourceMarkers,
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
    //
    // Cache RE-READ tokens (Anthropic cache_read / OpenAI cached_tokens) live in
    // the provider's `prompt_tokens_details`. They ARE part of prompt_tokens; we
    // carry the subset separately so the UI can subtract them from the headline
    // instead of counting a warmed cache as fresh input every turn (#87, and its
    // OpenAI-path sibling #89). The mapping is a small pure helper so it can be
    // unit-tested (see __tests__/model/openaiUsageMapping.test.ts).
    const usage = mapOpenAiUsage(modelResponse.fullResponse?.usage);

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
      /** Effective per-completion output-token cap, already resolved by callModel
       *  (node override → model setting). Undefined ⇒ adapter default (#189). */
      maxTokens?: number;
      requestToolApproval?: (call: {
        id: string;
        name: string;
        args: Record<string, unknown>;
      }) => Promise<boolean>;
      onTranscriptMessage?: (message: FlujoChatMessage) => void;
      /** Polled while the provider call is in flight; true aborts it (Stop). */
      shouldAbort?: () => boolean;
      /** Conversation + node identity, so self-orchestrating adapters can key a
       * reusable Agent SDK session per (conversationId, nodeId) — issue #154. */
      conversationId?: string;
      nodeId?: string;
      /** Executors for caller-defined virtual tools (e.g. write_resource, issue
       * #161) run in-loop by self-orchestrating adapters. */
      localToolExecutors?: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
      /** Captured run resources for oversized prior tool results/args, keyed by
       * the producing tool_call_id; used by self-orchestrating adapters for
       * resource-aware truncation markers (issue #168). */
      runResourceMarkers?: Map<string, ToolResourceMarker>;
    }
  ): Promise<Result<ModelCallResult>> {
    // Add verbose logging of the input parameters
    log.verbose('generateCompletion input', ({
      modelId,
      prompt,
      messages,
      tools
    }));

    // Cancellation plumbing: the watch (below) polls opts.shouldAbort while the
    // provider call is in flight and fires this controller, which every adapter
    // forwards to its SDK's abort mechanism. Declared outside the try so the
    // catch can distinguish a user cancellation from a genuine provider error.
    const abortController = new AbortController();
    let cancelWatch: ReturnType<typeof setInterval> | undefined;
    const stopCancelWatch = () => {
      if (cancelWatch) {
        clearInterval(cancelWatch);
        cancelWatch = undefined;
      }
    };

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

      // Start the cancellation watch just before the (possibly long) provider
      // call. A Stop pressed at any point during the call aborts it within
      // CANCEL_POLL_MS instead of waiting for the turn to finish.
      if (opts?.shouldAbort) {
        if (opts.shouldAbort()) {
          abortController.abort();
        } else {
          const watch = () => {
            if (opts.shouldAbort!()) {
              log.info('Cancellation detected mid-completion; aborting the provider call.', { modelId });
              abortController.abort();
              stopCancelWatch();
            }
          };
          cancelWatch = setInterval(watch, CANCEL_POLL_MS);
          // Never keep the process alive just for the watch.
          cancelWatch.unref?.();
        }
      }
      if (abortController.signal.aborted) {
        return {
          success: false,
          error: createModelError('cancelled', 'Execution cancelled by user.', modelId),
        };
      }

      // Make the API request through the selected adapter.
      let chatCompletion: OpenAI.Chat.Completions.ChatCompletion;
      let transcript: FlujoChatMessage[] | undefined;
      try {
        ({ completion: chatCompletion, transcript } = await adapter.createCompletion({
          model,
          apiKey: decryptedApiKey,
          messages: apiMessages,
          tools: sanitizedTools,
          temperature,
          // Effective output-token cap: node-level override → per-model default
          // (resolved in callModel, #189), falling back to the per-model value
          // for any caller that doesn't pass one. Undefined ⇒ adapter default.
          maxTokens: opts?.maxTokens ?? normalizeMaxTokens(model.maxTokens),
          toolNameMap: opts?.toolNameMap,
          localToolExecutors: opts?.localToolExecutors,
          maxTurns: opts?.maxTurns,
          requestToolApproval: opts?.requestToolApproval,
          onTranscriptMessage: opts?.onTranscriptMessage,
          signal: abortController.signal,
          conversationId: opts?.conversationId,
          nodeId: opts?.nodeId,
          runResourceMarkers: opts?.runResourceMarkers,
        }));
      } finally {
        stopCancelWatch();
      }

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
      stopCancelWatch();

      // A user cancellation aborted the in-flight call: whatever error shape the
      // SDK threw (OpenAI APIUserAbortError, DOMException AbortError, the Agent
      // SDK's teardown error, ...), report it as a clean cancellation — not a
      // provider failure.
      if (abortController.signal.aborted) {
        log.info('Provider call aborted by user cancellation.', { modelId });
        return {
          success: false,
          error: createModelError('cancelled', 'Execution cancelled by user.', modelId),
        };
      }

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
    const { toolCalls, toolNameMap, emit, conversationId, node } = input;

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
      for (let callIndex = 0; callIndex < toolCalls.length; callIndex++) {
        const toolCall = toolCalls[callIndex];
        const { id, function: { name, arguments: argsString } } = toolCall;

        // Cancellation check between tool calls (issue #109): a Stop pressed
        // while an earlier tool in this batch ran must not start the next one.
        // Every remaining call still gets a tool-result message so the
        // transcript stays well-formed (each tool_call id answered) — the run
        // loop terminates on its own cancellation guard right after.
        if (input.shouldAbort?.()) {
          log.info(`Cancellation detected before tool call ${name}; skipping the remaining ${toolCalls.length - callIndex} call(s).`);
          for (const remaining of toolCalls.slice(callIndex)) {
            toolCallMessages.push({
              id: uuidv4(),
              role: "tool",
              tool_call_id: remaining.id,
              content: 'Execution cancelled by user before this tool call ran.',
              timestamp: Date.now()
            });
          }
          break;
        }

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

          // Run-resource tools (issue #161): synthetic FLUJO tools that write a
          // run artifact, dispatched here (not via mcpService) using the run's
          // conversationId already in scope. Only offered when a produce node is
          // wired (ProcessNode.prep), so this branch is inert for other flows.
          if (isRunResourceToolName(name)) {
            emit?.({ type: 'tool:call', toolCallId: id, name, args: argsString });
            const outcome = await executeRunResourceTool(name, args, { conversationId, node, emit });
            const resultContent = outcome.success
              ? JSON.stringify(outcome.data)
              : `Error: ${outcome.error}`;
            emit?.({
              type: 'tool:result',
              toolCallId: id,
              name,
              result: resultContent.length > 500 ? `${resultContent.slice(0, 500)}…` : resultContent,
              isError: !outcome.success,
            });
            toolCallMessages.push({
              id: uuidv4(),
              role: 'tool',
              tool_call_id: id,
              content: resultContent,
              timestamp: Date.now(),
            });
            processedToolCalls.push({ name, args, id, result: resultContent });
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

          // Run-resource settings drive both the tool-args capture (below,
          // before the call) and the tool-result auto-capture (after the call).
          // Fetched once here, only when we have a conversation to scope writes
          // to — so legacy/ephemeral call sites keep byte-identical behaviour.
          let runResourceSettings: RunResourceSettings | undefined;
          if (conversationId) {
            try {
              runResourceSettings = await getRunResourceSettings();
            } catch (error) {
              log.warn('Failed to load run-resource settings; skipping capture', error);
            }
          }

          // Tier 3 / issue #168: capture oversized tool-call PARAMETERS as a run
          // resource (source 'tool-args', keyed by the toolCallId) so a
          // downstream self-orchestrating adapter can render a dereferenceable
          // marker instead of dropping them. Lineage-only at execution time —
          // the active call below still runs with the FULL args. Never fails the
          // run: any store error is logged and skipped.
          if (
            conversationId &&
            runResourceSettings?.autoCaptureEnabled &&
            typeof argsString === 'string' &&
            argsString.length >= runResourceSettings.textThresholdChars
          ) {
            try {
              const writtenArgs = await writeRunResource({
                conversationId,
                mimeType: 'application/json',
                kind: 'text',
                data: { text: argsString },
                producedBy: {
                  source: 'tool-args',
                  nodeId: node?.nodeId,
                  server: serverName,
                  toolName,
                  toolCallId: id,
                },
              });
              if (!('skipped' in writtenArgs)) {
                emit?.({
                  type: 'resource:write',
                  node,
                  server: 'flujo',
                  uri: writtenArgs.uri,
                  name: writtenArgs.name,
                  mimeType: writtenArgs.mimeType,
                  size: writtenArgs.size,
                  source: 'tool-args',
                  toolCallId: id,
                });
              }
            } catch (error) {
              log.error('Tool-args capture failed; continuing with the call', error);
            }
          }

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

          // Tier 3 data flow: auto-capture binary/large tool results as
          // run-scoped resources. The capture may rewrite the result (binary
          // items become URI stubs — base64 in a tool message costs context
          // and helps no model); everything captured is announced as a
          // resource:write event carrying the producing toolCallId (the stable
          // lineage key — runFlow rewrites tool-MESSAGE ids afterwards).
          // Capture never breaks the run: on any failure the original result
          // is kept untouched.
          let effectiveData = result.data;
          if (result.success && conversationId && runResourceSettings) {
            try {
              if (runResourceSettings.autoCaptureEnabled) {
                const outcome = await captureToolResult({
                  conversationId,
                  server: serverName,
                  toolName,
                  toolCallId: id,
                  nodeId: node?.nodeId,
                  result: result.data as CallToolResult,
                  settings: runResourceSettings,
                });
                effectiveData = outcome.result;
                for (const entry of outcome.captured) {
                  emit?.({
                    type: 'resource:write',
                    node,
                    server: 'flujo',
                    uri: entry.uri,
                    name: entry.name,
                    mimeType: entry.mimeType,
                    size: entry.size,
                    source: 'tool-result',
                    toolCallId: id,
                  });
                }
              }
            } catch (error) {
              log.error('Run-resource auto-capture failed; keeping original tool result', error);
              effectiveData = result.data;
            }
          }

          // Format the result
          const resultContent = result.success
            ? JSON.stringify(effectiveData)
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

          // MCP Apps (#97): if the server linked this tool to a `ui://` UI
          // resource (SEP-1865 `_meta.ui.resourceUri`) AND has the per-server
          // opt-in enabled, attach the link so chat can render it sandboxed.
          const uiLink = result.success
            ? await ModelHandler.resolveToolUiLink(serverName, result.data)
            : undefined;

            // Add tool result message with timestamp and ID
            toolCallMessages.push({
              id: uuidv4(), // Generate unique ID
              role: "tool",
              tool_call_id: id,
              content: resultContent,
              timestamp: Date.now(), // Add timestamp
              ...(uiLink ? { ui: uiLink } : {})
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
