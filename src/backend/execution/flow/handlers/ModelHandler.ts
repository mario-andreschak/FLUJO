import { createLogger, LOG_LEVEL } from '@/utils/logger';
import { takeSteeringMessages } from '@/backend/execution/flow/steeringInbox';
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
import { decodeToolName, assertToolIdentityFresh, type DecodedTool } from './toolNamespace';
import { stripHandoffPlumbing, toApiMessages } from '../buildNodeContext';
import { compactForWire, couldCompact, wireHasRunResourceUri } from './compactForWire';
import OpenAI from 'openai';
import { modelService } from '@/backend/services/model';
import { ownerScopeForRun } from '@/backend/services/mcp/ownerScope';
import {
  filterUnsupportedMediaInputs,
  hydrateRunResourceMedia,
  materializeRunResourceMediaPaths,
} from '@/backend/services/model/mediaHandoff';
import { resolveEffectiveMaxTurns } from './maxTurns';
import { resolveEffectiveMaxTokens } from './maxTokens';
import { resolveEffectiveCompaction, resolveEffectiveVisualCompaction } from './resolveEffectiveCompaction';
import { compactMessagesVisually, type EffectiveVisualCompaction } from './visualCompaction';
import { compactHistory, estimateTokens, type CompactHistoryResult } from './summarizingCompaction';
import { digestProjectedMessages, digestProjectionIdentity } from '../compaction/digest';
import {
  COMPACTION_ARTIFACT_SCHEMA_VERSION,
  COMPACTION_POLICY_VERSION,
  COMPACTION_PROJECTION_VERSION,
  type CompactionProjectionIdentity,
} from '../compaction/types';
import { normalizeMaxTokens } from '@/shared/types/model';
import { isSelfOrchestratingAdapter, normalizeModelTemperature } from '@/shared/types/model/provider';
import { getCompletionAdapter } from '@/backend/services/model/adapters';
import { mapOpenAiUsage, OpenAiUsageLike } from '@/backend/services/model/adapters/openaiUsage';
import { prepareOpenAiPromptCacheWire } from '@/backend/services/model/adapters/openaiPromptCaching';
import { fingerprintPrefix, classifyDrift, logCacheOutcome, derivePromptCacheKey } from './promptCacheMetrics';
import { trimTools } from './trimToolBlock';
import { mcpService } from '@/backend/services/mcp';
import { registerToolCall, releaseToolCall } from '../toolCancelRegistry';
import { combineAbortSignals } from '../combineAbortSignals';
import {
  MAX_AUTOMATIC_MODEL_RETRIES,
  planAutomaticRetry,
  waitForRetryWindow,
} from '../retryAfter';
import { runWithConcurrency } from '@/backend/services/mcp/utils/boundedConcurrency';
import { DEFAULT_TOOL_CALL_TIMEOUT_SECONDS } from '@/shared/types/mcp';
import { getCurrentWorkspace } from '@/utils/workspace';
import { extractUiResourceUri } from '@/shared/utils/mcpApps';
import { resolveInvokedToolUiLink } from '@/backend/mcpApps/toolUi';
import {
  getRunResourceSettings,
  writeRunResource,
  listRunResources,
  getRunResourceLocalPath,
} from '@/backend/services/runResources';
import { captureToolResult } from '@/backend/services/runResources/capture';
import { mediaPartFromToolItem, splitToolResultMedia } from '@/backend/services/runResources/toolResultMedia';
import { boundToolResult } from '@/backend/services/runResources/boundToolResult';
import { isRunResourceToolName, executeRunResourceTool, buildReadResourceTool, WRITE_RESOURCE_TOOL_NAME, READ_RESOURCE_TOOL_NAME } from './runResourceTools';
import { isQuestionToolName, executeQuestionTool, QUESTION_TOOL_NAME } from './runQuestionTool';
import { isTodoToolName, executeTodoTool, TODO_TOOL_NAME } from './todoTool';
import { isPersonaToolName, executePersonaTool } from './personaTools';
import { isMeetingToolName, executeMeetingTool } from './meetingTools';
import { isMCPResourceToolName, executeMCPResourceTool, LIST_MCP_RESOURCES_TOOL_NAME } from './mcpResourceTools';
import { isSubflowToolName, executeSubflowToolCall } from './subflowToolInvocation';
import { isBehaviorToolName, executeBehaviorToolCall } from './behaviorToolInvocation';
import { executeDetachedSubflowStart, executeTaskCancel, executeTaskGet, SUBFLOW_DETACHED_TOOL_PREFIX } from './subflowDetachedInvocation';
import {
  DEFAULT_TOOL_RESULT_MAX_BYTES,
  DEFAULT_TOOL_RESULT_MAX_LINES,
  type RunResourceSettings,
} from '@/shared/types/runResources';
import type { ModelStreamDelta, ModelToolProgress, ToolResourceMarker } from '@/backend/services/model/adapters/types';
import type { RecoveryFailureDetails } from '@/shared/types/execution/events';
import type { ModelMediaPart } from '@/shared/types/model/media';
import { mediaTypeFromMime } from '@/shared/types/model/media';
import { requireFunctionToolCalls } from '@/shared/types/openai';
import {
  extractAssistantMedia,
  parseDataUrl,
} from '@/backend/services/model/adapters/messageUtils';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { applyPresetArguments } from '@/backend/utils/resolveDynamicReferences';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { appendRawForState } from '@/backend/execution/flow/conversationLog';
import {
  assertFlowExecutionCurrent,
  commitFlowDurableMutation,
  isFlowExecutionAuthorityError,
  rethrowFlowExecutionAuthorityError,
  type FlowDurableMutationContext,
} from '@/backend/execution/flow/executionAuthority';
import { registerPendingApproval, listPendingToolCalls } from '@/backend/execution/flow/toolApprovalRegistry';
import { upsertMessageById } from '@/backend/execution/flow/conversationMessages';
import { loadItem } from '@/utils/storage/backend';
import { StorageKey, type Settings } from '@/shared/types/storage/storage';
import { normaliseOllamaRoot, withOllamaLock, getLoadedModel, setLoadedModel } from '@/backend/services/ollama/modelRegistry';
import { unloadModel } from '@/backend/services/ollama';
import { v4 as uuidv4 } from 'uuid'; // Import uuid
import {
  classifyStatisticsError,
  createStatisticsEvent,
  credentialFingerprint,
  recordStatisticsEvent,
} from '@/backend/services/statistics';
import {
  newStatisticsInvocationId,
  statisticsAttemptId,
  statisticsCacheOutcomeFromUsage,
  statisticsPayloadMetadata,
} from '@/backend/services/statistics/metadata';

const log = createLogger('backend/flow/execution/handlers/ModelHandler'
  // , LOG_LEVEL.VERBOSE // override for the current file
);

type GeneratedImagePart = {
  type: 'image_url';
  image_url: { url: string };
};

/**
 * OpenRouter image-capable Chat Completions return generated images beside
 * `content`, in the non-OpenAI `message.images` extension. Keep this boundary
 * tolerant because the OpenAI SDK types intentionally do not declare it.
 */
export function extractGeneratedImageParts(message: unknown): GeneratedImagePart[] {
  return extractAssistantMedia(message).flatMap((part): GeneratedImagePart[] => {
    if (part.type !== 'image') return [];
    const url = part.url ?? (
      part.data
        ? `data:${part.mimeType ?? 'image/png'};base64,${part.data}`
        : undefined
    );
    return url ? [{ type: 'image_url', image_url: { url } }] : [];
  });
}

function mediaResourceKind(part: ModelMediaPart): 'image' | 'audio' | 'blob' {
  if (part.type === 'image') return 'image';
  if (part.type === 'audio') return 'audio';
  return 'blob';
}

async function persistModelMedia(
  parts: ModelMediaPart[],
  conversationId?: string,
  nodeId?: string,
  durableContext: FlowDurableMutationContext = {},
): Promise<ModelMediaPart[]> {
  const deduped = parts.filter((part, index, all) => {
    const key = `${part.type}|${part.url ?? ''}|${part.data ?? ''}|${part.mimeType ?? ''}`;
    return all.findIndex(candidate =>
      `${candidate.type}|${candidate.url ?? ''}|${candidate.data ?? ''}|${candidate.mimeType ?? ''}` === key
    ) === index;
  });
  if (!conversationId) return deduped;

  return Promise.all(deduped.map(async (part) => {
    const parsed = part.url ? parseDataUrl(part.url) : undefined;
    const data = part.data ?? parsed?.base64;
    const mimeType =
      part.mimeType ??
      parsed?.mimeType ??
      (part.type === 'image' ? 'image/png'
        : part.type === 'audio' ? 'audio/mpeg'
          : part.type === 'video' ? 'video/mp4'
            : 'application/octet-stream');
    if (!data) return { ...part, mimeType };

    try {
      return await commitFlowDurableMutation(durableContext, async () => {
        const written = await writeRunResource({
          conversationId,
          name: part.name,
          mimeType,
          kind: mediaResourceKind({ ...part, mimeType }),
          data: { base64: data },
          producedBy: { source: 'model-output', nodeId },
        });
        if ('skipped' in written) return { ...part, mimeType };
        const localPath = await getRunResourceLocalPath(written.uri);
        return {
          type: mediaTypeFromMime(mimeType),
          mimeType,
          ...(part.name ? { name: part.name } : {}),
          ...(part.transcript ? { transcript: part.transcript } : {}),
          resourceUri: written.uri,
          ...(localPath ? { localPath } : {}),
          url:
            `/v1/chat/conversations/${encodeURIComponent(conversationId)}` +
            `/resources/${encodeURIComponent(written.id)}/content` +
            `?workspace=${encodeURIComponent(getCurrentWorkspace())}`,
        };
      });
    } catch (error) {
      rethrowFlowExecutionAuthorityError(error);
      log.warn('Failed to persist direct model media; keeping it inline', {
        conversationId,
        nodeId,
        type: part.type,
        error,
      });
      return { ...part, mimeType };
    }
  }));
}

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
   * MCP Apps (#97): resolve a tool definition's linked `ui://` resource while
   * honoring the per-server opt-in. The stable spec requires predeclared
   * templates; result metadata can echo that URI but cannot redirect the host
   * to a different, unreviewed resource.
   */
  static async resolveToolUiLink(
    serverName: string,
    toolName: string,
    resultData: unknown,
    advertisedUri?: string,
    invocationArgs?: Record<string, unknown>,
  ): Promise<{ uri: string; serverName: string; toolName: string; toolArgs?: string } | undefined> {
    // New conversations carry the advertised URI in their tool identity map.
    // Older persisted maps do not, so re-read the model-visible definition as a
    // compatibility fallback. Never select a URI solely from the call result.
    let uri = advertisedUri;
    if (!uri) {
      try {
        const { tools } = await mcpService.listServerTools(serverName);
        const def = Array.isArray(tools) ? tools.find((t) => t.name === toolName) : undefined;
        uri = extractUiResourceUri((def as { _meta?: unknown } | undefined)?._meta);
      } catch (error) {
        log.warn(`resolveToolUiLink: failed to list tools for ${serverName}`, error);
      }
    }
    return resolveInvokedToolUiLink(
      serverName,
      toolName,
      uri,
      resultData,
      invocationArgs,
    );
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
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { FlowExecutor } = require('@/backend/execution/flow/FlowExecutor');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
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
  static async isClaudeSessionResumeEnabled(): Promise<boolean> {
    try {
      const settings = await loadItem<Settings | undefined>(StorageKey.SPEECH_SETTINGS, undefined);
      return Boolean(settings?.experimental?.claudeSessionResume);
    } catch (err) {
      log.warn('Failed to read claudeSessionResume setting; defaulting to disabled', { err });
      return false;
    }
  }

  /**
   * Read the experimental `subflowToolInvocation` flag (issue #385, deferred
   * Part B of #359) from the persisted Settings blob. Gates whether a Subflow
   * node authored with `invocationMode: 'tool'` is advertised as a distinct
   * `call_subflow_<slug>` tool (ProcessNode.generateHandoffTools) instead of
   * the default `handoff_to_*` transition tool. Same best-effort pattern as
   * `isClaudeSessionResumeEnabled`: any failure (or a missing value) reads as
   * disabled, so an unconfigured install keeps today's handoff-only behaviour.
   */
  static async isSubflowToolInvocationEnabled(): Promise<boolean> {
    try {
      const settings = await loadItem<Settings | undefined>(StorageKey.SPEECH_SETTINGS, undefined);
      return Boolean(settings?.experimental?.subflowToolInvocation);
    } catch (err) {
      log.warn('Failed to read subflowToolInvocation setting; defaulting to disabled', { err });
      return false;
    }
  }

  static async isSubflowDetachedInvocationEnabled(): Promise<boolean> {
    try {
      const settings = await loadItem<Settings | undefined>(StorageKey.SPEECH_SETTINGS, undefined);
      return Boolean(settings?.experimental?.subflowDetachedInvocation);
    } catch (err) {
      log.warn('Failed to read subflowDetachedInvocation setting; defaulting to disabled', { err });
      return false;
    }
  }

  /**
   * Summarize a validated persisted child-session transcript using the same
   * provider adapter as ordinary Process execution. Kept narrow so session
   * policy does not inherit the global automatic-compaction threshold.
   */
  static async summarizeSessionHistory(
    modelId: string,
    messages: FlujoChatMessage[],
    prompt: { system: string; user: string },
    executionAuthority?: import('../types').FlowExecutionAuthority,
  ): Promise<string> {
    const callMessages: FlujoChatMessage[] = [
      { id: uuidv4(), role: 'system', content: prompt.system, timestamp: Date.now() } as FlujoChatMessage,
      ...messages,
      { id: uuidv4(), role: 'user', content: prompt.user, timestamp: Date.now() } as FlujoChatMessage,
    ];
    const response = await ModelHandler.generateCompletion(modelId, '', callMessages, undefined, {
      maxTokens: 4000,
      beforeModelDispatch: executionAuthority?.assertCurrent,
      durableContext: { executionAuthority },
    });
    await executionAuthority?.assertCurrent();
    return response.success ? (response.value.content ?? '') : '';
  }

  /**
   * Read the experimental `subflowSessions` flag (issue #391, gate for #363
   * Phase 1) from the persisted Settings blob. Gates whether `runSubflowLanes()`
   * honours a Subflow node's `sessionScope` and resumes a child conversation
   * across repeat visits within one parent run. Same best-effort pattern as
   * `isClaudeSessionResumeEnabled`: any failure (or a missing value) reads as
   * disabled, so an unconfigured install keeps today's per-visit behaviour.
   */
  static async isSubflowSessionsEnabled(): Promise<boolean> {
    try {
      const settings = await loadItem<Settings | undefined>(StorageKey.SPEECH_SETTINGS, undefined);
      return Boolean(settings?.experimental?.subflowSessions);
    } catch (err) {
      log.warn('Failed to read subflowSessions setting; defaulting to disabled', { err });
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
    visualCompactionEnabled?: boolean;
    visualCompactionToolResultsOnly?: boolean;
    visualCompactionEvaluationMode?: boolean;
  }> {
    try {
      const settings = await loadItem<Settings | undefined>(StorageKey.SPEECH_SETTINGS, undefined);
      const exp = settings?.experimental;
      return {
        compactionEnabled: exp?.compactionEnabled,
        compactionBufferTokens: exp?.compactionBufferTokens,
        compactionKeepTokens: exp?.compactionKeepTokens,
        visualCompactionEnabled: exp?.visualCompactionEnabled,
        visualCompactionToolResultsOnly: exp?.visualCompactionToolResultsOnly,
        visualCompactionEvaluationMode: exp?.visualCompactionEvaluationMode,
      };
    } catch (err) {
      log.warn('Failed to read compaction settings; defaulting to disabled', { err });
      return {};
    }
  }

  /**
   * Build summarizing compaction strictly as a provider-facing projection.
   * Canonical SharedState.messages and the append-only conversation log are
   * never reconciled or replaced here. Artifact metadata is persisted beside
   * the complete canonical snapshot and is reusable only under exact digest,
   * scope, projection, policy, model, and schema identity.
   */
  private static async maybeCompactWire(
    source: FlujoChatMessage[],
    conversationId: string | undefined,
    nodeId: string | undefined,
    projectionView: CompactionProjectionIdentity['view'],
    model: { id: string; adapter?: string; contextWindow?: number; compactionThreshold?: number },
    effectiveMaxTokens: number | undefined,
    nodeCompaction?: { compactionMode?: 'auto' | 'off'; compactionKeepTokens?: number },
    durableContext: FlowDurableMutationContext = {},
  ): Promise<CompactHistoryResult | null> {
    try {
      if (!conversationId || source.length < 4 || isSelfOrchestratingAdapter(model.adapter)) return null;

      const global = await ModelHandler.getCompactionGlobalSettings();
      const eff = resolveEffectiveCompaction(nodeCompaction, model, global);
      if (!eff.enabled) return null;

      let lastPromptTokens: number | undefined;
      for (let i = source.length - 1; i >= 0; i--) {
        const usage = source[i].usage;
        if (usage && typeof usage.promptTokens === 'number' && usage.promptTokens > 0) {
          lastPromptTokens = usage.promptTokens;
          break;
        }
      }
      const estimate = lastPromptTokens ?? estimateTokens(source);
      const threshold = eff.threshold ?? (model.contextWindow
        ? model.contextWindow - Math.max(effectiveMaxTokens ?? 0, eff.bufferTokens)
        : undefined);
      if (threshold === undefined || threshold <= 0 || estimate < threshold) return null;

      const projection: CompactionProjectionIdentity = {
        conversationId,
        nodeId,
        view: projectionView,
        handoffPolicy: 'strip-v1',
        version: COMPACTION_PROJECTION_VERSION,
      };
      const sourceDigest = digestProjectedMessages(source);
      const projectionDigest = digestProjectionIdentity(projection);

      const { FlowExecutor } = await import('@/backend/execution/flow/FlowExecutor');
      const state = FlowExecutor.conversationStates.get(conversationId);
      const reusableArtifact = state?.compactionState?.artifacts.find(artifact =>
        artifact.schemaVersion === COMPACTION_ARTIFACT_SCHEMA_VERSION &&
        artifact.conversationId === conversationId &&
        artifact.nodeId === nodeId &&
        artifact.sourceDigest === sourceDigest &&
        artifact.projectionDigest === projectionDigest &&
        artifact.policyVersion === COMPACTION_POLICY_VERSION &&
        artifact.modelId === model.id
      );

      const summarize = async (
        msgs: FlujoChatMessage[],
        prompt: { system: string; user: string },
      ): Promise<string> => {
        const callMessages: FlujoChatMessage[] = [
          { id: uuidv4(), role: 'system', content: prompt.system, timestamp: Date.now() } as FlujoChatMessage,
          ...msgs,
          { id: uuidv4(), role: 'user', content: prompt.user, timestamp: Date.now() } as FlujoChatMessage,
        ];
        const response = await ModelHandler.generateCompletion(model.id, '', callMessages, undefined, {
          maxTokens: Math.min(effectiveMaxTokens ?? 4000, 4000),
          beforeModelDispatch: durableContext.executionAuthority?.assertCurrent,
          durableContext,
        });
        await assertFlowExecutionCurrent(durableContext);
        return response.success ? (response.value.content ?? '') : '';
      };

      const writeAnchor = async (
        text: string,
        metadata: { artifactId: string; sourceDigest: string; projectionDigest: string },
      ): Promise<string | undefined> => {
        const written = await commitFlowDurableMutation(durableContext, () => writeRunResource({
          conversationId,
          name: `compaction-artifact-${metadata.artifactId}`,
          mimeType: 'application/json',
          kind: 'text',
          data: { text },
          producedBy: {
            source: 'compaction-artifact',
            nodeId,
            artifactId: metadata.artifactId,
            sourceDigest: metadata.sourceDigest,
            projectionDigest: metadata.projectionDigest,
          },
        }));
        return 'skipped' in written ? undefined : written.uri;
      };

      const result = await compactHistory(source, {
        keepTokens: eff.keepTokens,
        nodeId,
        conversationId,
        projection,
        sourceDigest,
        projectionDigest,
        policyVersion: COMPACTION_POLICY_VERSION,
        modelId: model.id,
        reusableArtifact,
      }, { summarize, writeAnchor });
      if (!result) return null;

      await assertFlowExecutionCurrent(durableContext);
      if (digestProjectedMessages(source) !== sourceDigest) {
        log.warn('Projected compaction source changed during generation; discarding artifact', { conversationId, nodeId });
        return null;
      }

      if (state && result.artifact !== reusableArtifact) {
        const previous = state.compactionState;
        state.compactionState = {
          schemaVersion: COMPACTION_ARTIFACT_SCHEMA_VERSION,
          artifacts: [...(previous?.artifacts ?? []), result.artifact],
        };
        try {
          const { persistConversationState } = await import('@/backend/execution/flow/persistConversationState');
          await persistConversationState(`conversations/${conversationId}` as StorageKey, state);
        } catch (persistError) {
          state.compactionState = previous;
          rethrowFlowExecutionAuthorityError(persistError);
          log.warn('Compaction artifact metadata persist failed; using canonical wire', { conversationId, persistError });
          return null;
        }
      }

      return result;
    } catch (error) {
      rethrowFlowExecutionAuthorityError(error);
      log.warn('Summarizing-compaction pre-flight failed; using canonical wire', { conversationId, error });
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
      // eslint-disable-next-line @typescript-eslint/no-require-imports
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

  /** A live Claude transcript assistant message is prose only when it has text
   * and is not the assistant half of a tool-call pair. */
  private static isStreamedAssistantProse(message: FlujoChatMessage): boolean {
    const assistant = message as Extract<FlujoChatMessage, { role: 'assistant' }>;
    return assistant.role === 'assistant'
      && typeof assistant.content === 'string'
      && assistant.content.length > 0
      && !assistant.tool_calls?.length;
  }

  /**
   * Compensate a failed self-orchestrating model attempt. Streamed prose has
   * already reached the append-only log, so remove it from the live projection
   * and append matching log-only removals. Tool calls/results are deliberately
   * never tracked here and therefore survive a failed attempt.
   */
  private static async removeFailedStreamedAssistantProse(
    conversationId: string | undefined,
    messageIds: ReadonlySet<string>
  ): Promise<void> {
    if (!conversationId || messageIds.size === 0) return;
    try {
      // Lazy require keeps the existing FlowExecutor -> ProcessNode ->
      // ModelHandler cycle broken.
      const { FlowExecutor } = await import('@/backend/execution/flow/FlowExecutor');
      const state = FlowExecutor.conversationStates.get(conversationId);
      if (!state || !Array.isArray(state.messages)) return;

      // Only compensate messages still present. This makes repeated failure
      // handling idempotent: after the first pass neither state nor log changes.
      const removals = [...messageIds].filter((id) =>
        state.messages.some((message: FlujoChatMessage) => message.id === id)
      );
      if (removals.length === 0) return;
      const removalSet = new Set(removals);
      for (let index = state.messages.length - 1; index >= 0; index--) {
        if (removalSet.has(state.messages[index].id)) state.messages.splice(index, 1);
      }
      state.updatedAt = Date.now();
      await appendRawForState(state, removals.map((messageId) => ({ type: 'message:removed', messageId })));
    } catch (err) {
      log.warn(`Failed to compensate streamed prose for failed conversation ${conversationId}`, { err });
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
   * Guardrail reserved from advertised context windows for provider framing and
   * tokenizer-estimation variance. This is not a tokenizer: payload estimates
   * below are deliberately conservative character-based approximations.
   */
  private static readonly OUTGOING_INPUT_SAFETY_TOKENS = 4096;

  /**
   * Output caps are optional for some adapters. When a model advertises a
   * context window but no cap is configured, reserve this conservative amount
   * instead of assuming that the provider will generate no output.
   */
  private static readonly UNSPECIFIED_OUTPUT_TOKEN_RESERVE = 8192;

  private static resolveOutgoingInputBudget(
    contextWindow: number | undefined,
    maxTokens: number | undefined
  ): number | undefined {
    if (!Number.isFinite(contextWindow) || (contextWindow ?? 0) <= 0) return undefined;

    const outputReserve =
      normalizeMaxTokens(maxTokens) ?? ModelHandler.UNSPECIFIED_OUTPUT_TOKEN_RESERVE;
    const budget = Math.floor(
      (contextWindow as number) - outputReserve - ModelHandler.OUTGOING_INPUT_SAFETY_TOKENS
    );
    return budget > 0 ? budget : undefined;
  }

  /** Estimate the complete provider payload using the same conservative
   * character-based convention as summarizing compaction. */
  private static estimateOutgoingInputTokens(
    messages: OpenAI.ChatCompletionMessageParam[],
    tools?: OpenAI.ChatCompletionFunctionTool[]
  ): number {
    return Math.ceil(JSON.stringify({ messages, tools: tools ?? [] }).length / 4);
  }

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
    tools: OpenAI.ChatCompletionFunctionTool[] | undefined
  ): OpenAI.ChatCompletionFunctionTool[] | undefined {
    if (
      !wireHasRunResourceUri(apiMessages) ||
      (tools ?? []).some((t) => t.type === 'function' && t.function.name === READ_RESOURCE_TOOL_NAME)
    ) {
      return tools;
    }
    const def = buildReadResourceTool();
    const readTool: OpenAI.ChatCompletionFunctionTool = {
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
    nodeId?: string,
    durableContext: FlowDurableMutationContext = {},
  ): Promise<Map<string, ToolResourceMarker> | undefined> {
    let markers: Map<string, ToolResourceMarker> | undefined = existing ? new Map(existing) : undefined;
    for (const msg of apiMessages) {
      if (msg.role !== 'tool' || typeof msg.content !== 'string') continue;
      if (msg.content.length <= ModelHandler.OVERFLOW_TOOL_RESULT_HEAD_CHARS) continue;
      const callId = msg.tool_call_id;
      if (markers?.get(callId)?.result?.uri) continue; // already recoverable
      const content = msg.content;
      try {
        const written = await commitFlowDurableMutation(durableContext, () => writeRunResource({
            conversationId,
            mimeType: 'text/plain',
            kind: 'text',
            data: { text: content },
            producedBy: { source: 'tool-result', nodeId, toolCallId: callId },
          }),
        );
        if ('skipped' in written) {
          log.warn(`Emergency capture of oversized tool result skipped (${written.skipped}); it will be lossily truncated`);
          continue;
        }
        if (!markers) markers = new Map();
        const slot = markers.get(callId) ?? {};
        slot.result = written;
        markers.set(callId, slot);
      } catch (error) {
        rethrowFlowExecutionAuthorityError(error);
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

    // Error diagnostics are deliberately metadata-only. Provider bodies,
    // messages, request URLs, headers, and stacks may contain credentials or
    // execution content and must never be passed to the logger.
    log.error('Provider completion failed', {
      modelId,
      errorClass: classifyStatisticsError(error),
      status: error instanceof OpenAI.APIError ? error.status : undefined,
      type: error instanceof OpenAI.APIError ? error.type : undefined,
      code: error instanceof OpenAI.APIError ? error.code : undefined,
    });

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

      log.warn('Provider request failed', {
        modelId,
        status: error.status,
        code: extracted.code ?? error.code,
        type: extracted.type ?? error.type,
      });
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

    log.warn('Provider request failed with an unclassified error', {
      modelId,
      errorClass: error instanceof Error ? error.name : typeof error,
    });
    return errorResult;
  }

  /**
   * Call model with tool support - performs a SINGLE API call.
   * Does NOT handle tool execution loops internally.
   */
  static async callModel(input: ModelCallInput): Promise<Result<ModelCallResult>> {
    // Remove iteration parameters as they are no longer handled here
    const { modelId, prompt, messages, wireMessages, tools, nodeName, nodeId, toolNameMap, maxTurns, maxTokens, compactionMode, compactionKeepTokens, onFinalWire, conversationId, runId, codexSession, onCodexSessionChange, requireToolApproval, mcpNodes } = input; // Added nodeId
    const durableContext: FlowDurableMutationContext = {
      executionAuthority: input.executionAuthority,
      personaAttribution: input.personaAttribution,
    };

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

    // Native session reuse is safe only for FULL-HISTORY nodes (a scoped
    // `wireMessages` view can't be reconciled against a persisted message-count
    // watermark). Codex enables it by default; Claude subscription keeps its
    // existing experimental setting. Ineligible adapters always re-flatten.
    const sessionResume =
      !wireMessages &&
      (modelAdapter === 'codex-cli' ||
        (modelAdapter === 'claude-cli' && await ModelHandler.isClaudeSessionResumeEnabled()));

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
            if (input.onApprovalRequired === 'fail') {
              // Self-orchestrating adapters own the tool loop, so waiting on
              // the ordinary approval registry would deadlock an unattended
              // meeting. Throwing aborts the participant turn without running
              // the unresolved tool, matching runFlow's request/response path.
              throw new Error(
                `Headless run requires approval for tool "${call.name}" but no approver is available (approvalPolicy: fail).`,
              );
            }

            const toolCall: OpenAI.ChatCompletionMessageFunctionToolCall = {
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
    const liveMessageIds = new Set<string>();
    let acceptLiveProjection = true;
    let liveProjectionFailure: unknown;
    let liveProjectionChain: Promise<void> = Promise.resolve();
    const enqueueLiveProjection = (task: () => Promise<void>): void => {
      liveProjectionChain = liveProjectionChain.then(async () => {
        if (liveProjectionFailure) return;
        try {
          await task();
        } catch (error) {
          liveProjectionFailure = error;
        }
      });
    };
    const finishLiveProjection = async (): Promise<void> => {
      // Close the callback gate before draining: an adapter that resolves and
      // then invokes a late callback cannot append to a newer generation.
      acceptLiveProjection = false;
      await liveProjectionChain;
      if (liveProjectionFailure) throw liveProjectionFailure;
    };
    const flushLiveProjection = async (): Promise<void> => {
      await liveProjectionChain;
      if (liveProjectionFailure) throw liveProjectionFailure;
    };
    const onTranscriptMessage = emit
      ? (message: FlujoChatMessage) => {
          if (!acceptLiveProjection || input.executionAuthority?.signal.aborted) return;
          const withNode: FlujoChatMessage = nodeId ? { ...message, processNodeId: nodeId } : message;
          enqueueLiveProjection(() => commitFlowDurableMutation(durableContext, async () => {
            // A native partial draft with this id is now durable and must survive
            // a later failure in the same self-orchestrating run.
            liveMessageIds.delete(message.id);
            emit({ type: 'message', message: withNode, node: nodeId ? { nodeId } : undefined });
            // Fold under the SAME authority as the event.  The bus append is
            // independently fenced by conversationLog when it reaches disk.
            if (conversationId) ModelHandler.persistStreamedMessage(conversationId, withNode);
          }));
        }
      : undefined;

    // Native adapter token/tool deltas are live-only. Keep their stable ids so a
    // failed attempt can explicitly retract its transient UI drafts.
    const onModelDelta = emit
      ? (delta: ModelStreamDelta) => {
          if (!acceptLiveProjection || input.executionAuthority?.signal.aborted) return;
          liveMessageIds.add(delta.messageId);
          emit({
            type: 'model:delta',
            messageId: delta.messageId,
            delta: delta.contentDelta,
            // Never push large base64 blobs through the live SSE channel.
            // Binary media is persisted and delivered with the durable message.
            mediaPart:
              delta.mediaPart &&
              !delta.mediaPart.data &&
              !delta.mediaPart.url?.startsWith('data:')
                ? delta.mediaPart
                : undefined,
            toolCallDelta: delta.toolCallDelta,
            node: nodeId ? { nodeId } : undefined,
          });
        }
      : undefined;

    // Claude/Codex own their tool loops inside createCompletion(), so their MCP
    // progress callbacks cannot pass through processToolCalls below. Project
    // them onto the same live event used by the ordinary tool loop.
    const onToolProgress = emit
      ? (progress: ModelToolProgress) => {
          emit({
            type: 'tool:progress',
            toolCallId: progress.toolCallId,
            name: progress.name,
            progress: progress.progress,
            total: progress.total,
            message: progress.message,
            node: nodeId ? { nodeId } : undefined,
          });
        }
      : undefined;

    // Self-orchestrating SDK adapters own several model/tool turns inside one
    // createCompletion call, so runFlow cannot reach its between-step steering
    // drain while they are active. Let those adapters consume the same inbox at
    // their internal safe boundaries. They immediately record every consumed
    // message through onTranscriptMessage, which updates live state and the
    // append-only conversation log before the provider sees it.
    const consumeSteeringMessages = conversationId &&
      (modelAdapter === 'claude-cli' || modelAdapter === 'codex-cli')
      ? () => {
          const pending = takeSteeringMessages(conversationId);
          for (const message of pending) {
            if (!message.processNodeId && nodeId) message.processNodeId = nodeId;
          }
          return pending;
        }
      : undefined;

    // Cancellation watch for the in-flight provider call: pressing Stop sets the
    // conversation's isCancelled flag (own or an ancestor's, for subflow
    // children); generateCompletion polls this and aborts the call mid-stream
    // instead of letting the current model turn run to completion.
    const shouldAbort = conversationId || input.signal
      ? () => Boolean(
          input.signal?.aborted
          || (conversationId && ModelHandler.isConversationCancelled(conversationId))
        )
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
    const personaToolCallNames = conversationId
      ? (tools ?? [])
          .filter((t) => t.type === 'function' && isPersonaToolName(t.function.name))
          .map((t) => t.function.name)
      : [];
    const hasPersonaTool = personaToolCallNames.length > 0;
    const meetingToolCallNames = conversationId
      ? (tools ?? [])
          .filter((t) => t.type === 'function' && isMeetingToolName(t.function.name))
          .map((t) => t.function.name)
      : [];
    const hasMeetingTool = meetingToolCallNames.length > 0;
    // Issue #385: `call_subflow_<slug>` tool names are per-target-node and
    // dynamic (unlike the fixed-name synthetic tools above), so they can't be
    // hard-coded keys in the object literal below — collect every advertised
    // name and attach an executor per name after the literal is built.
    const subflowToolCallNames = conversationId
      ? (tools ?? [])
          .filter((t) => t.type === 'function' && isSubflowToolName(t.function.name))
          .map((t) => t.function.name)
      : [];
    const hasSubflowTool = subflowToolCallNames.length > 0;
    const behaviorToolCallNames = conversationId
      ? (tools ?? [])
          .filter((t) => t.type === 'function' && isBehaviorToolName(t.function.name))
          .map((t) => t.function.name)
      : [];
    const hasBehaviorTool = behaviorToolCallNames.length > 0;
    const localToolExecutors: Record<string, (args: Record<string, unknown>) => Promise<unknown>> | undefined =
      (hasRunResourceTool || hasMCPResourceTool || hasQuestionTool || hasTodoTool || hasPersonaTool || hasMeetingTool || hasSubflowTool || hasBehaviorTool)
        ? {
            [WRITE_RESOURCE_TOOL_NAME]: async (args: Record<string, unknown>): Promise<unknown> => {
              const outcome = await executeRunResourceTool(WRITE_RESOURCE_TOOL_NAME, args, {
                conversationId,
                node: runResourceNode,
                emit,
                ...durableContext,
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
                ...durableContext,
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
                ...durableContext,
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

    // call_subflow_* (issue #385): one executor per ADVERTISED tool-mode
    // Subflow name, dispatching to the same lane engine a parallel/spawn
    // Subflow uses (`runSubflowLanes()`), inline inside this tool call. Never
    // dispatched via processHandoffToolCalls — that only matches `handoff_to_*`.
    if (localToolExecutors && hasSubflowTool) {
      for (const toolName of subflowToolCallNames) {
        localToolExecutors[toolName] = async (args: Record<string, unknown>): Promise<unknown> => {
          const outcome = await executeSubflowToolCall(toolName, args, { conversationId, emit });
          if (!outcome.success) throw new Error(outcome.error ?? 'call_subflow failed');
          return outcome.data;
        };
      }
    }

    if (localToolExecutors && hasBehaviorTool) {
      for (const toolName of behaviorToolCallNames) {
        localToolExecutors[toolName] = async (args: Record<string, unknown>): Promise<unknown> => {
          const outcome = await executeBehaviorToolCall(toolName, args, { conversationId, emit });
          if (!outcome.success) throw new Error(outcome.error ?? 'call_behavior failed');
          return outcome.data;
        };
      }
    }

    if (localToolExecutors && hasPersonaTool) {
      for (const toolName of personaToolCallNames) {
        if (!isPersonaToolName(toolName)) continue;
        localToolExecutors[toolName] = async (args: Record<string, unknown>): Promise<unknown> => {
          const outcome = await executePersonaTool(toolName, args, {
            conversationId,
            executionAuthority: input.executionAuthority,
            personaAttribution: input.personaAttribution,
          });
          if (!outcome.success) throw new Error(outcome.error ?? `${toolName} failed`);
          return outcome.data;
        };
      }
    }

    // Meeting controls use the same live-state executor as the outer
    // request/response loop. Add only names actually advertised on this call;
    // ordinary flows therefore expose neither definitions nor local handlers.
    if (localToolExecutors && hasMeetingTool) {
      for (const toolName of meetingToolCallNames) {
        localToolExecutors[toolName] = async (args: Record<string, unknown>): Promise<unknown> => {
          const outcome = await executeMeetingTool(toolName, args, { conversationId });
          if (!outcome.success) throw new Error(outcome.error ?? `${toolName} failed`);
          return outcome.data;
        };
      }
    }

    // Resource-aware truncation markers (issue #168): build a lookup of captured
    // run resources for oversized PRIOR tool results/args, keyed by the producing
    // tool_call_id, so the Claude-subscription adapter can emit a head excerpt +
    // a dereferenceable flujo://run/... marker instead of a plain `…[truncated]`.
    // Built once here (cheap — the store index is cached) and passed to the
    // adapter; request/response adapters ignore it.
    const runResourceMarkers = conversationId
      ? await ModelHandler.buildRunResourceMarkers(conversationId)
      : undefined;

    // Summarization is applied after ProcessNode's node/output/input projection
    // and handoff filtering. The result exists only on the provider wire; the
    // canonical `messages` array remains the base for returned/persisted output.
    const projectedMessages = stripHandoffPlumbing(wireMessages ?? messages);
    const compaction = await ModelHandler.maybeCompactWire(
      projectedMessages,
      conversationId,
      nodeId,
      wireMessages ? 'node-projected' : 'full-history',
      { id: modelId, adapter: modelAdapter, contextWindow: modelContextWindow, compactionThreshold: modelCompactionThreshold },
      effectiveMaxTokens,
      { compactionMode, compactionKeepTokens },
      durableContext,
    );
    const effectiveMessages = compaction?.wireMessages ?? projectedMessages;

    // Call generateCompletion once with the materialized provider projection.
    const response = await this.generateCompletion(modelId, prompt, effectiveMessages, tools, {
      toolNameMap,
      maxTurns: effectiveMaxTurns,
      maxTokens: effectiveMaxTokens,
      requestToolApproval,
      onTranscriptMessage,
      consumeSteeringMessages,
      onModelDelta,
      onToolProgress,
      shouldAbort,
      conversationId,
      runId,
      nodeId,
      codexSession,
      onCodexSessionChange,
      localToolExecutors,
      runResourceMarkers,
      sessionResume,
      onFinalWire,
      beforeToolDispatch: input.beforeToolDispatch,
      authorizePersonaCoreMcp: input.executionAuthority?.authorizePersonaCoreMcp,
      beforeModelDispatch: input.beforeModelDispatch ?? input.executionAuthority?.assertCurrent,
      durableContext,
      flushTranscriptProjection: flushLiveProjection,
      // Issue #400: project the handler's bounded session-limit wait onto the
      // existing recovery:retry execution event, so the chat shows a live
      // countdown (and keeps Stop working) instead of a terminal error while
      // the server waits. Non-terminal: no run:done is emitted here.
      onRecoveryRetry: ({ attempt, retryAt, maxAttempts, failure }) => {
        emit?.({
          type: 'recovery:retry',
          attempt,
          retryAt,
          maxAttempts,
          failure,
          node: nodeId ? { nodeId } : undefined,
        });
      },
    });

    await finishLiveProjection();

    // Provider abort is cooperative and SDK callbacks can resolve after a lease
    // or meeting generation was replaced.  No returned media/message/resource
    // projection may observe that stale result.
    await assertFlowExecutionCurrent(durableContext);

    if (!response.success) {
      for (const messageId of liveMessageIds) {
        emit?.({ type: 'model:end', messageId, discard: true, node: nodeId ? { nodeId } : undefined });
      }
      log.warn('Model call returned an error', {
        modelId,
        errorClass: classifyStatisticsError(response.error),
      });

      // Ensure we're returning the complete error response with all details
      return {
        success: false,
        error: response.error
      };
    }

    const modelResponse = response.value;
    const content = modelResponse.content || '';
    const rawResponseMedia = modelResponse.media?.length
      ? modelResponse.media
      : extractAssistantMedia(modelResponse.fullResponse?.choices?.[0]?.message);
    const responseMedia = await persistModelMedia(rawResponseMedia, conversationId, nodeId, durableContext);
    // Canonical writeback always starts from the complete threaded input. Wire
    // summaries, resource substitutions, and omissions never enter the persisted
    // conversation transcript.
    const finalMessages: FlujoChatMessage[] = [...messages];

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

    const projectMcpToolCalls = (toolCalls: unknown): FlujoChatMessage['mcpToolCalls'] => {
      if (!Array.isArray(toolCalls)) return undefined;
      const projected: NonNullable<FlujoChatMessage['mcpToolCalls']> = {};
      for (const toolCall of toolCalls) {
        if (!toolCall || typeof toolCall !== 'object') continue;
        const call = toolCall as OpenAI.ChatCompletionMessageFunctionToolCall;
        if (call.type !== 'function' || typeof call.id !== 'string') continue;
        const decoded = decodeToolName(call.function?.name, toolNameMap);
        if (decoded) projected[call.id] = { serverName: decoded.server, toolName: decoded.tool };
      }
      return Object.keys(projected).length > 0 ? projected : undefined;
    };

    const completionToolCalls = requireFunctionToolCalls(
      modelResponse.fullResponse?.choices?.[0]?.message?.tool_calls,
    );

    if (modelResponse.transcript && modelResponse.transcript.length > 0) {
      // Self-orchestrating adapter (Claude subscription): the adapter already ran
      // the agentic tool loop in-process and handed back the full assistant/tool
      // sequence. Materialize each into the conversation so the tool calls +
      // results are visible, attaching usage to the final message.
      const baseTs = Date.now();
      const transcript = modelResponse.transcript;
      for (let idx = 0; idx < transcript.length; idx++) {
        const msg = transcript[idx];
        const isLast = idx === transcript.length - 1;
        const transcriptMedia = msg.media?.length
          ? await persistModelMedia(msg.media, conversationId, nodeId, durableContext)
          : undefined;
        finalMessages.push({
          ...msg,
          // Preserve the id/timestamp the adapter assigned (and live-emitted via
          // onTranscriptMessage) so the persisted message dedupes against the
          // already-streamed copy instead of duplicating it in the UI.
          id: msg.id ?? uuidv4(),
          timestamp: msg.timestamp ?? baseTs + idx, // keep ordering stable
          processNodeId: nodeId,
          ...(projectMcpToolCalls((msg as { tool_calls?: unknown }).tool_calls)
            ? { mcpToolCalls: projectMcpToolCalls((msg as { tool_calls?: unknown }).tool_calls) }
            : {}),
          ...(transcriptMedia?.length ? { media: transcriptMedia } : {}),
          ...(isLast && usage ? { usage } : {}),
        } as FlujoChatMessage);
      }
    } else {
      const generatedImageParts = responseMedia.flatMap((part): GeneratedImagePart[] => {
        if (part.type !== 'image') return [];
        const url = part.url ?? (
          part.data
            ? `data:${part.mimeType ?? 'image/png'};base64,${part.data}`
            : undefined
        );
        return url ? [{ type: 'image_url', image_url: { url } }] : [];
      });
      const assistantContent = generatedImageParts.length
        ? [
            ...(prefixedContent
              ? [{ type: 'text' as const, text: prefixedContent }]
              : []),
            ...generatedImageParts,
          ]
        : prefixedContent;

      // Create the assistant message with timestamp and ID
      const projectedMcpToolCalls = projectMcpToolCalls(completionToolCalls);
      const assistantMessage = {
        id: modelResponse.liveMessageId ?? uuidv4(),
        role: 'assistant',
        content: assistantContent,
        ...(responseMedia.length ? { media: responseMedia } : {}),
        // IMPORTANT: Include tool_calls if they exist in the raw response
        ...(completionToolCalls.length ? { tool_calls: completionToolCalls } : {}),
        ...(projectedMcpToolCalls
          ? { mcpToolCalls: projectedMcpToolCalls }
          : {}),
        timestamp: Date.now(), // Add timestamp
        processNodeId: nodeId, // Attach the process node ID
        ...(usage ? { usage } : {}),
      } as unknown as FlujoChatMessage;
      finalMessages.push(assistantMessage);
    }

    // Retract live-only drafts that never became a durable message. A draft is
    // confirmed either by onTranscriptMessage (self-orchestrating adapters) or
    // by carrying the adapter's liveMessageId into the final assistant message.
    // Anything left is a transient bubble the UI would otherwise keep showing
    // until the next refetch — e.g. a quarantined SDK turn, or an adapter whose
    // draft id could not be reconciled. Discarding it here keeps the live view
    // identical to what gets persisted (no phantom half-sentence bubbles).
    if (liveMessageIds.size > 0) {
      const materializedIds = new Set(finalMessages.map(message => message.id));
      for (const messageId of liveMessageIds) {
        if (materializedIds.has(messageId)) continue;
        emit?.({ type: 'model:end', messageId, discard: true, node: nodeId ? { nodeId } : undefined });
      }
    }

    // Map tool calls for the result structure (if they exist)
    // This provides structured info about requested calls, but doesn't execute them
    const toolCalls = completionToolCalls.length > 0 ? completionToolCalls.map((tc) => {
       try {
         return {
           name: tc.function.name,
           args: JSON.parse(tc.function.arguments),
           id: tc.id,
           result: '' // Result is empty as it's not processed here
         };
       } catch (e) {
         log.warn('Failed to parse tool arguments', {
           toolCallId: tc.id,
           errorClass: classifyStatisticsError(e),
         });
         return {
           name: tc.function.name,
           args: {}, // Use empty object on parse failure
           id: tc.id,
           result: ''
         };
       }
    }).filter(Boolean) as ToolCallInfo[] : undefined;


    // Return the result of this single step
    const result: Result<ModelCallResult> = {
      success: true,
      value: {
        content, // Final assistant text (from the model response / adapter)
        media: responseMedia,
        messages: finalMessages, // Include the new assistant message (now FlujoChatMessage[])
        fullResponse: modelResponse.fullResponse,
        toolCalls, // Pass the structured tool calls info
        effectiveMaxTurns, // #253: surface the resolved turn cap for runFlow's per-node counter
      }
    };

    log.debug('Model call completed', {
      modelId,
      nodeId,
      hasToolCalls: Boolean(toolCalls?.length),
      usagePresent: Boolean(usage),
    });
    return result;
  }



  /**
   * Generate completion using model service - pure function
   */
  private static async generateCompletion(
    modelId: string,
    prompt: string,
    messages: FlujoChatMessage[], // Expect FlujoChatMessage
    tools?: OpenAI.ChatCompletionFunctionTool[],
    opts?: {
      toolNameMap?: Record<string, DecodedTool>;
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
      consumeSteeringMessages?: () => FlujoChatMessage[];
      onModelDelta?: (delta: ModelStreamDelta) => void;
      onToolProgress?: (progress: ModelToolProgress) => void;
      /** Polled while the provider call is in flight; true aborts it (Stop). */
      shouldAbort?: () => boolean;
      /** Conversation + node identity, so self-orchestrating adapters can key a
       * reusable Agent SDK session per (conversationId, nodeId) — issue #154. */
      conversationId?: string;
      runId?: string;
      nodeId?: string;
      codexSession?: import('../types').CodexSessionMetadata;
      onCodexSessionChange?: (session: import('../types').CodexSessionMetadata | undefined) => void;
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
      onFinalWire?: ModelCallInput['onFinalWire'];
      /** Issue #400: called when a bounded session/rate limit is about to be
       *  waited out and retried. callModel projects this onto the existing
       *  `recovery:retry` execution event so the chat can show a countdown
       *  while the run stays alive and cancellable. */
      onRecoveryRetry?: (info: {
        attempt: number;
        retryAt: number;
        maxAttempts: number;
        failure: RecoveryFailureDetails;
      }) => void;
      /** Runtime-only Persona/activity fence assertion before tool side effects. */
      beforeToolDispatch?: () => Promise<void>;
      /** Call-time authorization for Persona Core-injected MCP handles. */
      authorizePersonaCoreMcp?: (serverName: string, nodeId?: string) => Promise<void>;
      /** Runtime-only fence assertion immediately before every provider attempt. */
      beforeModelDispatch?: () => Promise<void>;
      /** Authority context for resource/lineage writes performed in this call. */
      durableContext?: FlowDurableMutationContext;
      /** Drain authority-gated self-orchestrating transcript callbacks. */
      flushTranscriptProjection?: () => Promise<void>;
    }
  ): Promise<Result<ModelCallResult>> {
    log.debug('Preparing provider completion', {
      modelId,
      messageCount: messages.length,
      toolCount: tools?.length ?? 0,
    });

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

    // Issue #400 (automatic session-limit retry). Replaying a provider call is
    // only safe while the failed attempt produced NOTHING observable: any
    // streamed delta, transcript message, or in-loop tool execution flips this
    // flag and permanently disables replay for that attempt. `automaticRetriesUsed`
    // is a single budget for the whole logical model call, so the context-overflow
    // refit below can never multiply the number of waits.
    let attemptProducedOutput = false;
    let automaticRetriesUsed = 0;

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

      // Extract model settings. Malformed persisted values are omitted so NaN
      // never reaches an adapter; truly unset legacy values retain the old 0.0 default.
      const temperature = normalizeModelTemperature(
        model.temperature,
        model.provider,
        model.adapter,
        model.name,
      ) ?? (model.temperature === undefined || model.temperature === '' ? 0.0 : undefined);

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
      log.debug('Model credential resolved', {
        modelId,
        provider: model.provider,
        adapter: model.adapter,
        credentialPresent: decryptedApiKey.length > 0,
      });

      // Create the request parameters - the adapters expect ChatCompletionMessageParam,
      // not FlujoChatMessage, so strip ALL FLUJO-internal fields (id, timestamp,
      // processNodeId, usage, ...) before sending — strict providers 400 on unknown
      // message fields. Also strips handoff plumbing (the handoff tool-call turn,
      // its result, the synthetic "Continue") from the WIRE view only — the threaded
      // history kept in SharedState is untouched. So a node handed off to sees a
      // clean conversation. See ~/.claude/plans/execution-core-v2.md.
      const messagesWithMaterializedMedia = await Promise.all(messages.map(async (message) => {
        if (!message.media?.length) return message;
        const media = await materializeRunResourceMediaPaths(
          message.media,
          <T>(task: () => Promise<T>) => commitFlowDurableMutation(opts?.durableContext ?? {}, task),
        );
        return media === message.media ? message : { ...message, media };
      }));
      let apiMessages: OpenAI.ChatCompletionMessageParam[] = filterUnsupportedMediaInputs(
        toApiMessages(messagesWithMaterializedMedia),
        model.inputModalities,
      );
      let effectiveTools: OpenAI.ChatCompletionFunctionTool[] | undefined = tools;

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

      // Experimental visual context compaction (#356). This is a final-wire-only
      // transformation: persisted/displayed messages remain untouched. Exact
      // source is stashed in run resources before a complete old range is
      // replaced, and unsupported/unknown capability, secrets, poor density,
      // failed estimates, or non-positive savings remain on the text route.
      const compactionGlobals = await ModelHandler.getCompactionGlobalSettings();
      const visualConfig: EffectiveVisualCompaction = resolveEffectiveVisualCompaction(compactionGlobals);
      const visual = await compactMessagesVisually({
        messages: apiMessages,
        model,
        conversationId: opts?.conversationId,
        nodeId: opts?.nodeId,
        config: visualConfig,
        durableContext: opts?.durableContext,
      });
      apiMessages = visual.messages;
      const visualDiagnostic = visual.diagnostic;
      if (visualDiagnostic.route === 'image') {
        effectiveTools = ModelHandler.ensureReadResourceArmed(apiMessages, effectiveTools);
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
          // Without an offered tool there is no usable read_resource path.
          canUseTools: (effectiveTools?.length ?? 0) > 0,
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
      let sanitizedTools: OpenAI.ChatCompletionFunctionTool[] | undefined;
      if (effectiveTools && effectiveTools.length > 0) {
        const { ToolHandler } = await import('./ToolHandler');
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

      // A known context window lets us prevent a bad first request rather than
      // waiting for the provider to reject it. Only wire messages are refitted;
      // the persisted conversation remains unchanged. Models without usable
      // context metadata keep the historical reactive-overflow behavior.
      const inputBudget = ModelHandler.resolveOutgoingInputBudget(
        model.contextWindow,
        opts?.maxTokens
      );
      if (inputBudget !== undefined) {
        let estimatedInputTokens = ModelHandler.estimateOutgoingInputTokens(apiMessages, sanitizedTools);
        if (estimatedInputTokens > inputBudget && !isSelfOrchestratingAdapter(model.adapter)) {
          let budgetMarkers = opts?.runResourceMarkers;
          if (opts?.conversationId) {
            budgetMarkers = await ModelHandler.captureOversizedToolResultsForRefit(
              opts.conversationId,
              apiMessages,
              budgetMarkers,
              opts?.nodeId
            );
          }
          const refittedMessages = compactForWire(apiMessages, {
            resourceMarkers: budgetMarkers,
            // The refit ARMS read_resource itself (ensureReadResourceArmed just
            // below), so a `flujo://run/...` marker minted here is always
            // dereferenceable — even for a step that was offered no tools at
            // all. Deriving this from the pre-arming tool list would suppress
            // the URI and make the refit silently unrecoverable (#338).
            canUseTools: true,
            compactRecentToolResults: true,
            toolResultHeadChars: ModelHandler.OVERFLOW_TOOL_RESULT_HEAD_CHARS,
          });
          const refittedTools = ModelHandler.ensureReadResourceArmed(refittedMessages, sanitizedTools);
          estimatedInputTokens = ModelHandler.estimateOutgoingInputTokens(refittedMessages, refittedTools);

          if (estimatedInputTokens <= inputBudget) {
            log.warn('Refitted outgoing model request to its advertised input budget', {
              modelId,
              estimatedInputTokens,
              inputBudget,
            });
            apiMessages = refittedMessages;
            sanitizedTools = refittedTools;
          } else {
            return {
              success: false,
              error: createModelError(
                'context_budget_exceeded',
                `Estimated input (${estimatedInputTokens} tokens) exceeds the safe budget (${inputBudget} tokens). Reduce the active context, tool schemas, or configure summarizing compaction.`,
                modelId,
                undefined,
                { estimatedInputTokens, inputBudget, contextWindow: model.contextWindow }
              )
            };
          }
        }
      }

      // Official OpenAI Chat Completions cache strategy. Process-node calls move
      // their node-specific system instruction behind the wired conversation;
      // GPT-5.6+ additionally retain explicit breakpoints on the latest reusable
      // history boundaries.
      // This happens after every other wire rewrite so the fingerprint,
      // debugger snapshot, and provider all observe the exact same ordering.
      const preparedPromptCache = prepareOpenAiPromptCacheWire(apiMessages, model, {
        lateNodeInstruction: Boolean(opts?.nodeId),
      });
      apiMessages = preparedPromptCache.messages;
      const promptCacheMode = preparedPromptCache.explicit ? 'explicit' as const : undefined;
      if (preparedPromptCache.lateSystem) {
        log.debug('Prepared history-first OpenAI prompt-cache wire', {
          model: model.name,
          conversationId: opts?.conversationId,
          nodeId: opts?.nodeId,
          breakpointCount: preparedPromptCache.breakpointCount,
          movedSystemMessages: preparedPromptCache.movedSystemMessages,
          explicit: preparedPromptCache.explicit,
        });
      }

      // Capture the actual final generic provider wire after visual routing,
      // lossless compaction, tool trimming, proactive budget refit, and prompt-
      // cache ordering. Image data URLs are bounded by the ProcessNode observer
      // before debugger storage.
      try {
        opts?.onFinalWire?.(apiMessages, visualDiagnostic);
      } catch (error) {
        log.warn('Final-wire observer failed; continuing request', { error });
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

      // --- Prepare the exact request being sent ---
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
      const opaqueCredentialId = await credentialFingerprint(decryptedApiKey).catch(() => undefined);
      let providerAttemptOrdinal = 0;
      // One LOGICAL provider call; every retry below reuses this invocation id
      // and gets its own attempt id, so retries never look like separate calls.
      const providerInvocationId = newStatisticsInvocationId();
      const usageFromProviderResult = (value: unknown) => {
        if (!value || typeof value !== 'object') return undefined;
        const raw = (value as { usage?: Record<string, unknown> }).usage;
        if (!raw || typeof raw !== 'object') return undefined;
        const inputTokens = raw.prompt_tokens ?? raw.input_tokens;
        const outputTokens = raw.completion_tokens ?? raw.output_tokens;
        const totalTokens = raw.total_tokens;
        const promptDetails = raw.prompt_tokens_details as Record<string, unknown> | undefined;
        const inputDetails = raw.input_tokens_details as Record<string, unknown> | undefined;
        const cachedInputTokens = promptDetails?.cached_tokens ?? inputDetails?.cached_tokens;
        const cacheWriteTokens = promptDetails?.cache_write_tokens ?? inputDetails?.cache_write_tokens;
        const numeric = (candidate: unknown) => typeof candidate === 'number' && Number.isFinite(candidate)
          ? candidate
          : undefined;
        const usage = {
          inputTokens: numeric(inputTokens),
          outputTokens: numeric(outputTokens),
          totalTokens: numeric(totalTokens),
          cachedInputTokens: numeric(cachedInputTokens),
          cacheWriteTokens: numeric(cacheWriteTokens),
          contextWindow: model.contextWindow,
        };
        return Object.values(usage).some(item => item !== undefined) ? usage : undefined;
      };
      const recordProviderAttempt = (observation: {
        durationMs: number;
        outcome: 'completed' | 'error' | 'cancelled';
        result?: unknown;
        error?: unknown;
        usage?: ReturnType<typeof usageFromProviderResult>;
      }) => {
        if (!opts?.runId) return;
        try {
          const attemptOrdinal = ++providerAttemptOrdinal;
          const attemptUsage = observation.usage ?? usageFromProviderResult(observation.result)
            ?? (model.contextWindow ? { contextWindow: model.contextWindow } : undefined);
          recordStatisticsEvent(createStatisticsEvent({
            type: 'model.attempt',
            runId: opts.runId,
            node: opts.nodeId ? { id: opts.nodeId } : undefined,
            model: { id: modelId, name: model.displayName || model.name },
            provider: {
              id: model.provider || model.adapter || 'unknown',
              name: model.adapter || model.provider,
            },
            credentialId: opaqueCredentialId,
            attempt: attemptOrdinal,
            invocationId: providerInvocationId,
            attemptId: statisticsAttemptId(providerInvocationId, attemptOrdinal),
            outcome: observation.outcome,
            durationMs: observation.durationMs,
            // Provider phase == the measured provider/network call for THIS
            // attempt. Nothing is inferred when a boundary is unavailable.
            phases: { provider: observation.durationMs },
            errorClass: observation.outcome === 'error'
              ? classifyStatisticsError(observation.error)
              : undefined,
            // Cache semantics are only claimed for a completed call: a failed or
            // cancelled attempt reports no cache outcome at all.
            cacheOutcome: observation.outcome === 'completed'
              ? statisticsCacheOutcomeFromUsage(attemptUsage)
              : undefined,
            usage: attemptUsage,
          }));
        } catch {
          // Metadata instrumentation is never allowed to affect a provider call.
        }
      };

      // One retryable attempt at the provider call. Extracted into a closure so
      // a context-length overflow (below) can be retried once with oversized
      // tool results shrunk to run-resource URIs, WITHOUT duplicating the
      // cancellation watch, body-error check, and response shaping. Each attempt
      // starts its own cancellation watch (the shared abortController persists,
      // so a Stop during attempt 1 stays aborted and blocks a retry). Never
      // throws — a thrown SDK error is shaped into an error Result in-place.
      const attempt = async (
        attemptMessages: OpenAI.ChatCompletionMessageParam[],
        attemptTools: OpenAI.ChatCompletionFunctionTool[] | undefined
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

        const attemptStartedAt = Date.now();
        let providerAttemptObserved = false;
        let attemptOutcome: 'completed' | 'error' | 'cancelled' = 'error';
        let attemptError: unknown;
        let attemptUsage: OpenAiUsageLike | undefined;

        // The Claude subscription adapter streams transcript messages before its
        // terminal SDK result is known. Scope prose IDs to this model attempt so
        // a later SDK failure can compensate only its incomplete narration.
        const streamedAssistantProseIds = new Set<string>();
        const onTranscriptMessage = (message: FlujoChatMessage) => {
          // Anything the adapter already materialized is observable output: this
          // attempt is no longer safe to replay automatically (issue #400).
          attemptProducedOutput = true;
          if (ModelHandler.isStreamedAssistantProse(message)) streamedAssistantProseIds.add(message.id);
          opts?.onTranscriptMessage?.(message);
        };

        // Same guard for streamed deltas and for virtual tools executed in-loop
        // by self-orchestrating adapters: a side effect (or user-visible text)
        // means the call must fail terminally instead of being replayed.
        const onModelDelta = opts?.onModelDelta
          ? (delta: ModelStreamDelta) => {
              attemptProducedOutput = true;
              opts.onModelDelta!(delta);
            }
          : undefined;
        const onToolProgress = opts?.onToolProgress
          ? (progress: ModelToolProgress) => {
              // A live tool has started; retrying this provider attempt could
              // duplicate a non-idempotent command even if no result arrived.
              attemptProducedOutput = true;
              opts.onToolProgress!(progress);
            }
          : undefined;
        const localToolExecutors = opts?.localToolExecutors
          ? Object.fromEntries(
              Object.entries(opts.localToolExecutors).map(([toolName, executor]) => [
                toolName,
                async (args: Record<string, unknown>): Promise<unknown> => {
                  await opts.beforeToolDispatch?.();
                  attemptProducedOutput = true;
                  const result = await executor(args);
                  await assertFlowExecutionCurrent(opts.durableContext ?? {});
                  return result;
                },
              ])
            )
          : undefined;

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
          let liveMessageId: string | undefined;
          let media: ModelMediaPart[] | undefined;
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
            const issueCompletion = async () => {
              const hydratedMessages = await hydrateRunResourceMedia(
                attemptMessages,
                opts?.nodeId,
                {
                  strictOpenAiAudioFormats:
                    model.adapter === 'openai' || model.adapter === 'openai-responses',
                  commitDurableMutation: <T>(task: () => Promise<T>) =>
                    commitFlowDurableMutation(opts?.durableContext ?? {}, task),
                },
              );
              const input = {
              model,
              apiKey: decryptedApiKey,
              onProviderAttempt: (observation: {
                attempt: number;
                durationMs: number;
                outcome: 'completed' | 'error' | 'cancelled';
                result?: unknown;
                error?: unknown;
              }) => {
                providerAttemptObserved = true;
                recordProviderAttempt(observation);
              },
              messages: hydratedMessages,
              tools: attemptTools,
              temperature,
              // Effective output-token cap: node-level override → per-model default
              // (resolved in callModel, #189), falling back to the per-model value
              // for any caller that doesn't pass one. Undefined ⇒ adapter default.
              maxTokens: opts?.maxTokens ?? normalizeMaxTokens(model.maxTokens),
              toolNameMap: opts?.toolNameMap,
              localToolExecutors,
              maxTurns: opts?.maxTurns,
              requestToolApproval: opts?.requestToolApproval,
              onTranscriptMessage,
              consumeSteeringMessages: opts?.consumeSteeringMessages,
              onModelDelta,
              onToolProgress,
              signal: abortController.signal,
              beforeToolDispatch: opts?.beforeToolDispatch,
              authorizePersonaCoreMcp: opts?.authorizePersonaCoreMcp,
              afterToolDispatch: () => assertFlowExecutionCurrent(opts?.durableContext ?? {}),
              commitDurableMutation: <T>(task: () => Promise<T>) =>
                commitFlowDurableMutation(opts?.durableContext ?? {}, task),
              conversationId: opts?.conversationId,
              runId: opts?.runId,
              nodeId: opts?.nodeId,
              codexSession: opts?.codexSession,
              onCodexSessionChange: opts?.onCodexSessionChange,
              runResourceMarkers: opts?.runResourceMarkers,
              sessionResume: opts?.sessionResume,
              // Derived from the tool-block hash, or from the conversation for a
              // no-tool history-first wire, so requests sharing the reusable
              // prefix route to one prompt-cache shard (see derivePromptCacheKey).
              // Adapters that don't support it ignore it.
              promptCacheKey: derivePromptCacheKey(prefixFingerprint, {
                conversationId: opts?.conversationId,
                preferConversation: preparedPromptCache.lateSystem,
              }),
              promptCacheMode,
              };
              // All provider-side preflight (model/key/settings/tool shaping,
              // compaction, media hydration) is complete.  Check the current
              // lease/generation at the final dispatch boundary for EVERY
              // attempt, including bounded retries and summary calls.
              await opts?.beforeModelDispatch?.();
              return opts?.onModelDelta && adapter.createStreamCompletion
                ? adapter.createStreamCompletion(input)
                : adapter.createCompletion(input);
            };

            if (autoUnloadOllama && ollamaRootForUnload) {
              ({ completion: chatCompletion, transcript, liveMessageId, media } = await withOllamaLock(
                ollamaRootForUnload,
                async () => {
                  const prev = getLoadedModel(ollamaRootForUnload);
                  if (prev && prev !== model.name) {
                    await opts?.beforeModelDispatch?.();
                    log.info(
                      `[ModelHandler] Auto-unloading Ollama model "${prev}" to free VRAM for "${model.name}" on ${ollamaRootForUnload}`
                    );
                    await unloadModel(ollamaRootForUnload, prev);
                  }
                  const res = await issueCompletion();
                  await assertFlowExecutionCurrent(opts?.durableContext ?? {});
                  setLoadedModel(ollamaRootForUnload, model.name);
                  return res;
                }
              ));
            } else {
              ({ completion: chatCompletion, transcript, liveMessageId, media } = await issueCompletion());
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
            attemptUsage = rawUsage;
            logCacheOutcome({
              conversationId: opts?.conversationId,
              nodeId: opts?.nodeId,
              model: model.name,
              provider: model.provider,
              adapter: model.adapter,
              promptTokens: rawUsage.prompt_tokens ?? 0,
              completionTokens: rawUsage.completion_tokens ?? 0,
              cachedTokens: rawUsage.prompt_tokens_details?.cached_tokens,
              cacheWriteTokens: rawUsage.prompt_tokens_details?.cache_write_tokens,
              drift: prefixDrift,
              fingerprint: prefixFingerprint,
            });
          }

          log.debug('Provider completion returned', {
            modelId,
            usagePresent: Boolean(chatCompletion?.usage),
            choiceCount: chatCompletion?.choices?.length ?? 0,
          });

          // --- Check for top-level error in the response ---
          // Some providers (like OpenRouter for certain errors) might return a 200 OK
          // with an error object in the body instead of throwing an HTTP error.
          if (chatCompletion && typeof chatCompletion === 'object' && 'error' in chatCompletion && chatCompletion.error) {
            const errorObj = chatCompletion.error as any; // Type assertion for easier access
            attemptError = errorObj;

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
            log.warn('Provider response contained an error object', {
              modelId,
              code: extracted.code,
              type: extracted.type,
            });
            return errorResult;
          }
          // --- End error check ---


          // Create a standardized response with OpenAI-compatible structure
          // Ensure choices exist before accessing them
          const choice = chatCompletion?.choices?.[0];
          if (!choice) {
            attemptError = { type: 'provider_response' };
            log.error('API response missing choices array or first choice.', { modelId });
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

          // A model that reports it is done (finish_reason 'stop') but produced
          // neither text, generated images, nor a tool call is not a valid
          // completion — it's a
          // provider-side malfunction (issue #288). Surfacing it as an error
          // instead of a silent empty message keeps the flow from advancing on
          // nothing.
          const hasToolCalls = !!choice.message?.tool_calls?.length;
          const fallbackMedia = extractAssistantMedia(choice.message);
          const generatedMedia = media?.length ? media : fallbackMedia;
          const hasGeneratedMedia = generatedMedia.length > 0;
          const hasTextContent =
            (typeof choice.message?.content === 'string' &&
              choice.message.content.trim().length > 0) ||
            (Array.isArray(choice.message?.content) && choice.message.content.length > 0);
          if (choice.finish_reason === 'stop' && !hasToolCalls && !hasGeneratedMedia && !hasTextContent) {
            attemptError = { type: 'provider_response' };
            log.error('API reported finish_reason "stop" with an empty message, no media, and no tool calls.', { modelId });
            return {
              success: false,
              error: createModelError(
                'api_error',
                'Model reported completion (finish_reason "stop") but returned an empty message with no media or tool calls.',
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
              media: generatedMedia,
              messages: [...messages], // Return original messages with timestamps
              fullResponse: chatCompletion, // Return the full original response
              transcript, // Present only for self-orchestrating adapters (Claude subscription)
              liveMessageId,
            }
          };

          attemptOutcome = 'completed';

          return result;
        } catch (error) {
          attemptError = error;
          attemptOutcome = abortController.signal.aborted ? 'cancelled' : 'error';
          // A genuine Claude subscription failure can follow streamed prose. Do
          // not replay that failed-turn narration on recovery; tool activity from
          // the same attempt is not in this set and remains durable. User-driven
          // cancellation has its own partial-run semantics, so leave it intact.
          if (model.adapter === 'claude-cli' && !abortController.signal.aborted) {
            await opts?.flushTranscriptProjection?.();
            await ModelHandler.removeFailedStreamedAssistantProse(opts?.conversationId, streamedAssistantProseIds);
          }
          return ModelHandler.shapeCompletionError(error, modelId, abortController.signal.aborted);
        } finally {
          // Request/response adapters report each transport retry themselves.
          // Other adapters have one authoritative outer invocation here.
          if (!providerAttemptObserved) {
            recordProviderAttempt({
              outcome: attemptOutcome,
              durationMs: Math.max(0, Date.now() - attemptStartedAt),
              error: attemptError,
              usage: attemptUsage ? {
                inputTokens: attemptUsage.prompt_tokens,
                outputTokens: attemptUsage.completion_tokens,
                totalTokens: attemptUsage.total_tokens,
                cachedInputTokens: attemptUsage.prompt_tokens_details?.cached_tokens,
                cacheWriteTokens: attemptUsage.prompt_tokens_details?.cache_write_tokens,
                contextWindow: model.contextWindow,
              } : undefined,
            });
          }
        }
      };

      /**
       * Bounded, abort-aware session-limit retry around ONE provider call
       * (issue #400).
       *
       * When the provider answers "you've hit your session limit" AND hands
       * back a valid, small `Retry-After`, the chat turn should wait rather
       * than fail: we emit `recovery:retry` (so the UI can count down while the
       * run stays alive and cancellable), sleep on an abort-aware timer tied to
       * the same AbortSignal the Stop button drives, then replay the SAME
       * request. Exactly one timer and one provider attempt exist at a time.
       *
       * Deliberately conservative — replay is skipped when:
       *  - the run was cancelled (Stop) before or during the wait;
       *  - the attempt already produced observable output or ran a tool, so a
       *    replay could duplicate a side effect;
       *  - the adapter runs its own connection retries (codex-cli), which would
       *    multiply attempts beyond the approved cap;
       *  - the failure is not a session/rate limit, carries no usable
       *    `Retry-After`, or asks for a wait beyond the configured maximum;
       *  - the per-call retry budget is exhausted.
       * In every one of those cases the original normalized provider error is
       * returned unchanged, so runFlow's existing recovery classification,
       * persistence, and terminal `run:done` handling stay exactly as they were.
       */
      const attemptWithLimitRetry = async (
        attemptMessages: OpenAI.ChatCompletionMessageParam[],
        attemptTools: OpenAI.ChatCompletionFunctionTool[] | undefined
      ): Promise<Result<ModelCallResult>> => {
        for (;;) {
          attemptProducedOutput = false;
          const attemptResult = await attempt(attemptMessages, attemptTools);
          if (attemptResult.success) return attemptResult;

          if (abortController.signal.aborted || opts?.shouldAbort?.()) return attemptResult;
          if (attemptProducedOutput) return attemptResult;
          if (model.adapter === 'codex-cli') return attemptResult;
          if (automaticRetriesUsed >= MAX_AUTOMATIC_MODEL_RETRIES) {
            log.warn('Automatic session-limit retries exhausted; returning the provider error', {
              modelId,
              retries: automaticRetriesUsed,
            });
            return attemptResult;
          }

          const plan = planAutomaticRetry(attemptResult.error);
          if (!plan) return attemptResult;

          automaticRetriesUsed += 1;
          const nextAttempt = automaticRetriesUsed + 1;
          log.warn('Provider reported a bounded session/rate limit; waiting before an automatic retry', {
            modelId,
            attempt: nextAttempt,
            delayMs: plan.delayMs,
            status: plan.status,
            code: plan.code,
          });

          try {
            opts?.onRecoveryRetry?.({
              attempt: nextAttempt,
              retryAt: plan.retryAt,
              maxAttempts: MAX_AUTOMATIC_MODEL_RETRIES + 1,
              failure: {
                category: 'rate_limit',
                message: attemptResult.error.message,
                code: plan.code,
                status: plan.status,
                retryable: true,
              },
            });
          } catch (error) {
            log.warn('recovery:retry observer failed; continuing with the wait', { error });
          }

          const waited = await waitForRetryWindow(plan.delayMs, {
            signal: abortController.signal,
            shouldAbort: opts?.shouldAbort,
          });
          if (waited === 'aborted') {
            // Stop during the wait: clear the timer (waitForRetryWindow already
            // did), never call the provider again, and take the normal clean
            // cancellation path.
            abortController.abort();
            log.info('Cancellation during a session-limit wait; skipping the retry.', { modelId });
            return {
              success: false,
              error: createModelError('cancelled', 'Execution cancelled by user.', modelId),
            };
          }
        }
      };

      let result = await attemptWithLimitRetry(apiMessages, sanitizedTools);

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
          await assertFlowExecutionCurrent(opts.durableContext ?? {});
          refitMarkers = await ModelHandler.captureOversizedToolResultsForRefit(
            opts.conversationId,
            apiMessages,
            refitMarkers,
            opts?.nodeId,
            opts?.durableContext,
          );
        }
        const refitMessages = compactForWire(apiMessages, {
          resourceMarkers: refitMarkers,
          // Same as the proactive refit above: read_resource is armed on the
          // retry, so the URI marker must be emitted regardless of how many
          // tools the original request carried (#338).
          canUseTools: true,
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
          try {
            opts?.onFinalWire?.(refitMessages, visualDiagnostic);
          } catch (error) {
            log.warn('Final-wire observer failed during overflow refit; continuing retry', { error });
          }
          result = await attemptWithLimitRetry(refitMessages, refitTools);
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
    const { toolCalls, toolNameMap, emit, conversationId, runId, node, signal, mcpNodes } = input;
    const durableContext: FlowDurableMutationContext = {
      executionAuthority: input.executionAuthority,
      personaAttribution: input.personaAttribution,
    };

    log.debug('Processing tool-call batch', { count: toolCalls?.length ?? 0 });

    if (!toolCalls || toolCalls.length === 0) {
      const emptyResult: Result<ToolCallProcessingResult> = {
        success: true,
        value: {
          toolCallMessages: [],
          processedToolCalls: []
        }
      };

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
      const groupKeyForCall = (tc: OpenAI.ChatCompletionMessageFunctionToolCall): string => {
        const toolName = tc.function.name;
        if (toolName.startsWith('handoff_to_') || toolName === 'handoff') return LOCAL_GROUP;
        if (isMCPResourceToolName(toolName)) return LOCAL_GROUP;
        if (isRunResourceToolName(toolName)) return LOCAL_GROUP;
        if (isQuestionToolName(toolName)) return LOCAL_GROUP;
        if (isTodoToolName(toolName)) return LOCAL_GROUP;
        if (isPersonaToolName(toolName)) return LOCAL_GROUP;
        if (isMeetingToolName(toolName)) return LOCAL_GROUP;
        if (isSubflowToolName(toolName)) return LOCAL_GROUP;
        if (isBehaviorToolName(toolName)) return LOCAL_GROUP;
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
        const decodedForUi = decodeToolName(name, toolNameMap);
        let invocationArgsForUi: Record<string, unknown> | undefined;
        try {
          const parsed = JSON.parse(argsString);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            invocationArgsForUi = parsed as Record<string, unknown>;
          }
        } catch {
          // The normal parsing path below will surface malformed tool args.
        }

        const toolCallMessages: FlujoChatMessage[] = [];
        const processedToolCalls: ProcessedToolCall[] = [];
        const toolStartedAt = Date.now();
        // When the final authority check rejects, preserve that failure as a
        // run-level stop. The broad per-tool catch below intentionally turns
        // ordinary tool failures into transcript messages, but a stale Persona
        // worker must never be allowed to hand that failure back to the model
        // and continue executing.
        let executionAuthorityFailure: unknown;
        // Stable identity for this LOGICAL tool invocation, so a duplicate
        // observation of the same call is deduplicated during aggregation.
        const toolInvocationId = newStatisticsInvocationId();

        // Keep the authority assertion outside the per-tool error-to-message
        // conversion below. A stale Persona fence is a run-level stop, not a
        // recoverable tool error the model may reason past.
        await input.beforeToolDispatch?.();

        try {
          // Cancellation check BEFORE starting this call (issue #109/#252): once
          // Stop is pressed, a not-yet-started call is answered with a synthetic
          // "cancelled" tool message so every tool_call id stays answered and the
          // transcript well-formed. In-flight calls are killed via the signal.
          if (input.shouldAbort?.()) {
            log.info(`Cancellation detected before tool call ${name}; answering it with a synthetic cancelled result.`);
            const cancelledReason = 'Execution cancelled by user before this tool call ran.';
            const uiLink = decodedForUi
              ? await ModelHandler.resolveToolUiLink(
                  decodedForUi.server,
                  decodedForUi.tool,
                  undefined,
                  decodedForUi.uiResourceUri,
                  invocationArgsForUi,
                )
              : undefined;
            toolCallMessages.push({
              id: uuidv4(),
              role: "tool",
              tool_call_id: id,
              content: cancelledReason,
              timestamp: Date.now(),
              ...(uiLink ? { ui: { ...uiLink, cancelledReason, isError: true } } : {}),
            });
            processedToolCalls.push({ name, args: {}, id, result: cancelledReason });
            return;
          }
          // Parse the arguments
          let args = JSON.parse(argsString) as Record<string, unknown>;
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
              ...durableContext,
            });
            await assertFlowExecutionCurrent(durableContext);
            const resultContent = outcome.success
              ? JSON.stringify(outcome.data)
              : `Error: ${outcome.error}`;
            await commitFlowDurableMutation(durableContext, async () => {
              emit?.({
                type: 'tool:result',
                toolCallId: id,
                name,
                result: resultContent.length > 500 ? `${resultContent.slice(0, 500)}…` : resultContent,
                isError: !outcome.success,
              });
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
            const outcome = await executeRunResourceTool(name, args, {
              conversationId,
              node,
              emit,
              mcpNodes: mcpNodes ?? [],
              ...durableContext,
            });
            await assertFlowExecutionCurrent(durableContext);
            const resultContent = outcome.success
              ? JSON.stringify(outcome.data)
              : `Error: ${outcome.error}`;
            await commitFlowDurableMutation(durableContext, async () => {
              emit?.({
                type: 'tool:result',
                toolCallId: id,
                name,
                result: resultContent.length > 500 ? `${resultContent.slice(0, 500)}…` : resultContent,
                isError: !outcome.success,
              });
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

          // Issue #415 phase 4: authored, fenced Persona memory/WorkItem tools.
          if (isPersonaToolName(name)) {
            emit?.({ type: 'tool:call', toolCallId: id, name, args: argsString });
            const outcome = await executePersonaTool(name, args, {
              conversationId,
              executionAuthority: input.executionAuthority,
              personaAttribution: input.personaAttribution,
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

          // Coordinator-owned meeting controls. The executor verifies that the
          // conversation is an active meeting participant and appends only a
          // normalized action to this turn's live SharedState. The coordinator
          // commits those actions after the participant turn settles.
          if (isMeetingToolName(name)) {
            emit?.({ type: 'tool:call', toolCallId: id, name, args: argsString });
            const outcome = await executeMeetingTool(name, args, { conversationId });
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

          if (isBehaviorToolName(name)) {
            emit?.({ type: 'tool:call', toolCallId: id, name, args: argsString });
            const outcome = await executeBehaviorToolCall(name, args, {
              conversationId,
              toolCallId: id,
              emit,
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

          // call_subflow_* tool-invocation (issue #385, deferred Part B of #359):
          // synthetic FLUJO tool that runs a tool-mode Subflow target's lanes
          // INLINE (via runSubflowLanes(), the same bounded pool a parallel/spawn
          // Subflow uses) and returns a structured JSON result — no graph
          // transition. Only offered when a connected Subflow target authored
          // `invocationMode: 'tool'` AND the experimental `subflowToolInvocation`
          // setting is on (ProcessNode.generateHandoffTools), so this branch is
          // inert for every existing flow.
          if (isSubflowToolName(name)) {
            emit?.({ type: 'tool:call', toolCallId: id, name, args: argsString });
            const outcome = await executeSubflowToolCall(name, args, { conversationId, emit });
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

          if (name.startsWith(SUBFLOW_DETACHED_TOOL_PREFIX) || name === 'subflow_task_get' || name === 'subflow_task_cancel') {
            emit?.({ type: 'tool:call', toolCallId: id, name, args: argsString });
            const outcome = name === 'subflow_task_get'
              ? await executeTaskGet(String(args.taskId ?? ''))
              : name === 'subflow_task_cancel'
                ? await executeTaskCancel(String(args.taskId ?? ''))
                : await executeDetachedSubflowStart(name, args, { conversationId, emit });
            const resultContent = outcome.success ? JSON.stringify(outcome.data) : `Error: ${outcome.error}`;
            emit?.({ type: 'tool:result', toolCallId: id, name, result: resultContent.slice(0, 500), isError: !outcome.success });
            toolCallMessages.push({ id: uuidv4(), role: 'tool', tool_call_id: id, content: resultContent, timestamp: Date.now() });
            processedToolCalls.push({ name, args, id, result: resultContent });
            return;
          }

          // Decode the model-facing name back to (server, tool). New names use the
          // mcp_<slug>_<hash> scheme (decoded via toolNameMap); legacy conversations
          // used _-_-_SERVER_-_-_TOOL (decoded by decodeToolName's fallback).
          const decoded = decodedForUi;
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
            const uiLink = await ModelHandler.resolveToolUiLink(
              decoded.server,
              decoded.tool,
              undefined,
              decoded.uiResourceUri,
              invocationArgsForUi,
            );
            toolCallMessages.push({
              id: uuidv4(),
              role: 'tool',
              tool_call_id: id,
              content: freshness.reason,
              timestamp: Date.now(),
              ...(uiLink
                ? { ui: { ...uiLink, cancelledReason: freshness.reason, isError: true } }
                : {}),
            });
            processedToolCalls.push({ name, args, id, result: freshness.reason });
            return;
          }

          // Fixed server/node arguments are resolved only at dispatch time and
          // win over anything the model attempted to provide. They were removed
          // from the advertised schema, so the model never sees or controls them.
          args = await applyPresetArguments(args, decoded.presetArgs, decoded.context);

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
              await commitFlowDurableMutation(durableContext, async () => {
                const writtenArgs = await writeRunResource({
                  conversationId,
                  mimeType: 'application/json',
                  kind: 'text',
                  data: { text: argsString },
                  producedBy: {
                    source: 'tool-args',
                    payloadRole: 'tool-arguments',
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
              });
            } catch (error) {
              rethrowFlowExecutionAuthorityError(error);
              log.error('Tool-args capture failed; continuing with the call', {
                errorClass: classifyStatisticsError(error),
              });
            }
          }

          // Call the tool via MCP service. The timeout comes from the tool's MCP
          // node (properties.toolTimeout, seconds; -1 = none), defaulting to 5
          // minutes. Server progress notifications are forwarded as live
          // tool:progress events AND reset the SDK's request timer (see
          // services/mcp/tools.ts), so a finite timeout only kills silent calls.
          const timeout = decoded.timeout ?? DEFAULT_TOOL_CALL_TIMEOUT_SECONDS;

          // Issue #357: register a per-call AbortController so the user can
          // cancel THIS tool call from the chat UI (or so whole-run Stop can
          // interrupt it) while it is already in flight. Combined with any
          // inbound signal from the caller; released in the finally below so
          // controllers never leak.
          const cancelScope = conversationId ?? runId;
          // Issue #413: ONE canonical owner key per run for MCP-side resources
          // (Bash sessions). `run:<runId>` is preferred because the run is the
          // lifetime whose end must release them; a conversation outlives it.
          const runOwnerScope = ownerScopeForRun({ runId, conversationId });
          const perCallController = cancelScope ? registerToolCall(cancelScope, id) : undefined;
          const callSignal = combineAbortSignals(signal, perCallController?.signal);
          let result: Awaited<ReturnType<typeof mcpService.callTool>>;
          try {
            // Approval, resource capture, or queueing above may have taken long
            // enough for the lease to expire. Re-check at the final side-effect
            // boundary, immediately before MCP dispatch.
            try {
              await input.beforeToolDispatch?.();
              await input.executionAuthority?.authorizePersonaCoreMcp?.(
                serverName,
                decoded.nodeId,
              );
            } catch (error) {
              executionAuthorityFailure = error;
              throw error;
            }
            const onProgress = (progress: { progress: number; total?: number; message?: string }) => emit?.({
              type: 'tool:progress',
              toolCallId: id,
              name,
              progress: progress.progress,
              total: progress.total,
              message: progress.message,
            });
            result = conversationId
              ? await mcpService.callTool(
                  serverName,
                  toolName,
                  args,
                  timeout,
                  onProgress,
                  decoded.nodeId,
                  callSignal,
                  'model',
                  runOwnerScope,
                  { conversationId },
                )
              : await mcpService.callTool(
                  serverName,
                  toolName,
                  args,
                  timeout,
                  onProgress,
                  decoded.nodeId,
                  callSignal,
                  'model',
                  runOwnerScope,
                );
            // The MCP abort is cooperative.  A result may arrive after the
            // Persona lease/meeting generation was replaced; reject it before
            // statistics, resource capture, lineage, or result events observe it.
            await assertFlowExecutionCurrent(durableContext);
          } finally {
            if (cancelScope) releaseToolCall(cancelScope, id);
          }

          // Tier 3 data flow: auto-capture binary/large tool results as
          // run-scoped resources. The capture may rewrite the result (binary
          // items become URI stubs — base64 in a tool message costs context
          // and helps no model); everything captured is announced as a
          // resource:write event carrying the producing toolCallId (the stable
          // lineage key — runFlow rewrites tool-MESSAGE ids afterwards).
          // Capture never breaks the run: on any failure the original result
          // is kept untouched.
          let effectiveData = result.data;
          // Media captured out of this tool result. Stubbing it in the tool
          // message is only half the round-trip: these parts ride along on the
          // tool message so toApiMessages can fold them into the next user turn
          // as genuine image_url/input_audio INPUT parts. Without this a model
          // can never perceive what its own tools produced.
          let capturedMedia: ModelMediaPart[] = [];
          if (result.success && conversationId && runResourceSettings) {
            try {
              if (runResourceSettings.autoCaptureEnabled) {
                const outcome = await commitFlowDurableMutation(durableContext, async () => {
                  const captured = await captureToolResult({
                    conversationId,
                    server: serverName,
                    toolName,
                    toolCallId: id,
                    nodeId: node?.nodeId,
                    result: result.data as CallToolResult,
                    settings: runResourceSettings,
                  });
                  for (const entry of captured.captured) {
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
                  return captured;
                });
                effectiveData = outcome.result;
                // Keep compatibility with old/mocked CaptureOutcome values while
                // the new media field rolls through every call site.
                capturedMedia = outcome.media ?? [];
              }
            } catch (error) {
              rethrowFlowExecutionAuthorityError(error);
              log.error('Run-resource auto-capture failed; keeping original tool result', {
                errorClass: classifyStatisticsError(error),
              });
              effectiveData = result.data;
              capturedMedia = [];
            }
          }

          // Persistence is preferred, but media delivery must not depend on it.
          // Ephemeral subflows have no conversation id, capture can be disabled,
          // and stores can hit a cap. In every one of those cases split any
          // remaining media out of the text projection and carry it inline on
          // the tool message so toApiMessages still emits a genuine model-input
          // part. Successful captures have already replaced media with stubs, so
          // this is a no-op for the normal URI-backed path.
          if (result.success && effectiveData && typeof effectiveData === 'object') {
            const split = splitToolResultMedia(effectiveData as CallToolResult);
            if (split.hasMedia) {
              effectiveData = split.textResult;
              const inlineMedia = split.mediaItems
                .map(mediaPartFromToolItem)
                .filter((part): part is ModelMediaPart => Boolean(part));
              capturedMedia = [...capturedMedia, ...inlineMedia];
            }
          }

          // Format the result
          let resultContent = result.success
            ? JSON.stringify(effectiveData)
            : `Error: ${result.error}`;

          // Keep an exact transcript-level copy of medium-large results for the
          // browser's expansion-time loader. Results over the context boundary
          // are captured by boundToolResult below instead, avoiding duplicates.
          if (
            result.success
            && conversationId
            && runResourceSettings?.autoCaptureEnabled
            && resultContent.length >= runResourceSettings.textThresholdChars
          ) {
            const resultBytes = Buffer.byteLength(resultContent, 'utf8');
            const maxBytes = runResourceSettings.toolResultMaxBytes ?? DEFAULT_TOOL_RESULT_MAX_BYTES;
            const maxLines = runResourceSettings.toolResultMaxLines ?? DEFAULT_TOOL_RESULT_MAX_LINES;
            const overBytes = maxBytes > 0 && resultBytes > maxBytes;
            let overLines = false;
            if (maxLines > 0) {
              let lines = 1;
              for (let index = 0; index < resultContent.length && lines <= maxLines; index++) {
                if (resultContent.charCodeAt(index) === 10) lines++;
              }
              overLines = lines > maxLines;
            }
            if (!overBytes && !overLines) {
              try {
                await commitFlowDurableMutation(durableContext, async () => {
                  const writtenResult = await writeRunResource({
                    conversationId,
                    mimeType: 'application/json',
                    kind: 'text',
                    data: { text: resultContent },
                    producedBy: {
                      source: 'tool-result',
                      payloadRole: 'tool-message',
                      nodeId: node?.nodeId,
                      server: serverName,
                      toolName,
                      toolCallId: id,
                    },
                  });
                  if (!('skipped' in writtenResult)) {
                    emit?.({
                      type: 'resource:write',
                      node,
                      server: 'flujo',
                      uri: writtenResult.uri,
                      mimeType: writtenResult.mimeType,
                      size: writtenResult.size,
                      source: 'tool-result',
                      toolCallId: id,
                    });
                  }
                });
              } catch (error) {
                rethrowFlowExecutionAuthorityError(error);
                log.error('Tool-result display capture failed; keeping inline result', {
                  errorClass: classifyStatisticsError(error),
                });
              }
            }
          }

          // Tier-boundary bound (#251): every oversized tool result is truncated
          // to a head+tail preview and the full content spilled UNCONDITIONALLY
          // to a run resource on THIS turn — so a 5 MB result never reaches the
          // wire in full (not even on the first turn) and both ends of a long
          // log survive. Runs AFTER auto-capture (binaries already stubbed) so
          // only the remaining text form is bounded. Never breaks the run.
          if (result.success && conversationId && runResourceSettings) {
            try {
              const bounded = await commitFlowDurableMutation(durableContext, () => boundToolResult({
                  conversationId,
                  toolCallId: id,
                  server: serverName,
                  toolName,
                  nodeId: node?.nodeId,
                  content: resultContent,
                  settings: runResourceSettings,
                }),
              );
              if (bounded.spilled) {
                resultContent = bounded.content;
                if (bounded.uri) {
                  await commitFlowDurableMutation(durableContext, async () => {
                    emit?.({
                      type: 'resource:write',
                      node,
                      server: 'flujo',
                      uri: bounded.uri!,
                      mimeType: 'text/plain',
                      size: bounded.bytes,
                      source: 'tool-result',
                      toolCallId: id,
                    });
                  });
                }
              }
            } catch (error) {
              rethrowFlowExecutionAuthorityError(error);
              log.error('boundToolResult failed; keeping full tool result', {
                errorClass: classifyStatisticsError(error),
              });
            }
          }

          // The full result reaches the conversation as the tool message below;
          // the event carries a preview so the log stays light.
          await commitFlowDurableMutation(durableContext, async () => {
            emit?.({
              type: 'tool:result',
              toolCallId: id,
              name,
              result: resultContent.length > 500 ? `${resultContent.slice(0, 500)}…` : resultContent,
              isError: !result.success
            });
          });

          // MCP Apps (#97): if the server linked this tool to a `ui://` UI
          // resource (SEP-1865 `_meta.ui.resourceUri`) AND has the per-server
          // opt-in enabled, attach the link so chat can render it sandboxed.
          const cancelledReason =
            !result.success
            && (
              result.errorType === 'cancelled'
              || result.errorType === 'timeout'
              || signal?.aborted
              || input.shouldAbort?.()
            )
              ? (result.error || 'Tool execution cancelled.')
              : undefined;
          const uiLink = await ModelHandler.resolveToolUiLink(
            serverName,
            toolName,
            result.data,
            decoded.uiResourceUri,
            invocationArgsForUi,
          );

            // Add tool result message with timestamp and ID
            toolCallMessages.push({
              id: uuidv4(), // Generate unique ID
              role: "tool",
              tool_call_id: id,
              content: resultContent,
              timestamp: Date.now(), // Add timestamp
              ...(capturedMedia.length ? { media: capturedMedia } : {}),
              ...(uiLink
                ? {
                    ui: {
                      ...uiLink,
                      ...(!result.success ? { isError: true } : {}),
                      ...(cancelledReason ? { cancelledReason } : {}),
                    },
                  }
                : {})
            });

          // Add to processed tool calls
          processedToolCalls.push({
            name,
            args,
            id,
            result: resultContent
          });
        } catch (error) {
          if (error === executionAuthorityFailure || isFlowExecutionAuthorityError(error)) throw error;
          const errorMessage = `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
          emit?.({ type: 'tool:result', toolCallId: id, name, result: errorMessage, isError: true });
          const wasCancelled =
            signal?.aborted
            || input.shouldAbort?.()
            || /\bcancel(?:led|ed|ation)\b/i.test(errorMessage);
          const uiLink = decodedForUi
            ? await ModelHandler.resolveToolUiLink(
                decodedForUi.server,
                decodedForUi.tool,
                undefined,
                decodedForUi.uiResourceUri,
                invocationArgsForUi,
              )
            : undefined;
          // Add error message for this specific tool call with timestamp and ID
          toolCallMessages.push({
            id: uuidv4(), // Generate unique ID
            role: "tool",
            tool_call_id: id,
            content: errorMessage,
            timestamp: Date.now(), // Add timestamp
            ...(uiLink
              ? {
                  ui: {
                    ...uiLink,
                    isError: true,
                    ...(wasCancelled ? { cancelledReason: errorMessage } : {}),
                  },
                }
              : {}),
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
          if (runId) {
            const message = toolCallMessages[0];
            const content = typeof message?.content === 'string' ? message.content : '';
            const cancelled = Boolean(signal?.aborted || input.shouldAbort?.() || /\bcancel(?:led|ed|ation)\b/i.test(content));
            const failed = Boolean(message?.ui?.isError || /^Error:/i.test(content));
            const kind = name.startsWith('handoff_to_') || name === 'handoff'
              ? 'handoff' as const
              : isRunResourceToolName(name) || isMCPResourceToolName(name)
                ? 'resource' as const
                : isQuestionToolName(name) || isTodoToolName(name) || isPersonaToolName(name) || isMeetingToolName(name) || isSubflowToolName(name) || isBehaviorToolName(name)
                  ? 'synthetic' as const
                  : decodedForUi
                    ? 'mcp' as const
                    : 'unknown' as const;
            recordStatisticsEvent(createStatisticsEvent({
              type: 'tool.invocation',
              runId,
              node: node ? { id: node.nodeId, name: node.nodeName } : undefined,
              tool: { id: decodedForUi?.tool ?? name, name, kind },
              provider: decodedForUi ? { id: decodedForUi.server } : undefined,
              invocationId: toolInvocationId,
              outcome: cancelled ? 'cancelled' : failed ? 'error' : 'completed',
              durationMs: Math.max(0, Date.now() - toolStartedAt),
              phases: { tool: Math.max(0, Date.now() - toolStartedAt) },
              // Metadata ONLY: byte/character counts and a normalized shape
              // category. Arguments and results themselves are never recorded.
              payload: statisticsPayloadMetadata(argsString, content),
              errorClass: failed ? classifyStatisticsError(cancelled ? { type: 'cancelled' } : { type: 'tool' }) : undefined,
            }));
          }
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

      log.debug('Tool-call batch completed', {
        requested: toolCalls.length,
        completed: result.value.toolCallMessages.length,
      });

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

      log.warn('Tool-call batch failed', {
        errorClass: classifyStatisticsError(error),
      });

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
