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
import { decodeToolName, assertToolIdentityFresh } from './toolNamespace';
import { toApiMessages } from '../buildNodeContext';
import { compactForWire, couldCompact, wireHasRunResourceUri } from './compactForWire';
import OpenAI from 'openai';
import { modelService } from '@/backend/services/model';
import { resolveEffectiveMaxTurns } from './maxTurns';
import { resolveEffectiveMaxTokens } from './maxTokens';
import { resolveEffectiveCompaction } from './resolveEffectiveCompaction';
import { compactHistory, estimateTokens } from './summarizingCompaction';
import { normalizeMaxTokens } from '@/shared/types/model';
import { isSelfOrchestratingAdapter } from '@/shared/types/model/provider';
import { getCompletionAdapter } from '@/backend/services/model/adapters';
import { mapOpenAiUsage, OpenAiUsageLike } from '@/backend/services/model/adapters/openaiUsage';
import { fingerprintPrefix, classifyDrift, logCacheOutcome, derivePromptCacheKey } from './promptCacheMetrics';
import { trimTools } from './trimToolBlock';
import { mcpService } from '@/backend/services/mcp';
import { runWithConcurrency } from '@/backend/services/mcp/utils/boundedConcurrency';
import { DEFAULT_TOOL_CALL_TIMEOUT_SECONDS } from '@/shared/types/mcp';
import { extractUiResourceUri } from '@/shared/utils/mcpApps';
import { getRunResourceSettings, writeRunResource, listRunResources } from '@/backend/services/runResources';
import { captureToolResult } from '@/backend/services/runResources/capture';
import { boundToolResult } from '@/backend/services/runResources/boundToolResult';
import { isRunResourceToolName, executeRunResourceTool, buildReadResourceTool, WRITE_RESOURCE_TOOL_NAME, READ_RESOURCE_TOOL_NAME } from './runResourceTools';
import { isQuestionToolName, executeQuestionTool, QUESTION_TOOL_NAME } from './runQuestionTool';
import { isTodoToolName, executeTodoTool, TODO_TOOL_NAME } from './todoTool';
import { isMCPResourceToolName, executeMCPResourceTool, LIST_MCP_RESOURCES_TOOL_NAME } from './mcpResourceTools';
import type { RunResourceSettings } from '@/shared/types/runResources';
import type { ToolResourceMarker } from '@/backend/services/model/adapters/types';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { registerPendingApproval, listPendingToolCalls } from '@/backend/execution/flow/toolApprovalRegistry';
import { upsertMessageById } from '@/backend/execution/flow/conversationMessages';
import { loadItem } from '@/utils/storage/backend';
import { StorageKey, type Settings } from '@/shared/types/storage/storage';
import { normaliseOllamaRoot, withOllamaLock, getLoadedModel, setLoadedModel } from '@/backend/services/ollama/modelRegistry';
import { unloadModel } from '@/backend/services/ollama';
import { evaluatePermission, extractResource } from '@/backend/execution/flow/permissionEngine';
import { v4 as uuidv4 } from 'uuid'; // Import uuid

const log = createLogger('backend/flow/execution/handlers/ModelHandler'
  // , LOG_LEVEL.VERBOSE // override for the current file
);

/**
 * Issue #252: default per-server cap on concurrent tool calls within a single
 * model turn, used when a server declares no `maxConcurrency`. Deliberately
 * conservative — the old serial loop implicitly capped every server at 1, so we
 * stay low to avoid overwhelming servers that were protected by serialization.
 */
const DEFAULT_TOOL_CALL_CONCURRENCY = 4;

/**
 * Returns true for adapters/providers that require the wire to end with a
 * user or tool role. Anthropic's API (and every proxy that forwards to it,
 * including OpenRouter and Requesty) does NOT support "assistant prefill" —
 * passing a trailing role:"assistant" message causes a 400.
 *
 * OpenAI itself permits a trailing assistant turn for steering (prefill),
 * but only on its own endpoints. We therefore guard on provider identity.
 */
function requiresUserLastMessage(model: { adapter?: string; provider?: string }): boolean {
  return (
    model.adapter === 'anthropic' ||
    model.provider === 'openrouter' ||
    model.provider === 'requesty' ||
    // Anthropic-OpenAI-format endpoint also rejects trailing assistant
    (model.provider === 'anthropic' && model.adapter === 'openai')
  );
}

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
    toolName: string,
    resultData: unknown
  ): Promise<{ uri: string; serverName: string } | undefined> {
    // The link may ride on the tool RESULT's `_meta` (FLUJO's original Phase-1
    // assumption) OR — as the ext-apps SDK and the github-mcp-server actually do
    // it — on the tool DEFINITION's `_meta.ui.resourceUri`. Check the result
    // first (cheap, already in hand); only fall back to a tools/list lookup when
    // the result carries no link, so ordinary tools add no per-call cost.
    let uri = extractUiResourceUri((resultData as { _meta?: unknown } | null | undefined)?._meta);
    if (!uri) {
      try {
        const { tools } = await mcpService.listServerTools(serverName);
        const def = Array.isArray(tools) ? tools.find((t) => t.name === toolName) : undefined;
        uri = extractUiResourceUri((def as { _meta?: unknown } | undefined)?._meta);
      } catch (error) {
        log.warn(`resolveToolUiLink: failed to list tools for ${serverName}`, error);
      }
    }
    if (!uri) return undefined;
    try {
      // Built-in servers (filesystem/bash/flujo) are first-party FLUJO code — their
      // apps are trusted and always allowed, no per-server opt-in required.
      const { isBuiltInServerName } = await import('@/backend/services/mcp/internal/registry');
      if (isBuiltInServerName(serverName)) return { uri, serverName };
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
   * Read the experimental `claudeSessionResume` flag (issue #154) from the
   * persisted Settings blob. Reading the backend storage directly is fine here
   * — the HTTP-route lock gate does not apply to in-process reads, and Settings
   * are not encrypted. Best-effort: any failure (or a missing value) reads as
   * disabled, so the adapter keeps its always-correct full-flatten behaviour.
   */
  private static async isClaudeSessionResumeEnabled(): Promise<boolean> {
    try {
      const settings = await loadItem<Settings | undefined>(StorageKey.SPEECH_SETTINGS, undefined);
      return Boolean(settings?.experimental?.claudeSessionResume);
    } catch (err) {
      log.warn('Failed to read claudeSessionResume setting; defaulting to disabled', { err });
      return false;
    }
  }

  /**
   * Read the experimental summarizing-compaction settings (issue #248) from the
   * persisted Settings blob. Best-effort: any failure reads as disabled, so the
   * completion path keeps its existing (wire-only) behaviour.
   */
  private static async getCompactionGlobalSettings(): Promise<{
    compactionEnabled?: boolean;
    compactionBufferTokens?: number;
    compactionKeepTokens?: number;
  }> {
    try {
      const settings = await loadItem<Settings | undefined>(StorageKey.SPEECH_SETTINGS, undefined);
      const exp = settings?.experimental;
      return {
        compactionEnabled: exp?.compactionEnabled,
        compactionBufferTokens: exp?.compactionBufferTokens,
        compactionKeepTokens: exp?.compactionKeepTokens,
      };
    } catch (err) {
      log.warn('Failed to read compaction settings; defaulting to disabled', { err });
      return {};
    }
  }

  /**
   * Summarizing compaction pre-flight (issue #248). When the experimental
   * `compactionEnabled` setting is on and the persisted history is estimated to
   * be about to overflow the model's context window, summarize the OLD part of
   * the conversation into an anchored-summary head and persist it (the summary
   * becomes the new conversation head; the pre-summary slice is captured as a
   * recoverable run resource). Returns `{ summaryMessage, removedIds }` so the
   * caller can also apply the same head-swap to THIS turn's wire, or `null` when
   * compaction did not run (disabled, no context-window info, under threshold,
   * nothing old enough, or the summary model call failed — all safe no-ops that
   * fall through to the existing wire-only path).
   *
   * Strictly gated: OFF by default and a pure no-op when disabled, so existing
   * behaviour is unchanged for every user who hasn't opted in. Best-effort: any
   * failure is swallowed and treated as "did not compact".
   */
  private static async maybeCompactPersistedHistory(
    conversationId: string,
    nodeId: string | undefined,
    model: { id: string; adapter?: string; contextWindow?: number; compactionThreshold?: number },
    effectiveMaxTokens: number | undefined,
  ): Promise<{ summaryMessage: FlujoChatMessage; removedIds: string[] } | null> {
    try {
      // Self-orchestrating adapters manage their own session/wire; excluded.
      if (isSelfOrchestratingAdapter(model.adapter)) return null;

      const global = await ModelHandler.getCompactionGlobalSettings();
      const eff = resolveEffectiveCompaction(undefined, model, global);
      if (!eff.enabled) return null;

      const { FlowExecutor } = require('@/backend/execution/flow/FlowExecutor');
      const state = FlowExecutor.conversationStates.get(conversationId);
      if (!state || !Array.isArray(state.messages) || state.messages.length < 4) return null;

      // Estimate the current request size. Prefer the last provider-reported
      // prompt-token figure (authoritative), else the char/4 heuristic.
      let lastPromptTokens: number | undefined;
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const u = (state.messages[i] as FlujoChatMessage).usage;
        if (u && typeof u.promptTokens === 'number' && u.promptTokens > 0) {
          lastPromptTokens = u.promptTokens;
          break;
        }
      }
      const estimate = lastPromptTokens ?? estimateTokens(state.messages);

      // The trigger threshold: explicit per-model override, else derived from the
      // context window minus head-room for the reply + a safety buffer. Without
      // any context-window info we cannot pre-flight safely — no-op.
      const threshold =
        eff.threshold ??
        (model.contextWindow
          ? model.contextWindow - Math.max(effectiveMaxTokens ?? 0, eff.bufferTokens)
          : undefined);
      if (threshold === undefined || threshold <= 0 || estimate < threshold) return null;

      log.info('Summarizing-compaction pre-flight triggered', {
        conversationId,
        nodeId,
        estimate,
        threshold,
        messages: state.messages.length,
      });

      const summarize = async (
        msgs: FlujoChatMessage[],
        prompt: { system: string; user: string },
      ): Promise<string> => {
        const callMessages: FlujoChatMessage[] = [
          { id: uuidv4(), role: 'system', content: prompt.system, timestamp: Date.now() } as FlujoChatMessage,
          ...msgs,
          { id: uuidv4(), role: 'user', content: prompt.user, timestamp: Date.now() } as FlujoChatMessage,
        ];
        // A bounded, tool-free completion. Reuses the same provider path but must
        // NOT recurse into compaction (no conversationId keyed state to compact,
        // and the summary history is a throwaway slice).
        const res = await ModelHandler.generateCompletion(model.id, '', callMessages, undefined, {
          maxTokens: Math.min(effectiveMaxTokens ?? 4000, 4000),
        });
        return res.success ? (res.value.content ?? '') : '';
      };

      const writeAnchor = async (text: string): Promise<string | undefined> => {
        try {
          const written = await writeRunResource({
            conversationId,
            name: 'compaction-anchor',
            mimeType: 'application/json',
            kind: 'text',
            data: { text },
            producedBy: { source: 'tool-result', nodeId },
          });
          return 'skipped' in written ? undefined : written.uri;
        } catch {
          return undefined;
        }
      };

      const before = [...state.messages];
      const result = await compactHistory(
        state.messages,
        { keepTokens: eff.keepTokens, nodeId },
        { summarize, writeAnchor },
      );
      if (!result) return null;

      // Persist: swap the history head in SharedState and reconcile the log so the
      // summary head + removals are durable and auditable, then snapshot.
      state.messages = result.newMessages;
      state.updatedAt = Date.now();
      try {
        const { reconcileConversationLog } = require('@/backend/execution/flow/conversationLog');
        await reconcileConversationLog(state, before);
        const { persistConversationState } = require('@/backend/execution/flow/persistConversationState');
        await persistConversationState(`conversations/${conversationId}` as StorageKey, state);
      } catch (persistError) {
        log.warn('Compaction persisted-history reconcile/persist failed; continuing', { conversationId, persistError });
      }

      return { summaryMessage: result.summaryMessage, removedIds: result.removedIds };
    } catch (error) {
      log.warn('Summarizing-compaction pre-flight failed; falling back to existing behaviour', { conversationId, error });
      return null;
    }
  }

  /**
   * Read the `autoUnloadOllamaModels` flag from persisted settings.
   * Best-effort: any failure returns false (disabled).
   */
  private static async isAutoUnloadOllamaEnabled(): Promise<boolean> {
    try {
      const settings = await loadItem<Settings | undefined>(StorageKey.SPEECH_SETTINGS, undefined);
      return Boolean(settings?.experimental?.autoUnloadOllamaModels);
    } catch (err) {
      log.warn('Failed to read autoUnloadOllamaModels setting; defaulting to disabled', { err });
      return false;
    }
  }

  /**
   * Read the opt-in `toolDescriptionMaxChars` cap from the persisted Settings
   * blob. Best-effort like the flag above: any failure (or a missing value) reads
   * as 0, which leaves every tool description intact and keeps only the lossless
   * trimming tier active.
   */
  private static async toolDescriptionCap(): Promise<number> {
    try {
      const settings = await loadItem<Settings | undefined>(StorageKey.SPEECH_SETTINGS, undefined);
      const cap = settings?.experimental?.toolDescriptionMaxChars;
      return typeof cap === 'number' && cap > 0 ? cap : 0;
    } catch (err) {
      log.warn('Failed to read toolDescriptionMaxChars setting; leaving descriptions intact', { err });
      return 0;
    }
  }

  /**
   * Read the opt-in `historyKeepRecentMessages` compaction window from persisted
   * Settings (issue #286). Missing/invalid reads as 12 (the historical
   * `compactForWire` default), so behaviour is unchanged unless the user lowers
   * it to let short-but-tool-heavy conversations be compacted. Clamped to >= 2 so
   * a tail can never be too small to hold a tool_calls/tool pair verbatim.
   */
  private static async historyKeepRecentMessages(): Promise<number> {
    try {
      const settings = await loadItem<Settings | undefined>(StorageKey.SPEECH_SETTINGS, undefined);
      const keep = settings?.experimental?.historyKeepRecentMessages;
      if (typeof keep === 'number' && Number.isFinite(keep)) {
        return Math.max(2, Math.floor(keep));
      }
      return 12;
    } catch (err) {
      log.warn('Failed to read historyKeepRecentMessages setting; using default 12', { err });
      return 12;
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
   * Head chars kept when an oversized tool result is shrunk on the emergency
   * context-overflow retry (see generateCompletion). Also the threshold above
   * which a result is considered "oversized" for on-the-fly capture, so the two
   * stay consistent: anything the refit will truncate is first made recoverable.
   */
  private static readonly OVERFLOW_TOOL_RESULT_HEAD_CHARS = 2000;

  /**
   * True when a provider error is a context-window overflow (the request had
   * more prompt tokens than the model accepts), as opposed to any other API
   * failure. Matches the several wordings providers use ("maximum context
   * length", OpenAI's `context_length_exceeded`, OpenRouter's "reduce the
   * length", etc.) across the message, the error code/type, and the raw
   * provider body. Deliberately conservative: only these overflow-specific
   * phrases, so a generic 400 never triggers the (lossy) refit retry.
   */
  private static isContextOverflowError(error?: ExecutionError): boolean {
    if (!error || error.type !== 'model') return false;
    const details = (error.details ?? {}) as Record<string, unknown>;
    let providerText = '';
    try {
      providerText = JSON.stringify(details.providerError ?? '');
    } catch {
      /* circular/huge body — the message + code below are enough to decide */
    }
    const haystack =
      `${error.message ?? ''} ${String(details.code ?? '')} ${String(details.type ?? '')} ${providerText}`.toLowerCase();
    return (
      haystack.includes('context_length_exceeded') ||
      haystack.includes('maximum context length') ||
      haystack.includes('context length is') ||
      haystack.includes('maximum context') ||
      haystack.includes('reduce the length') ||
      haystack.includes('too many tokens') ||
      haystack.includes('exceeds the context')
    );
  }

  /**
   * Arm the synthetic `read_resource` tool when the wire references a run
   * resource URI but the offered tools don't yet expose read_resource — so a
   * `flujo://run/...` marker introduced by compaction is actually
   * dereferenceable. Dispatch is by-name (processToolCalls), so a late-added
   * tool still executes. The tool block is re-sorted by name to stay byte-stable
   * turn to turn (prefix cache, #89). Returns the tools unchanged when no arming
   * is needed.
   *
   * SAFETY NET ONLY as of the prefix-cache work: ProcessNode.prep now arms
   * read_resource up front for any step that could ever mint a run-resource URI
   * (MCP tools present, write_resource offered, resource nodes wired, native
   * resources exposed), so by the time compaction can produce a marker the tool
   * is already in the block and this is a no-op. It stays as a backstop for
   * non-ProcessNode callers and for conversations resumed from before that
   * change — but note that when it DOES fire it reshapes the tool block
   * mid-conversation and costs a full prefix-cache miss on that turn.
   */
  private static ensureReadResourceArmed(
    apiMessages: OpenAI.ChatCompletionMessageParam[],
    tools: OpenAI.ChatCompletionTool[] | undefined
  ): OpenAI.ChatCompletionTool[] | undefined {
    if (
      !wireHasRunResourceUri(apiMessages) ||
      (tools ?? []).some((t) => t.type === 'function' && t.function.name === READ_RESOURCE_TOOL_NAME)
    ) {
      return tools;
    }
    const def = buildReadResourceTool();
    const readTool: OpenAI.ChatCompletionTool = {
      type: 'function',
      function: {
        name: def.name,
        description: def.description || `Tool: ${def.name}`,
        parameters: def.inputSchema as Record<string, unknown>,
      },
    };
    return [...(tools ?? []), readTool].sort((a, b) =>
      a.type === 'function' && b.type === 'function'
        ? a.function.name < b.function.name
          ? -1
          : a.function.name > b.function.name
            ? 1
            : 0
        : 0
    );
  }

  /**
   * Emergency context-overflow recovery: make every oversized tool result on
   * the wire recoverable so it can be shrunk to a dereferenceable
   * `flujo://run/...` URI on the retry. Any oversized result whose tool_call_id
   * is NOT already backed by a captured resource is written to the run-resource
   * store on the fly and added to a fresh (augmented) markers map — so it can be
   * read back with `read_resource` instead of being lossily discarded. This
   * covers results that auto-capture missed (disabled, or produced before the
   * setting was on). Best-effort: any store failure just leaves that result
   * unmarked (it will be lossily truncated). Returns the markers map to use for
   * the refit.
   */
  private static async captureOversizedToolResultsForRefit(
    conversationId: string,
    apiMessages: OpenAI.ChatCompletionMessageParam[],
    existing: Map<string, ToolResourceMarker> | undefined,
    nodeId?: string
  ): Promise<Map<string, ToolResourceMarker> | undefined> {
    let markers: Map<string, ToolResourceMarker> | undefined = existing ? new Map(existing) : undefined;
    for (const msg of apiMessages) {
      if (msg.role !== 'tool' || typeof msg.content !== 'string') continue;
      if (msg.content.length <= ModelHandler.OVERFLOW_TOOL_RESULT_HEAD_CHARS) continue;
      const callId = msg.tool_call_id;
      if (markers?.get(callId)?.result?.uri) continue; // already recoverable
      try {
        const written = await writeRunResource({
          conversationId,
          mimeType: 'text/plain',
          kind: 'text',
          data: { text: msg.content },
          producedBy: { source: 'tool-result', nodeId, toolCallId: callId },
        });
        if ('skipped' in written) {
          log.warn(`Emergency capture of oversized tool result skipped (${written.skipped}); it will be lossily truncated`);
          continue;
        }
        if (!markers) markers = new Map();
        const slot = markers.get(callId) ?? {};
        slot.result = written;
        markers.set(callId, slot);
      } catch (error) {
        log.warn('Emergency capture of oversized tool result failed; it will be lossily truncated', error);
      }
    }
    return markers;
  }

  /**
   * Shape a thrown provider/SDK error into a standardized error Result. Shared
   * by every attempt of a completion call and the setup path, so cancellation,
   * OpenAI.APIError bodies, and unknown errors are all reported identically no
   * matter which attempt threw. `aborted` = the shared AbortController fired
   * (user Stop), reported as a clean cancellation rather than a provider failure.
   */
  private static shapeCompletionError(
    error: unknown,
    modelId: string,
    aborted: boolean
  ): Result<ModelCallResult> {
    // A user cancellation aborted the in-flight call: whatever error shape the
    // SDK threw (OpenAI APIUserAbortError, DOMException AbortError, the Agent
    // SDK's teardown error, ...), report it as a clean cancellation — not a
    // provider failure.
    if (aborted) {
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

    log.verbose('generateCompletion unknown error', errorResult);
    return errorResult;
  }

  /**
   * Call model with tool support - performs a SINGLE API call.
   * Does NOT handle tool execution loops internally.
   */
  static async callModel(input: ModelCallInput): Promise<Result<ModelCallResult>> {
    // Remove iteration parameters as they are no longer handled here
    const { modelId, prompt, messages, wireMessages, tools, nodeName, nodeId, toolNameMap, maxTurns, maxTokens, conversationId, requireToolApproval, mcpNodes } = input; // Added nodeId

    // Fetch model information for display name (and the model's own maxTurns / maxTokens caps)
    let modelDisplayName = '';
    let modelTechnicalName = '';
    let modelMaxTurns: number | undefined;
    let modelMaxTokens: number | undefined;
    let modelAdapter: string | undefined;
    let modelContextWindow: number | undefined;
    let modelCompactionThreshold: number | undefined;
    const nodeDisplayName = nodeName;
    try {
      const model = await modelService.getModel(modelId);
      if (model) {
        modelDisplayName = model.displayName || model.name;
        modelTechnicalName = model.name;
        modelMaxTurns = model.maxTurns;
        modelMaxTokens = model.maxTokens;
        modelAdapter = model.adapter;
        modelContextWindow = model.contextWindow;
        modelCompactionThreshold = model.compactionThreshold;
      }
    } catch (error) {
      log.warn(`Failed to fetch model information for prefix: ${error instanceof Error ? error.message : String(error)}`);
    }

    // #154 session reuse (experimental). Only for the self-orchestrating Claude
    // subscription adapter, only for FULL-HISTORY nodes (a scoped `wireMessages`
    // view can't be reconciled against the session's message-count watermark),
    // and only when the experimental setting is on. When off/ineligible the
    // adapter always re-flattens the whole history (the correct fallback).
    const sessionResume =
      modelAdapter === 'claude-cli' && !wireMessages
        ? await ModelHandler.isClaudeSessionResumeEnabled()
        : false;

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
        ? async (call: { id: string; name: string; args: Record<string, unknown> }): Promise<{ approved: boolean; feedback?: string }> => {
            const toolCall: OpenAI.ChatCompletionMessageToolCall = {
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
            };
            // Issue #247: surface the optional rejection feedback the /respond
            // route may pass so the adapter can carry it back to the model.
            return new Promise<{ approved: boolean; feedback?: string }>((resolve) => {
              registerPendingApproval(conversationId, toolCall, (approved, feedback) => resolve({ approved, feedback }));
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
    const hasRunResourceTool = conversationId && (tools ?? []).some((t) => t.type === 'function' && isRunResourceToolName(t.function.name));
    const hasMCPResourceTool = conversationId && (tools ?? []).some((t) => t.type === 'function' && isMCPResourceToolName(t.function.name));
    const hasQuestionTool = conversationId && (tools ?? []).some((t) => t.type === 'function' && isQuestionToolName(t.function.name));
    const hasTodoTool = conversationId && (tools ?? []).some((t) => t.type === 'function' && isTodoToolName(t.function.name));
    const localToolExecutors =
      (hasRunResourceTool || hasMCPResourceTool || hasQuestionTool || hasTodoTool)
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
            // Also dispatches native MCP resource URIs (issue #239) when mcpNodes is available.
            [READ_RESOURCE_TOOL_NAME]: async (args: Record<string, unknown>): Promise<unknown> => {
              const outcome = await executeRunResourceTool(READ_RESOURCE_TOOL_NAME, args, {
                conversationId,
                node: runResourceNode,
                emit,
                mcpNodes: mcpNodes ?? [],
              });
              if (!outcome.success) throw new Error(outcome.error ?? 'read_resource failed');
              return outcome.data;
            },
            // list_mcp_resources (issue #239): list native MCP server resources in-loop.
            [LIST_MCP_RESOURCES_TOOL_NAME]: async (args: Record<string, unknown>): Promise<unknown> => {
              const outcome = await executeMCPResourceTool(LIST_MCP_RESOURCES_TOOL_NAME, args, {
                conversationId,
                node: runResourceNode,
                emit,
                mcpNodes: mcpNodes ?? [],
              });
              if (!outcome.success) throw new Error(outcome.error ?? 'list_mcp_resources failed');
              return outcome.data;
            },
            // question (issue #258): lets a self-orchestrating model ask the user
            // a structured multiple-choice question in-loop and block on the
            // answer, same as the request/response path's processToolCalls branch.
            [QUESTION_TOOL_NAME]: async (args: Record<string, unknown>): Promise<unknown> => {
              const outcome = await executeQuestionTool(args, {
                conversationId,
                node: runResourceNode,
                emit,
                unattended: input.unattended,
              });
              if (!outcome.success) throw new Error(outcome.error ?? 'question failed');
              return outcome.data;
            },
            // todo (issue #259): lets a self-orchestrating model maintain its
            // run-scoped task list in-loop, same as the request/response path.
            [TODO_TOOL_NAME]: async (args: Record<string, unknown>): Promise<unknown> => {
              const outcome = await executeTodoTool(args, {
                conversationId,
                node: runResourceNode,
                emit,
              });
              if (!outcome.success) throw new Error(outcome.error ?? 'todo failed');
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

    // Summarizing-compaction pre-flight (issue #248). Only for FULL-HISTORY
    // nodes (a scoped `wireMessages` view can't be reconciled against the
    // persisted history) and only when the experimental `compactionEnabled`
    // setting is on — a pure no-op otherwise, so existing behaviour is unchanged
    // for everyone who hasn't opted in. When it runs, it persists an anchored
    // summary head into SharedState; we apply the SAME head-swap (by id) to this
    // turn's send view so the request the provider sees matches the compacted
    // history.
    let effectiveMessages = messages;
    if (conversationId && !wireMessages) {
      const compaction = await ModelHandler.maybeCompactPersistedHistory(
        conversationId,
        nodeId,
        { id: modelId, adapter: modelAdapter, contextWindow: modelContextWindow, compactionThreshold: modelCompactionThreshold },
        effectiveMaxTokens,
      );
      if (compaction) {
        const removed = new Set(compaction.removedIds);
        const firstRemovedIdx = effectiveMessages.findIndex((m) => removed.has(m.id));
        const kept = effectiveMessages.filter((m) => !removed.has(m.id));
        const insertAt = firstRemovedIdx < 0 ? 0 : Math.min(firstRemovedIdx, kept.length);
        effectiveMessages = [
          ...kept.slice(0, insertAt),
          compaction.summaryMessage,
          ...kept.slice(insertAt),
        ];
      }
    }

    // Call generateCompletion ONCE. The provider sees `wireMessages` when a node
    // scoped its input (latest-message / isolated); otherwise it sees the full
    // (possibly compacted) `effectiveMessages`. `finalMessages` below is always
    // built from `messages`, so the persisted/returned transcript keeps the
    // complete history regardless.
    const response = await this.generateCompletion(modelId, prompt, wireMessages ?? effectiveMessages, tools, {
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
      sessionResume,
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
    // Start from the (possibly compacted) send view, not the raw input: when
    // summarizing compaction (issue #248) ran pre-flight, `effectiveMessages`
    // carries the anchored summary head in place of the summarized older turns,
    // so the transcript written back to SharedState by post() stays consistent
    // with the compacted history that was persisted+logged. When compaction did
    // NOT run, `effectiveMessages === messages`, so this is unchanged.
    const finalMessages: FlujoChatMessage[] = [...effectiveMessages];

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
        toolCalls, // Pass the structured tool calls info
        effectiveMaxTurns, // #253: surface the resolved turn cap for runFlow's per-node counter
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
      }) => Promise<{ approved: boolean; feedback?: string }>;
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
      /** #154: opt-in to Agent SDK session reuse (resume + delta) for the Claude
       * subscription adapter. Resolved by callModel from the experimental setting
       * and node eligibility. */
      sessionResume?: boolean;
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

      // Resolve and decrypt the API key. Codex may run keyless: an empty key
      // means "use the machine's ChatGPT plan login from `codex login`" (the
      // adapter then omits the apiKey and the CLI falls back to its own auth).
      const resolvedKey = await modelService.resolveAndDecryptApiKey(model.ApiKey);
      const decryptedApiKey =
        resolvedKey || (model.adapter === 'codex-cli' && !model.ApiKey?.trim() ? '' : null);
      if (decryptedApiKey === null) {
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
      let apiMessages: OpenAI.ChatCompletionMessageParam[] = toApiMessages(messages);
      let effectiveTools: OpenAI.ChatCompletionTool[] | undefined = tools;

      // Strip trailing assistant message(s) for providers that require the last
      // message to be user/tool role. This is a wire-only mutation — sharedState is
      // not affected. Trailing assistant turns arise from:
      //   1. scopeMessagesForInput (latest-message mode, settled conversation)
      //   2. stripHandoffPlumbing (handoff prose → plain assistant turn)
      //   3. SubflowNode framed-result push
      if (requiresUserLastMessage(model)) {
        while (apiMessages.length > 0 && apiMessages[apiMessages.length - 1].role === 'assistant') {
          apiMessages = apiMessages.slice(0, -1);
          log.debug('Stripped trailing assistant message for provider that requires user-last wire', {
            provider: model.provider,
            adapter: model.adapter,
          });
        }
      }

      // Wire-only history compaction for request/response adapters. Agentic loops
      // re-send the whole growing history every turn; a single fat tool result
      // then rides along on every subsequent request and dominates fresh (non-
      // cached) prompt tokens. compactForWire shrinks oversized OLD tool results
      // and old assistant prose while keeping the recent tail verbatim and never
      // dropping a message (tool-pair integrity + prefix-cache stability). The
      // self-orchestrating Claude path ('claude-cli') is skipped: it flattens the
      // wire itself and has its own resource-aware truncation markers (issue #168).
      const keepRecentMessages = await ModelHandler.historyKeepRecentMessages();
      if (!isSelfOrchestratingAdapter(model.adapter) && couldCompact(apiMessages, { keepRecentMessages })) {
        apiMessages = compactForWire(apiMessages, {
          keepRecentMessages,
          resourceMarkers: opts?.runResourceMarkers,
        });
        // Truncation embeds a `flujo://run/...` URI when the full result was
        // captured (issue #168). ProcessNode.prep arms `read_resource` by
        // scanning the PRE-compaction wire, so a URI first surfaced HERE would be
        // undereferenceable. Arm it now if compaction introduced a run-resource
        // reference the offered tools don't yet cover.
        effectiveTools = ModelHandler.ensureReadResourceArmed(apiMessages, effectiveTools);
      }

      // Sanitize tool schemas for broad provider compatibility (handles string
      // properties with unsupported `format` values, etc.). Done once here so
      // every adapter receives clean tool definitions.
      let sanitizedTools: OpenAI.ChatCompletionTool[] | undefined;
      if (effectiveTools && effectiveTools.length > 0) {
        const { ToolHandler } = require('../handlers/ToolHandler');
        sanitizedTools = effectiveTools.map(tool => {
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

      // Shrink the serialized tool block. It is the largest fixed cost of a
      // tool-using step and stateless Chat Completions re-sends it on every turn of
      // the agentic loop, so bytes removed here are saved once per turn. Lossless
      // by default (schema bookkeeping keywords, titles that restate the property
      // name, template-literal indentation in descriptions); description CAPPING is
      // applied only when the user opted in via `toolDescriptionMaxChars`. Pure
      // function of its input, so the block stays byte-stable turn to turn (#89).
      if (sanitizedTools && sanitizedTools.length > 0) {
        const descriptionMaxChars = await ModelHandler.toolDescriptionCap();
        const { tools: trimmed, beforeChars, afterChars } = trimTools(sanitizedTools, {
          descriptionMaxChars,
        });
        sanitizedTools = trimmed;
        if (afterChars < beforeChars) {
          log.debug('Tool block trimmed before send', {
            beforeChars,
            afterChars,
            savedChars: beforeChars - afterChars,
          });
        }
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

      // --- Auto-unload Ollama: resolve setting and root URL once, before the
      // attempt closure captures them.  The lock is per root URL so parallel
      // fan-out lanes that target DIFFERENT servers are not serialised. ---
      const autoUnloadOllama = (model.provider === 'ollama' && Boolean(model.baseUrl))
        ? await ModelHandler.isAutoUnloadOllamaEnabled()
        : false;
      const ollamaRootForUnload = autoUnloadOllama && model.baseUrl
        ? normaliseOllamaRoot(model.baseUrl)
        : null;

      // One retryable attempt at the provider call. Extracted into a closure so
      // a context-length overflow (below) can be retried once with oversized
      // tool results shrunk to run-resource URIs, WITHOUT duplicating the
      // cancellation watch, body-error check, and response shaping. Each attempt
      // starts its own cancellation watch (the shared abortController persists,
      // so a Stop during attempt 1 stays aborted and blocks a retry). Never
      // throws — a thrown SDK error is shaped into an error Result in-place.
      const attempt = async (
        attemptMessages: OpenAI.ChatCompletionMessageParam[],
        attemptTools: OpenAI.ChatCompletionTool[] | undefined
      ): Promise<Result<ModelCallResult>> => {
        // Start the cancellation watch just before the (possibly long) provider
        // call. A Stop pressed at any point during the call aborts it within
        // CANCEL_POLL_MS instead of waiting for the turn to finish.
        if (opts?.shouldAbort) {
          if (opts.shouldAbort()) {
            abortController.abort();
          } else if (!cancelWatch) {
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

        try {
          // Fingerprint the cacheable prefix of THIS attempt (tool block + system
          // message) and classify what drifted since the previous call on this
          // conversation, so the cache outcome logged below can be attributed to a
          // cause instead of just reported as a number. Observation only.
          const prefixFingerprint = fingerprintPrefix(attemptMessages, attemptTools);
          const prefixDrift = classifyDrift(opts?.conversationId, prefixFingerprint);

          // Make the API request through the selected adapter.
          let chatCompletion: OpenAI.Chat.Completions.ChatCompletion;
          let transcript: FlujoChatMessage[] | undefined;
          try {
            // --- Auto-unload Ollama (opt-in feature, issue #242) ---
            // When enabled and this is an Ollama model, wrap the completion
            // inside a per-URL async lock so that:
            //   1. Concurrent fan-out lanes on the SAME Ollama server are
            //      serialised (prevents race on the loaded-model registry).
            //   2. If a DIFFERENT model was the last to run on this server,
            //      issue an explicit keep_alive:0 unload before loading the
            //      new one — freeing VRAM on GPU-constrained hardware.
            // When disabled (default), zero overhead: falls straight through.
            const issueCompletion = async () => adapter.createCompletion({
              model,
              apiKey: decryptedApiKey,
              messages: attemptMessages,
              tools: attemptTools,
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
              sessionResume: opts?.sessionResume,
              // Derived from the tool-block hash, so every request sharing this
              // prefix routes to the same prompt-cache shard (see
              // derivePromptCacheKey). Adapters that don't support it ignore it.
              promptCacheKey: derivePromptCacheKey(prefixFingerprint),
            });

            if (autoUnloadOllama && ollamaRootForUnload) {
              ({ completion: chatCompletion, transcript } = await withOllamaLock(
                ollamaRootForUnload,
                async () => {
                  const prev = getLoadedModel(ollamaRootForUnload);
                  if (prev && prev !== model.name) {
                    log.info(
                      `[ModelHandler] Auto-unloading Ollama model "${prev}" to free VRAM for "${model.name}" on ${ollamaRootForUnload}`
                    );
                    await unloadModel(ollamaRootForUnload, prev);
                  }
                  const res = await issueCompletion();
                  setLoadedModel(ollamaRootForUnload, model.name);
                  return res;
                }
              ));
            } else {
              ({ completion: chatCompletion, transcript } = await issueCompletion());
            }
          } finally {
            stopCancelWatch();
          }

          // Prompt-cache effectiveness for this call, attributed to a prefix-drift
          // cause. One INFO line per model call — this is the number the cost of a
          // long agentic run turns on. Skipped when the provider reported no usage
          // block at all (nothing to measure).
          if (chatCompletion?.usage) {
            const rawUsage = chatCompletion.usage as OpenAiUsageLike;
            logCacheOutcome({
              conversationId: opts?.conversationId,
              nodeId: opts?.nodeId,
              model: model.name,
              provider: model.provider,
              adapter: model.adapter,
              promptTokens: rawUsage.prompt_tokens ?? 0,
              completionTokens: rawUsage.completion_tokens ?? 0,
              cachedTokens: rawUsage.prompt_tokens_details?.cached_tokens,
              drift: prefixDrift,
              fingerprint: prefixFingerprint,
            });
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
          return ModelHandler.shapeCompletionError(error, modelId, abortController.signal.aborted);
        }
      };

      let result = await attempt(apiMessages, sanitizedTools);

      // Context-length overflow recovery. A single unexpectedly-large tool
      // result in the RECENT tail (a big search dump, a file read) can blow the
      // model's context window even though compactForWire already shrinks OLD
      // ones. compactForWire keeps the recent tail verbatim for cache stability,
      // so it can't have prevented this. When the provider rejected the request
      // for length, re-fit ONCE: shrink every oversized tool result on the wire
      // (recent included) to a head excerpt + a dereferenceable flujo://run/...
      // URI naming the full size, capturing any not-yet-captured result on the
      // fly so the model can still read the whole thing back via read_resource.
      // The cache is already moot (the request was rejected), so touching the
      // recent tail costs nothing here. Skipped for the self-orchestrating
      // claude-cli path (it manages its own wire + truncation markers).
      if (
        !result.success &&
        !isSelfOrchestratingAdapter(model.adapter) &&
        ModelHandler.isContextOverflowError(result.error)
      ) {
        const beforeChars = JSON.stringify(apiMessages).length;
        let refitMarkers = opts?.runResourceMarkers;
        if (opts?.conversationId) {
          refitMarkers = await ModelHandler.captureOversizedToolResultsForRefit(
            opts.conversationId,
            apiMessages,
            refitMarkers,
            opts?.nodeId
          );
        }
        const refitMessages = compactForWire(apiMessages, {
          resourceMarkers: refitMarkers,
          compactRecentToolResults: true,
          allowLossyTruncation: true,
          toolResultHeadChars: ModelHandler.OVERFLOW_TOOL_RESULT_HEAD_CHARS,
        });
        const afterChars = JSON.stringify(refitMessages).length;
        if (afterChars < beforeChars) {
          const refitTools = ModelHandler.ensureReadResourceArmed(refitMessages, sanitizedTools);
          log.warn('Context-length overflow; retrying once with oversized tool results shrunk to run-resource URIs', {
            modelId,
            beforeChars,
            afterChars,
          });
          result = await attempt(refitMessages, refitTools);
        } else {
          log.warn('Context-length overflow but nothing on the wire left to compact; returning the original error', { modelId });
        }
      }

      return result;
    } catch (error) {
      // Setup (model fetch / key decrypt / compaction) threw — attempts shape
      // their own errors and never throw out. stopCancelWatch is idempotent.
      stopCancelWatch();
      return ModelHandler.shapeCompletionError(error, modelId, abortController.signal.aborted);
    }
  }

  /**
   * Process tool calls - pure function
   */
  public static async processToolCalls( // Make public static
    input: ToolCallProcessingInput
  ): Promise<Result<ToolCallProcessingResult>> {
    const { toolCalls, toolNameMap, emit, conversationId, node, signal, mcpNodes } = input;

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
      // Issue #252: run this turn's tool calls CONCURRENTLY (bounded, per-server
      // configurable cap) instead of one-at-a-time. Each call's outcome is written
      // into pre-allocated, index-keyed slots so the emitted/appended order is
      // always the model's original tool_calls order — independent of completion
      // order. This keeps the prefix-cache fingerprint stable and a single-call
      // turn byte-identical to the old sequential path.
      type ProcessedToolCall = { name: string; args: Record<string, unknown>; id: string; result: string };
      const results: Array<FlujoChatMessage | null> = new Array(toolCalls.length).fill(null);
      const processed: Array<ProcessedToolCall | null> = new Array(toolCalls.length).fill(null);

      // Per-server concurrency caps (MCPManagerConfig.maxConcurrency). Loaded once
      // up front; a server that declares none (or a non-positive value) uses the
      // conservative module default. Failure to load caps is non-fatal.
      const concurrencyByServer = new Map<string, number>();
      try {
        const serverConfigs = await mcpService.loadServerConfigs();
        if (Array.isArray(serverConfigs)) {
          for (const cfg of serverConfigs) {
            if (typeof cfg.maxConcurrency === 'number' && cfg.maxConcurrency > 0) {
              concurrencyByServer.set(cfg.name, cfg.maxConcurrency);
            }
          }
        }
      } catch (error) {
        log.warn('Failed to load server configs for concurrency caps; using default', error);
      }

      // Group key for a call: MCP calls are capped per resolved server; local
      // synthetic tools (handoff / MCP-resource / run-resource) share one cheap
      // unbounded group. Mirrors the dispatch routing inside executeOneToolCall.
      const LOCAL_GROUP = '__local__';
      const groupKeyForCall = (tc: OpenAI.ChatCompletionMessageToolCall): string => {
        const toolName = tc.function.name;
        if (toolName.startsWith('handoff_to_') || toolName === 'handoff') return LOCAL_GROUP;
        if (isMCPResourceToolName(toolName)) return LOCAL_GROUP;
        if (isRunResourceToolName(toolName)) return LOCAL_GROUP;
        if (isQuestionToolName(toolName)) return LOCAL_GROUP;
        if (isTodoToolName(toolName)) return LOCAL_GROUP;
        const decoded = decodeToolName(toolName, toolNameMap);
        return decoded ? `srv:${decoded.server}` : LOCAL_GROUP;
      };
      const limitForGroup = (key: string): number => {
        if (key === LOCAL_GROUP) return Math.max(1, toolCalls.length);
        const server = key.slice('srv:'.length);
        return concurrencyByServer.get(server) ?? DEFAULT_TOOL_CALL_CONCURRENCY;
      };

      // Per-call worker. Runs the EXACT same dispatch logic as the old loop body,
      // but into local single-slot collectors (each path emits exactly one tool
      // message + at most one processed entry), then copies them into the
      // index-keyed slots in a finally so every branch — including the early
      // returns (formerly `continue`) — records its outcome.
      const executeOneToolCall = async (callIndex: number): Promise<void> => {
        const toolCall = toolCalls[callIndex];
        const { id, function: { name, arguments: argsString } } = toolCall;

        const toolCallMessages: FlujoChatMessage[] = [];
        const processedToolCalls: ProcessedToolCall[] = [];

        try {
          // Cancellation check BEFORE starting this call (issue #109/#252): once
          // Stop is pressed, a not-yet-started call is answered with a synthetic
          // "cancelled" tool message so every tool_call id stays answered and the
          // transcript well-formed. In-flight calls are killed via the signal.
          if (input.shouldAbort?.()) {
            log.info(`Cancellation detected before tool call ${name}; answering it with a synthetic cancelled result.`);
            toolCallMessages.push({
              id: uuidv4(),
              role: "tool",
              tool_call_id: id,
              content: 'Execution cancelled by user before this tool call ran.',
              timestamp: Date.now()
            });
            return;
          }
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

            // This call is done — record its outcome (see finally).
            return;
          }

          // MCP resource tools (issue #239): synthetic FLUJO tools for native MCP
          // server resources (list_mcp_resources). Dispatched before the standard
          // MCP decode path so they are never routed to mcpService.
          if (isMCPResourceToolName(name)) {
            emit?.({ type: 'tool:call', toolCallId: id, name, args: argsString });
            const outcome = await executeMCPResourceTool(name, args, {
              conversationId,
              node,
              emit,
              mcpNodes: mcpNodes ?? [],
            });
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
            return;
          }

          // Run-resource tools (issue #161): synthetic FLUJO tools that write a
          // run artifact, dispatched here (not via mcpService) using the run's
          // conversationId already in scope. Only offered when a produce node is
          // wired (ProcessNode.prep), so this branch is inert for other flows.
          if (isRunResourceToolName(name)) {
            emit?.({ type: 'tool:call', toolCallId: id, name, args: argsString });
            const outcome = await executeRunResourceTool(name, args, { conversationId, node, emit, mcpNodes: mcpNodes ?? [] });
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
            return;
          }

          // Question tool (issue #258): synthetic FLUJO tool that asks the user a
          // structured multiple-choice question and BLOCKS this turn until they
          // answer/decline (in-request blocking-promise via questionRegistry).
          // Only offered when the node opted in (ProcessNode.prep allowQuestion),
          // so this branch is inert otherwise. Unattended runs degrade to a clear
          // tool-error rather than blocking (executeQuestionTool honours it).
          if (isQuestionToolName(name)) {
            emit?.({ type: 'tool:call', toolCallId: id, name, args: argsString });
            const outcome = await executeQuestionTool(args, {
              conversationId,
              node,
              emit,
              unattended: input.unattended,
            });
            const resultContent = outcome.success
              ? (typeof outcome.data === 'string' ? outcome.data : JSON.stringify(outcome.data))
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
            return;
          }

          // Todo tool (issue #259): synthetic FLUJO tool that replaces the
          // run-scoped task list on the live SharedState and emits a todo:update
          // event for the live view. Only offered when the node opted in
          // (ProcessNode.prep enableTodoTool), so this branch is inert otherwise.
          if (isTodoToolName(name)) {
            emit?.({ type: 'tool:call', toolCallId: id, name, args: argsString });
            const outcome = await executeTodoTool(args, { conversationId, node, emit });
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
            return;
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

          // Issue #255: staleness guard. If the MCP client for this server was
          // (re)registered, or the tool's schema changed, after this call was
          // planned/advertised, do NOT dispatch it against the re-created
          // instance. Return a tool ERROR telling the model to re-check its
          // tools. Skipped for legacy/synthetic tools (no identity token). This
          // also covers the approval-resume path, which funnels through here.
          const freshness = assertToolIdentityFresh(name, decoded, mcpService);
          if (!freshness.ok) {
            log.warn(`Rejecting stale/invalid tool call ${name}: ${freshness.reason}`);
            emit?.({ type: 'tool:call', toolCallId: id, name, args: argsString });
            emit?.({ type: 'tool:result', toolCallId: id, name, result: freshness.reason, isError: true });
            toolCallMessages.push({
              id: uuidv4(),
              role: 'tool',
              tool_call_id: id,
              content: freshness.reason,
              timestamp: Date.now(),
            });
            processedToolCalls.push({ name, args, id, result: freshness.reason });
            return;
          }

          // Phase 3 (issue #246): per-call permission gate.
          // Evaluate configured + saved rules before dispatching to mcpService.
          const permRules = input.permissionRules ?? [];
          const savedRules = input.savedPermissionRules ?? [];
          if (permRules.length > 0 || savedRules.length > 0) {
            let callArgs: Record<string, unknown> = {};
            try { callArgs = JSON.parse(argsString); } catch { /* best effort */ }
            const resource = extractResource(callArgs);
            const permEffect = evaluatePermission(permRules, savedRules, serverName, toolName, resource);
            if (permEffect === 'deny') {
              log.info(`Permission denied by rule for tool ${toolName} on ${serverName} (resource: ${resource})`);
              const deniedContent = `Permission denied: the active ruleset does not allow calling ${toolName} on ${serverName} (resource: ${resource}).`;
              emit?.({ type: 'tool:call', toolCallId: id, name, args: argsString });
              emit?.({
                type: 'tool:result',
                toolCallId: id,
                name,
                result: deniedContent,
                isError: true,
              });
              toolCallMessages.push({
                id: uuidv4(),
                role: 'tool',
                tool_call_id: id,
                content: deniedContent,
                timestamp: Date.now(),
              });
              processedToolCalls.push({ name, args: callArgs, id, result: deniedContent });
              return;
            }
            // 'allow' or 'ask' → fall through to normal dispatch.
          }

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
            }),
            decoded.nodeId,
            signal
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
          let resultContent = result.success
            ? JSON.stringify(effectiveData)
            : `Error: ${result.error}`;

          // Tier-boundary bound (#251): every oversized tool result is truncated
          // to a head+tail preview and the full content spilled UNCONDITIONALLY
          // to a run resource on THIS turn — so a 5 MB result never reaches the
          // wire in full (not even on the first turn) and both ends of a long
          // log survive. Runs AFTER auto-capture (binaries already stubbed) so
          // only the remaining text form is bounded. Never breaks the run.
          if (result.success && conversationId && runResourceSettings) {
            try {
              const bounded = await boundToolResult({
                conversationId,
                toolCallId: id,
                server: serverName,
                toolName,
                nodeId: node?.nodeId,
                content: resultContent,
                settings: runResourceSettings,
              });
              if (bounded.spilled) {
                resultContent = bounded.content;
                if (bounded.uri) {
                  emit?.({
                    type: 'resource:write',
                    node,
                    server: 'flujo',
                    uri: bounded.uri,
                    mimeType: 'text/plain',
                    size: bounded.bytes,
                    source: 'tool-result',
                    toolCallId: id,
                  });
                }
              }
            } catch (error) {
              log.error('boundToolResult failed; keeping full tool result', error);
            }
          }

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
            ? await ModelHandler.resolveToolUiLink(serverName, toolName, result.data)
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
        } finally {
          // Copy this call's single outcome into its index-keyed slots. Every
          // dispatch path pushes exactly one message (+ at most one processed
          // entry), so [0] is authoritative; ordering is by callIndex, never by
          // completion time.
          results[callIndex] = toolCallMessages[0] ?? null;
          processed[callIndex] = processedToolCalls[0] ?? null;
        }
      };

      // Drive the batch: group calls by server, run each group under its own cap,
      // and run the groups concurrently. Local synthetic tools share one group.
      const groups = new Map<string, number[]>();
      for (let i = 0; i < toolCalls.length; i++) {
        const key = groupKeyForCall(toolCalls[i]);
        const bucket = groups.get(key);
        if (bucket) bucket.push(i);
        else groups.set(key, [i]);
      }
      await Promise.all(
        Array.from(groups.entries()).map(([key, indices]) =>
          runWithConcurrency(indices, limitForGroup(key), executeOneToolCall)
        )
      );

      // Defensive: any still-empty slot (a call that never ran) is answered with
      // a synthetic cancelled message so every tool_call id stays answered.
      for (let i = 0; i < toolCalls.length; i++) {
        if (results[i] === null) {
          results[i] = {
            id: uuidv4(),
            role: "tool",
            tool_call_id: toolCalls[i].id,
            content: 'Execution cancelled by user before this tool call ran.',
            timestamp: Date.now()
          };
        }
      }

      const result: Result<ToolCallProcessingResult> = {
        success: true,
        value: {
          toolCallMessages: results.filter((m): m is FlujoChatMessage => m !== null),
          processedToolCalls: processed.filter((p): p is ProcessedToolCall => p !== null)
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
