import { isConversationDurabilityError, isConversationDurabilityCode } from '@/backend/execution/flow/conversationPublicationError';
import { getConversationStates } from '../conversationStateRegistry';
import { isCancelledByAncestry } from '../cancellation';
import { traceSpan } from '../turnTrace';
import { reserveArchiveSnapshot, estimateArchiveSnapshotBytes,
  ModelTurnArchiveMemoryError, type ArchiveMemoryReservation } from '../modelTurnArchiveWriteBudget';
import { createLogger } from '@/utils/logger';
import { getHarnessExecution } from '@/backend/services/harness/executionScope';
import { createHash, randomUUID } from 'node:crypto';
import { assertExecutionExtensionCurrent, executionExtensionCodexProfile, executionExtensionSinglePhysicalAttempt, issueExecutionModelStepContext, ExecutionExtensionError } from '@/backend/execution/extensions';
import { takeSteeringMessages, requeueSteeringMessages, subscribeSteeringMessages, markSteeringDelivered } from '@/backend/execution/flow/steeringInbox';
import {
  ModelCallInput,
  ModelCallResult,
  ToolCallProcessingInput,
  ToolCallProcessingResult
} from '../types/modelHandler';
import { ToolCallInfo } from '../types'; // Import ToolCallInfo
import { FlujoChatMessage } from '@/shared/types/chat'; // Correct import path for FlujoChatMessage
import { Result, ExecutionError } from '../errors';
import { createModelError } from '../errorFactory';
import { decodeToolName } from './toolNamespace';
import { assertNativeBrokerAuthority, createNativeToolPort, nativeDigest, nativeToolInventoryDigest } from './nativeToolBroker';
import { prepareNativeInvocation, submitNativeInvocation, finishNativeInvocation, holdNativeInvocation,
  NativeInvocationHeldError, type NativeInvocationReceipt } from './nativeToolJournal';
import { readNativeOriginLineage } from './nativeOriginLineage';
import {
  assertNativeInvocationSessionHook,
  createNativeInvocationSession,
  type NativeInvocationSessionPayload,
} from './nativeInvocationSession';
import { readNativeSessionPayload, saveNativeSessionPayload } from './nativeSessionPayload';
import { assertNativeArchiveFormat, readSavedNativeOrigin, saveNativeSessionOrigin } from './nativeSavedOrigin';
import {
  assertNativeOriginalProcessHost,
  assertNativeOriginalExecutionContext,
  createProcessNativeOriginalHost,
} from './nativeOriginalHost';
import { NATIVE_HANDOFF_PROTOCOL, CODEX_NATIVE_HANDOFF_PROTOCOL } from './nativeHandoffProtocol';
import { stripHandoffPlumbing, toApiMessages } from '../buildNodeContext';
import { compactForWire, couldCompact } from './compactForWire';
import {
  emergencyRefitMessages,
  EMERGENCY_CONTEXT_REFIT_MARKER,
} from './emergencyContextRefit';
import {
  cloneModelInputSnapshot,
  markModelInputMessages,
  recordContextCompaction,
} from './modelInputCompaction';
import OpenAI from 'openai';
import { modelService } from '@/backend/services/model';
import { assertCatalogAdmissionCurrent, assertModelCatalogLeaseOwned, withModelCatalogLease, type ModelCatalogAdmission } from '@/backend/services/model/catalogAdmission';
import {
  hydrateRunResourceMedia,
  materializeRunResourceMediaPaths,
} from '@/backend/services/model/mediaHandoff';
import { adaptMediaInputsForModel } from '@/backend/services/chatAttachments/modelInput';
import { resolveEffectiveMaxTurns } from './maxTurns';
import { resolveEffectiveMaxTokens } from './maxTokens';
import { imageTokens } from './wireTokenEstimate';
import { prepareImageInput } from './prepareImageInput';
import { resolveEffectiveVisualCompaction } from './resolveEffectiveCompaction';
import { compactMessagesVisually, type EffectiveVisualCompaction } from './visualCompaction';
import { COMPACTION_SUMMARY_MARKER } from './summarizingCompaction';
import { withExactSourceRecall } from '../compaction/exactSourceRecall';
import { isOwnerCredentialBoundModel, normalizeMaxTokens, validateOwnerCredentialBinding, type Model } from '@/shared/types/model';
import { isSelfOrchestratingAdapter, normalizeModelTemperature, resolveModelAdapter, supportsLocalModelAuth, type ModelAdapter, type ModelProvider } from '@/shared/types/model/provider';
import {
  CODEX_EMERGENCY_COMPACTION_MARKER,
  CodexInputLimitError,
  refitCodexMessagesForInputLimit,
} from '@/backend/services/model/adapters/codexInputCompaction';
import { getCompletionAdapter } from '@/backend/services/model/adapters';
import { archiveContextForRefit } from './archiveContextForRefit';
import { mapOpenAiUsage, OpenAiUsageLike } from '@/backend/services/model/adapters/openaiUsage';
import { prepareOpenAiPromptCacheWire } from '@/backend/services/model/adapters/openaiPromptCaching';
import { fingerprintPrefix, classifyDrift, logCacheOutcome, derivePromptCacheKey } from './promptCacheMetrics';
import { trimTools } from './trimToolBlock';
import { mcpService } from '@/backend/services/mcp';
import { registerToolCall, releaseToolCall } from '../toolCancelRegistry';
import {
  MAX_AUTOMATIC_MODEL_RETRIES,
  planAutomaticRetry,
  waitForRetryWindow,
} from '../retryAfter';
import { getCurrentWorkspace, runWithWorkspace } from '@/utils/workspace';
import {
  writeRunResource,
  listRunResources,
} from '@/backend/services/runResources';
import { executeRunResourceTool, nativeRunResourceResult, READ_RESOURCE_TOOL_NAME } from './runResourceTools';
import { withSubflowOutputConsumption } from '../subflowOutputBudget';
import type { ModelSteering, ModelStreamDelta, ModelToolProgress, SdkRequestSnapshot } from '@/backend/services/model/adapters/types';
import type { ModelMediaPart } from '@/shared/types/model/media';
import { requireFunctionToolCalls } from '@/shared/types/openai';
import {
  extractAssistantMedia,
  parseDataUrl,
} from '@/backend/services/model/adapters/messageUtils';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import {
  archiveModelDispatch,
  preparePagedCanonicalArchive,
  readNativeModelTurnSnapshot,
  updateModelDispatchOutcome,
} from '@/backend/execution/flow/modelTurnArchive';
import { flushConversationLog } from '@/backend/execution/flow/conversationLog';
import {
  assertFlowExecutionCurrent,
  commitFlowDurableMutation,
  isFlowExecutionAuthorityError,
  rethrowFlowExecutionAuthorityError,
  type FlowDurableMutationContext,
} from '@/backend/execution/flow/executionAuthority';
import { createLiveToolApproval, requireApprovalOf } from '@/backend/execution/flow/toolApprovalGate';
import { upsertMessageById } from '@/backend/execution/flow/conversationMessages';
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
} from '@/backend/services/statistics/metadata';
import { persistModelMedia, type GeneratedImagePart } from './modelMedia';
import { processToolCallsAdmitted, resolveToolUiLink } from './toolCallProcessing';
import { getCompactionGlobalSettings, historyKeepRecentMessages, isAutoUnloadOllamaEnabled, isExperimentalFlagEnabled, toolDescriptionCap } from './modelHandlerSettings';
import { isStreamedAssistantProse, persistStreamedMessage, removeFailedStreamedAssistantProse } from './streamedAssistantMessages';
import { buildRunResourceMarkers, captureOversizedToolResultsForRefit, ensureReadResourceArmed, estimateOutgoingInputTokens, isContextOverflowError, OVERFLOW_TOOL_RESULT_HEAD_CHARS, resolveOutgoingInputBudget } from './contextWindowFit';
import { extractProviderErrorDetails, shapeCompletionError } from './providerErrorShape';
import type { GenerateCompletionOptions } from './modelCompletionContract';
import { compactWireProjection } from './wireCompaction';
import { buildSelfOrchestratedToolExecutors } from './selfOrchestratedToolExecutors';

export { extractGeneratedImageParts } from './modelMedia';

const EMPTY_STOP_COMPLETION_REASON = 'empty_stop_completion';
const EMPTY_LENGTH_COMPLETION_REASON = 'empty_length_completion';
const EMPTY_STOP_RETRIES_BEFORE_SYNTHETIC_MESSAGE = 5;
const EMPTY_STOP_TEMPERATURE_RETRY = 3;
const EMPTY_STOP_RETRY_TEMPERATURE = 1 as const;
const EMPTY_STOP_SYNTHETIC_USER_MESSAGE =
  'Your previous response was empty. Please provide a complete response or make the appropriate tool call.';

function isEmptyStoppedCompletionError(error: ExecutionError): boolean {
  return error.type === 'model'
    && error.code === 'api_error'
    && (error.details?.reason === EMPTY_STOP_COMPLETION_REASON || error.details?.reason === EMPTY_LENGTH_COMPLETION_REASON);
}

const log = createLogger('backend/flow/execution/handlers/ModelHandler'
  // , LOG_LEVEL.VERBOSE // override for the current file
);

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

type WireCompactionArgs = Parameters<typeof compactWireProjection> extends [unknown, ...infer Rest] ? Rest : never;

export class ModelHandler {
  /** MCP Apps (#97): the `ui://` resource a tool links to. See resolveToolUiLink in toolCallProcessing.ts. */
  static async resolveToolUiLink(
    serverName: string,
    toolName: string,
    resultData: unknown,
    advertisedUri?: string,
    invocationArgs?: Record<string, unknown>,
  ): ReturnType<typeof resolveToolUiLink> {
    return resolveToolUiLink(serverName, toolName, resultData, advertisedUri, invocationArgs);
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
      return isCancelledByAncestry(conversationId, getConversationStates());
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
    return isExperimentalFlagEnabled('claudeSessionResume');
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
   * One reply to one question, with no tools, no history and no record in the
   * conversation, for a model that judges something on the side. A strict reply format
   * goes only to adapters that can hold to one.
   */
  static async askOnce(
    admission: ModelCatalogAdmission,
    input: {
      system: string;
      user: string;
      outputSchema?: Record<string, unknown>;
      maxTokens?: number;
      shouldAbort?: () => boolean;
      onModelRouted?: (modelId: string) => void;
      durableContext?: FlowDurableMutationContext;
    },
  ): Promise<Result<ModelCallResult>> {
    const { model } = admission;
    const supportsSchema = model.adapter === 'codex-cli'
      || ((!model.adapter || model.adapter === 'openai' || model.adapter === 'openai-responses')
        && !!model.supportedParameters?.includes('structured_outputs'));
    const callMessages: FlujoChatMessage[] = [
      { id: uuidv4(), role: 'system', content: input.system, timestamp: Date.now() } as FlujoChatMessage,
      { id: uuidv4(), role: 'user', content: input.user, timestamp: Date.now() } as FlujoChatMessage,
    ];
    return ModelHandler.generateCompletion(model.id, '', callMessages, undefined, {
      modelCatalogAdmission: admission,
      maxTokens: input.maxTokens,
      temperatureOverride: 0,
      ...(supportsSchema && input.outputSchema ? { outputSchema: input.outputSchema } : {}),
      shouldAbort: input.shouldAbort,
      onModelRouted: input.onModelRouted,
      beforeModelDispatch: input.durableContext?.executionAuthority?.assertCurrent,
      durableContext: input.durableContext,
    });
  }

  /** Summarizing compaction of the provider wire. See wireCompaction.ts. */
  private static maybeCompactWire(
    ...args: WireCompactionArgs
  ): ReturnType<typeof compactWireProjection> {
    return compactWireProjection({
      generateCompletion: (...completion) => ModelHandler.generateCompletion(...completion),
      isConversationCancelled: conversationId => ModelHandler.isConversationCancelled(conversationId),
    }, ...args);
  }

  /**
   * Call model with tool support - performs a SINGLE API call.
   * Does NOT handle tool execution loops internally.
   */
  static async callModel(input: ModelCallInput): Promise<Result<ModelCallResult>> {
    return traceSpan('model.callModel', () => withSubflowOutputConsumption(() => this.callModelAdmitted(input)));
  }

  private static async callModelAdmitted(input: ModelCallInput): Promise<Result<ModelCallResult>> {
    if (input.modelCatalogAdmission && input.modelCatalogAdmission.model.id !== input.modelId) {
      throw new ExecutionExtensionError('execution_model_binding_changed');
    }
    if (!input.modelCatalogAdmission) return this.callModelCore(input);
    try {
      return await withModelCatalogLease(async () => {
        await assertCatalogAdmissionCurrent(input.modelCatalogAdmission!);
        return this.callModelCore(input);
      });
    } catch (error) {
      return shapeCompletionError(error, input.modelId, false);
    }
  }

  private static async callModelCore(input: ModelCallInput): Promise<Result<ModelCallResult>> {
    // Remove iteration parameters as they are no longer handled here
    const { modelId, prompt, messages, wireMessages, tools, nodeName, nodeId, toolNameMap, maxTurns, maxTokens, compactionMode, compactionKeepTokens, onFinalWire, conversationId, runId, codexSession, onCodexSessionChange, requireToolApproval, mcpNodes } = input; // Added nodeId
    const durableContext: FlowDurableMutationContext = {
      executionAuthority: input.executionAuthority,
      executionExtensionContext: input.executionExtensionContext,
      personaAttribution: input.personaAttribution,
    };

    // Fetch model information for display name (and the model's own maxTurns / maxTokens caps)
    let modelDisplayName = '';
    let modelTechnicalName = '';
    let modelMaxTurns: number | undefined;
    let modelMaxTokens: number | undefined;
    let modelIsFallbackPolicy = false;
    let modelAdapter: ModelAdapter | undefined;
    let modelContextWindow: number | undefined;
    let modelCompactionThreshold: number | undefined;
    let modelCompactionThresholdPercent: number | undefined;
    let modelCompactionProvider: ModelProvider | undefined;
    let modelSummaryParameters: string[] | undefined;
    const nodeDisplayName = nodeName;
    try {
      const model = input.modelCatalogAdmission?.model ?? await modelService.getModel(modelId);
      if (model) {
        modelDisplayName = model.displayName || model.name;
        modelTechnicalName = model.name;
        modelMaxTurns = model.maxTurns;
        modelMaxTokens = model.maxTokens;
        modelIsFallbackPolicy = Boolean(model.fallbackPolicy);
        modelAdapter = resolveModelAdapter(model.provider, model.adapter);
        modelContextWindow = model.contextWindow;
        modelCompactionThreshold = model.compactionThreshold;
        modelCompactionThresholdPercent = model.compactionThresholdPercent;
        modelCompactionProvider = model.provider;
        // These routes already have intrinsic structured-summary support. Keep
        // their persisted projection identity stable when refreshing metadata.
        modelSummaryParameters = model.adapter === 'codex-cli' || (model.provider === 'openrouter' && model.name === 'openrouter/free')
          ? undefined : model.supportedParameters;
      }
    } catch (error) {
      log.warn(`Failed to fetch model information for prefix: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!input.nativeOriginalHost && (input.personaAttribution || input.executionExtensionContext)) {
      input = { ...input, nativeOriginalHost: await createProcessNativeOriginalHost({ authority: input.executionAuthority,
        context: input.executionExtensionContext,
        conversationId, runId, nodeId, modelId, personaAttribution: input.personaAttribution }) };
    }
    if (input.nativeOriginalHost) {
      assertNativeOriginalProcessHost(input.nativeOriginalHost.process);
      assertNativeOriginalExecutionContext(input.nativeOriginalHost.process, input.executionExtensionContext);
      input = { ...input, nativeBrokerAuthority: input.nativeOriginalHost.broker,
        nativeInvocationSessionHook: input.nativeOriginalHost.session };
    }
    if (input.nativeBrokerAuthority) {
      assertNativeBrokerAuthority(input.nativeBrokerAuthority);
      if (!conversationId || !runId || !nodeId || input.executionExtensionContext && !input.nativeOriginalHost
        || modelIsFallbackPolicy || (modelAdapter !== 'codex-cli' && modelAdapter !== 'claude-cli')) {
        throw new Error('Native broker requires an owned native model run and a matching private host, without fallback.');
      }
    }
    if (input.nativeInvocationSessionHook) {
      assertNativeInvocationSessionHook(input.nativeInvocationSessionHook);
      if (!input.nativeBrokerAuthority) throw new Error('Native session publication requires broker authority.');
    }

    // Native session reuse is safe only for FULL-HISTORY nodes (a scoped
    // `wireMessages` view can't be reconciled against a persisted message-count
    // watermark). Codex and Antigravity enable it by default; Claude
    // subscription keeps its existing experimental setting. Ineligible adapters
    // always re-flatten.
    const sessionResume =
      !input.nativeBrokerAuthority &&
      (modelAdapter !== 'claude-cli' || !input.executionExtensionContext) &&
      !wireMessages &&
      (modelAdapter === 'codex-cli' || modelAdapter === 'antigravity-cli' ||
        (modelAdapter === 'claude-cli' && await ModelHandler.isClaudeSessionResumeEnabled()));

    // Resolve the effective agentic-turn cap. Precedence: per-node override →
    // bound-model setting → system default (50). This replaces the former
    // hard-coded 30 that ProcessNode passed straight through as maxTurns and
    // caused long agentic runs (Claude subscription) to abort mid-execution (#48).
    const effectiveMaxTurns = resolveEffectiveMaxTurns(maxTurns, modelMaxTurns);

    // Resolve the effective per-completion output-token cap (#189). Precedence:
    // per-node override → bound-model maxTokens → adapter default. `undefined`
    // here means "let the adapter decide" (there is no numeric system default).
    const effectiveMaxTokens = resolveEffectiveMaxTokens(maxTokens, modelMaxTokens, modelContextWindow);

    log.info(`callModel - Single execution`, {
      modelId,
      messagesCount: messages.length,
      toolsCount: tools?.length || 0,
      nodeName,
      nodeId // Log nodeId
    });

    // One emit function bound to this conversation, for the live transcript sink below.
    const emit = conversationId ? executionEventBus.emitterFor(conversationId) : undefined;

    const stepApprovalTools = Object.values(toolNameMap ?? {}).filter((tool) => tool.requiresApproval);
    // Adapters that run their own tool loop may name a tool differently, for example
    // `server__tool`. A name that cannot be matched exactly falls back to a substring
    // test, which can only ask a person too often, never too rarely.
    const stepRequiresApproval = (name: string): boolean => {
      const exact = toolNameMap && Object.hasOwn(toolNameMap, name) ? toolNameMap[name] : undefined;
      if (exact) return exact.requiresApproval === true;
      return stepApprovalTools.some((tool) => name.includes(tool.tool));
    };

    // Self-orchestrating adapters (agent SDKs) own the tool loop, so they ask
    // through FLUJO's one gate and wait for the answer on the conversation's
    // approval card. A sub-flow asks in the conversation the person is viewing.
    const requestToolApproval = createLiveToolApproval({
      conversationId: input.approvalConversationId ?? conversationId,
      requireApproval: requireApprovalOf(requireToolApproval),
      stepRequiresApproval: stepApprovalTools.length > 0 ? stepRequiresApproval : undefined,
      onApprovalRequired: input.onApprovalRequired,
      signal: input.signal ?? input.executionAuthority?.signal,
    });

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
            if (conversationId) persistStreamedMessage(conversationId, withNode);
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
    // drain while they are active. Claim a batch, persist it before sending,
    // then acknowledge acceptance or return it to the inbox on rejection.
    const steeringWorkspace = getCurrentWorkspace();
    const steering: ModelSteering | undefined = conversationId &&
      isSelfOrchestratingAdapter(modelAdapter)
      ? {
        take: () => runWithWorkspace(steeringWorkspace, async () => {
          await assertFlowExecutionCurrent(durableContext);
          await input.executionAuthority?.pollRelatedInputs?.();
          const pending = takeSteeringMessages(conversationId);
          if (!pending.length) return undefined;
          for (const message of pending) {
            if (!message.processNodeId && nodeId) message.processNodeId = nodeId;
          }
          let accepted = false;
          let returned = false;
          return {
            messages: pending,
            beforeSend: () => runWithWorkspace(steeringWorkspace, async () => {
              await flushLiveProjection();
              await assertFlowExecutionCurrent(durableContext);
            }),
            acknowledge: () => runWithWorkspace(steeringWorkspace, async () => {
              accepted = true;
              await flushLiveProjection();
              await assertFlowExecutionCurrent(durableContext);
              const ids = pending.map(message => message.id).filter(Boolean);
              markSteeringDelivered(conversationId, ids);
              if (ids.length) await input.executionAuthority?.acknowledgeRelatedInputs?.(ids);
            }),
            requeue: () => runWithWorkspace(steeringWorkspace, () => {
              if (accepted || returned) return;
              returned = true;
              requeueSteeringMessages(conversationId, pending);
            }),
          };
        }),
        subscribe: listener => runWithWorkspace(steeringWorkspace, () =>
          subscribeSteeringMessages(conversationId, listener)),
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

    const { localToolExecutors, shouldEndAgenticTurn } = buildSelfOrchestratedToolExecutors({
      input, tools, conversationId, runId, nodeId, nodeDisplayName, toolNameMap, mcpNodes,
      emit, durableContext, modelContextWindow, requestToolApproval,
    });

    // Resource-aware truncation markers (issue #168): build a lookup of captured
    // run resources for oversized PRIOR tool results/args, keyed by the producing
    // tool_call_id, so the Claude-subscription adapter can emit a head excerpt +
    // a dereferenceable flujo://run/... marker instead of a plain `…[truncated]`.
    // Built once here (cheap — the store index is cached) and passed to the
    // adapter; request/response adapters ignore it.
    const runResourceMarkers = conversationId
      ? await buildRunResourceMarkers(conversationId)
      : undefined;

    // Summarization is applied after ProcessNode's node/output/input projection
    // and handoff filtering. The result exists only on the provider wire; the
    // canonical `messages` array remains the base for returned/persisted output.
    const projectedMessages = stripHandoffPlumbing(wireMessages ?? messages);
    const compaction = input.executionExtensionContext ? undefined : await ModelHandler.maybeCompactWire(
      projectedMessages,
      conversationId,
      nodeId,
      wireMessages ? 'node-projected' : 'full-history',
      { id: modelId, name: modelTechnicalName, provider: modelCompactionProvider, adapter: modelAdapter, contextWindow: modelContextWindow,
        compactionThreshold: modelCompactionThreshold, compactionThresholdPercent: modelCompactionThresholdPercent,
        supportedParameters: modelSummaryParameters },
      effectiveMaxTokens,
      { compactionMode, compactionKeepTokens },
      durableContext,
      tools,
      input.modelCatalogAdmission,
      shouldAbort,
    );
    const effectiveMessages = compaction ? withExactSourceRecall({
      source: projectedMessages, wire: compaction.wireMessages,
      sourceEndId: compaction.artifact.sourceEndId, resourceUri: compaction.artifact.summaryResourceUri,
      inputBudget: resolveOutgoingInputBudget(modelContextWindow, effectiveMaxTokens) ?? 96_000,
    }) : projectedMessages;
    const effectiveModelInput = cloneModelInputSnapshot(input.modelInputForArchive);
    if (compaction) {
      markModelInputMessages(
        effectiveModelInput,
        compaction.summarizedMessageIds,
        'summarized',
        'Replaced on the provider wire by the injected FLUJO conversation summary.',
      );
      recordContextCompaction(effectiveModelInput, {
        kind: 'summary',
        reason: 'Opt-in AI summarization ran before provider dispatch.',
        before: compaction.artifact.sourceMessageCount,
        after: 1,
        unit: 'messages',
        omittedMessages: compaction.artifact.sourceMessageCount,
        injectedMarker: COMPACTION_SUMMARY_MARKER,
      });
    }

    // Call generateCompletion once with the materialized provider projection.
    const response = await this.generateCompletion(modelId, prompt, effectiveMessages, tools, {
      modelCatalogAdmission: input.modelCatalogAdmission,
      nativeBrokerAuthority: input.nativeBrokerAuthority,
      nativeInvocationSessionHook: input.nativeInvocationSessionHook,
      nativeOriginalProcessHost: input.nativeOriginalHost?.process,
      toolNameMap,
      maxTurns: modelIsFallbackPolicy && !normalizeMaxTokens(maxTurns) ? undefined : effectiveMaxTurns,
      maxTokens: effectiveMaxTokens,
      temperatureOverride: input.temperatureOverride,
      requestToolApproval,
      onTranscriptMessage,
      steering,
      onModelDelta,
      onToolProgress,
      shouldAbort,
      conversationId,
      runId,
      nodeId,
      takeModelStepOrdinal: input.takeModelStepOrdinal,
      codexSession,
      onCodexSessionChange,
      responsesSession: input.responsesSession,
      onResponsesSessionChange: input.onResponsesSessionChange,
      localToolExecutors,
      shouldEndAgenticTurn,
      runResourceMarkers,
      sessionResume,
      systemPromptPolicy: input.systemPromptPolicy,
      onSessionEvent: event => {
        if (!acceptLiveProjection || (event.kind !== 'accounting' && shouldAbort?.())) return;
        enqueueLiveProjection(async () => {
          await input.executionAuthority?.assertCurrent();
          emit?.({ type: 'model:status', node: { nodeId, nodeName }, ...event });
        });
      },
      onFinalWire,
      archiveModelTurns: input.archiveModelTurns,
      canonicalMessages: messages,
      modelInputForArchive: effectiveModelInput,
      wireMessageIds: effectiveMessages.map(message => message.id),
      nodeName,
      beforeToolDispatch: input.beforeToolDispatch,
      executionExtensionContext: input.executionExtensionContext,
      authorizePersonaCoreMcp: input.executionAuthority?.authorizePersonaCoreMcp,
      onModelRouted: input.onModelRouted,
      beforeModelDispatch: input.beforeModelDispatch ?? (() => assertFlowExecutionCurrent(durableContext)),
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
    }).catch(async error => {
      try { await finishLiveProjection(); }
      catch (cleanupError) { log.warn('Failed to drain live projection after a model failure', { cleanupError }); }
      throw error;
    });

    try { await finishLiveProjection(); }
    catch (error) {
      if (response.success) throw error;
      log.warn('Live projection failed while retaining the primary model failure', { error });
    }

    // Provider abort is cooperative and SDK callbacks can resolve after a lease
    // or meeting generation was replaced.  No returned media/message/resource
    // projection may observe that stale result.
    if (response.success) await assertFlowExecutionCurrent(durableContext);

    if (!response.success) {
      for (const messageId of liveMessageIds) {
        try { emit?.({ type: 'model:end', messageId, discard: true, node: nodeId ? { nodeId } : undefined }); }
        catch (error) { log.warn('Failed to publish failed-model cleanup', { error }); }
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
    const usageReport = usage ? { usage } : { usageNotReported: true as const };

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
    // A reply that reached the output limit is still a reply: keep it and tell
    // the user it was cut off, the same way for every adapter.
    const cutOff = modelResponse.fullResponse?.choices?.[0]?.finish_reason === 'length'
      ? { cutOff: 'length' as const } : {};

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
          ...(isLast ? usageReport : {}),
          ...(isLast && modelResponse.contextUsage !== undefined ? { contextUsage: modelResponse.contextUsage } : {}),
          ...(isLast && msg.role === 'assistant' ? cutOff : {}),
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
        ...(modelResponse.providerMetadata ? { providerMetadata: modelResponse.providerMetadata } : {}),
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
        ...usageReport,
        ...(modelResponse.contextUsage !== undefined ? { contextUsage: modelResponse.contextUsage } : {}),
        ...cutOff,
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
    ...args: Parameters<typeof ModelHandler.generateCompletionCore>
  ): Promise<Result<ModelCallResult>> {
    const admission = args[4]?.modelCatalogAdmission;
    if (!admission) return traceSpan('model.generate', () => this.generateCompletionCore(...args));
    try {
      if (admission.model.id !== args[0]) {
        throw new ExecutionExtensionError('execution_model_binding_changed');
      }
      return await withModelCatalogLease(async () => {
        await assertCatalogAdmissionCurrent(admission);
        return traceSpan('model.generate', () => this.generateCompletionCore(...args));
      });
    } catch (error) {
      return shapeCompletionError(error, args[0], false);
    }
  }

  private static async generateCompletionCore(
    modelId: string,
    prompt: string,
    messages: FlujoChatMessage[], // Expect FlujoChatMessage
    tools?: OpenAI.ChatCompletionFunctionTool[],
    opts?: GenerateCompletionOptions,
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
    // Use the same global, workspace-scoped registry that Stop wakes directly.
    // The polling guard remains for ancestry and non-conversation callers.
    const completionScope = opts?.conversationId ?? opts?.runId;
    const completionCallId = `model-${randomUUID()}`;
    const abortController = completionScope
      ? registerToolCall(completionScope, completionCallId) : new AbortController();
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
    let singlePhysicalAttempt = false;
    let archiveSnapshotReservation: ArchiveMemoryReservation | undefined;

    try {
      if (opts?.executionExtensionContext) {
        await assertExecutionExtensionCurrent(opts.executionExtensionContext);
      }
      if (opts?.nativeOriginalProcessHost) {
        assertNativeOriginalExecutionContext(opts.nativeOriginalProcessHost, opts.executionExtensionContext);
      }
      // Get the model
      const model = opts?.modelCatalogAdmission?.model ?? await modelService.getModel(modelId);
      await assertFlowExecutionCurrent(opts?.durableContext ?? {});
      // Native adapters require a trusted, verified restriction profile. Claude
      // and Antigravity remain excluded from authenticated private execution.
      if (opts?.executionExtensionContext) {
        const restrictedAdapter = resolveModelAdapter(model?.provider, model?.adapter);
        if (restrictedAdapter === 'claude-cli' || restrictedAdapter === 'antigravity-cli' || (restrictedAdapter === 'codex-cli' && !opts.nativeOriginalProcessHost
          && !await executionExtensionCodexProfile(opts.executionExtensionContext))) {
          throw new ExecutionExtensionError('execution_model_adapter_forbidden');
        }
      }
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
      if (opts?.nativeBrokerAuthority) {
        assertNativeBrokerAuthority(opts.nativeBrokerAuthority);
        if (!opts.conversationId || !opts.runId || !opts.nodeId || opts.executionExtensionContext && !opts.nativeOriginalProcessHost
          || model.fallbackPolicy || (model.adapter !== 'codex-cli' && model.adapter !== 'claude-cli')) {
          throw new Error('Native broker requires a fully owned native model attempt.');
        }
      }
      if (opts?.nativeInvocationSessionHook) {
        assertNativeInvocationSessionHook(opts.nativeInvocationSessionHook);
        if (!opts.nativeBrokerAuthority) throw new Error('Native session publication requires broker authority.');
      }

      const ownerBound = isOwnerCredentialBoundModel(model);
      if (ownerBound && validateOwnerCredentialBinding(model)) {
        throw new ExecutionExtensionError('owner_credential_binding_invalid');
      }
      if (ownerBound && !opts?.executionExtensionContext) {
        throw new ExecutionExtensionError('execution_model_step_context_required');
      }
      if (model.fallbackPolicy && opts?.executionExtensionContext) {
        throw new ExecutionExtensionError('execution_model_fallback_forbidden');
      }
      // The parent run context covers tools and durable state. Every bound
      // provider call gets a separate owner-issued child that can dispatch once.
      if (ownerBound && (!opts?.nodeId || typeof opts.takeModelStepOrdinal !== 'function')) {
        throw new ExecutionExtensionError('execution_model_step_slot_required');
      }
      const modelStepContext = ownerBound
        ? await issueExecutionModelStepContext(opts!.executionExtensionContext!, model, {
          nodeId: opts!.nodeId!, ordinal: opts!.takeModelStepOrdinal!(),
        })
        : opts?.executionExtensionContext;
      singlePhysicalAttempt = await executionExtensionSinglePhysicalAttempt(modelStepContext, model);

      // Extract model settings. Malformed persisted values are omitted so NaN
      // never reaches an adapter; truly unset legacy values retain the old 0.0 default.
      const configuredTemperature = opts?.temperatureOverride ?? model.temperature;
      const temperature = normalizeModelTemperature(
        configuredTemperature,
        model.provider,
        model.adapter,
        model.name,
      ) ?? (configuredTemperature === undefined || configuredTemperature === '' ? 0.0 : undefined);

      // Resolve and decrypt the API key. Local-auth adapters accept an empty
      // key to use the host CLI's supported login; each adapter owns that auth.
      if (opts?.modelCatalogAdmission) await assertModelCatalogLeaseOwned();
      const resolvedKey = ownerBound ? '' : await modelService.resolveAndDecryptApiKey(model.ApiKey);
      const decryptedApiKey = ownerBound ? '' :
        resolvedKey || (model.fallbackPolicy || (supportsLocalModelAuth(resolveModelAdapter(model.provider, model.adapter)) && !model.ApiKey?.trim()) ? '' : null);
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
      const projectedSourceIndexes: Array<number | undefined> = [];
      const projectedMessages = toApiMessages(messagesWithMaterializedMedia,
        resolveModelAdapter(model.provider, model.adapter) === 'gemini', projectedSourceIndexes);
      // Antigravity CLI rejects unsupported attachments explicitly in its preflight.
      // Filtering them here would turn an image request into text before that
      // check and allow a response from a model that never received the image.
      let apiMessages: OpenAI.ChatCompletionMessageParam[] = resolveModelAdapter(model.provider, model.adapter) === 'antigravity-cli'
        ? projectedMessages
        : await adaptMediaInputsForModel(projectedMessages, model);
      let effectiveTools: OpenAI.ChatCompletionFunctionTool[] | undefined = tools;
      const modelInputForArchive = cloneModelInputSnapshot(opts?.modelInputForArchive);
      const inputSourceIds = opts?.wireMessageIds?.length === messagesWithMaterializedMedia.length
        ? opts.wireMessageIds
        : messagesWithMaterializedMedia.map(message => message.id);
      let apiSourceIds: Array<string | undefined> = projectedSourceIndexes.map(index => (
        index === undefined ? undefined : inputSourceIds[index]
      ));

      // Strip trailing assistant message(s) for providers that require the last
      // message to be user/tool role. This is a wire-only mutation — sharedState is
      // not affected. Trailing assistant turns arise from:
      //   1. scopeMessagesForInput (latest-message mode, settled conversation)
      //   2. stripHandoffPlumbing (handoff prose → plain assistant turn)
      //   3. SubflowNode framed-result push
      if (requiresUserLastMessage(model)) {
        while (apiMessages.length > 0 && apiMessages[apiMessages.length - 1].role === 'assistant') {
          apiMessages = apiMessages.slice(0, -1);
          apiSourceIds = apiSourceIds.slice(0, -1);
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
      const compactionGlobals = await getCompactionGlobalSettings();
      const visualConfig: EffectiveVisualCompaction = resolveEffectiveVisualCompaction(compactionGlobals);
      if (opts?.executionExtensionContext) visualConfig.enabled = false;
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
        const candidate = visualDiagnostic.candidate!;
        const archivedIds = apiSourceIds.slice(candidate.startIndex, candidate.endIndex);
        markModelInputMessages(
          modelInputForArchive,
          archivedIds,
          'visually-archived',
          'Replaced on the provider wire by a visual archive manifest and PNG page(s).',
        );
        recordContextCompaction(modelInputForArchive, {
          kind: 'visual-archive',
          reason: 'Old bulky context was replaced by a resource-backed visual archive.',
          before: candidate.messageCount,
          after: 1,
          unit: 'messages',
          omittedMessages: candidate.messageCount,
          injectedMarker: '[Visual context archive]',
        });
        apiSourceIds = [
          ...apiSourceIds.slice(0, candidate.startIndex),
          undefined,
          ...apiSourceIds.slice(candidate.endIndex),
        ];
        if (!opts?.executionExtensionContext) effectiveTools = ensureReadResourceArmed(apiMessages, effectiveTools);
      }

      // Wire-only history compaction for request/response adapters. Agentic loops
      // re-send the whole growing history every turn; a single fat tool result
      // then rides along on every subsequent request and dominates fresh (non-
      // cached) prompt tokens. compactForWire shrinks oversized OLD tool results
      // and old assistant prose while keeping the recent tail verbatim and never
      // dropping a message (tool-pair integrity + prefix-cache stability). It
      // runs for every adapter; self-orchestrating adapters flatten this safer
      // generic wire afterward and still benefit from the bounded content.
      const keepRecentMessages = await historyKeepRecentMessages();
      const codexMayResume = model.adapter === 'codex-cli' && opts?.sessionResume && opts.codexSession;
      if (!codexMayResume && !opts?.executionExtensionContext && couldCompact(apiMessages, { keepRecentMessages })) {
        const beforeLosslessRefit = apiMessages;
        const compactedMessages = compactForWire(apiMessages, {
          keepRecentMessages,
          resourceMarkers: opts?.runResourceMarkers,
          // This caller arms read_resource immediately after shortening, even
          // when this step originally offered no other tools.
          canUseTools: true,
        });
        const changedIndexes = compactedMessages
          .map((message, index) => JSON.stringify(message) === JSON.stringify(beforeLosslessRefit[index]) ? -1 : index)
          .filter(index => index >= 0);
        if (changedIndexes.length > 0) {
          markModelInputMessages(
            modelInputForArchive,
            changedIndexes.map(index => apiSourceIds[index]),
            'content-truncated',
            'Old bulky content was shortened on the provider wire; any resource URI in the marker points to the exact source.',
          );
          recordContextCompaction(modelInputForArchive, {
            kind: 'content-truncation',
            reason: 'Old bulky wire content was shortened before dispatch.',
            before: beforeLosslessRefit.length,
            after: compactedMessages.length,
            unit: 'messages',
            truncatedMessages: changedIndexes.length,
            injectedMarker: '[truncated',
          });
        }
        apiMessages = compactedMessages;
        // Truncation embeds a `flujo://run/...` URI when the full result was
        // captured (issue #168). ProcessNode.prep arms `read_resource` by
        // scanning the PRE-compaction wire, so a URI first surfaced HERE would be
        // undereferenceable. Arm it now if compaction introduced a run-resource
        // reference the offered tools don't yet cover.
        effectiveTools = ensureReadResourceArmed(apiMessages, effectiveTools);
      }

      // Codex Exec has a hard aggregate stdin ceiling independent of a model's
      // advertised token window. Enforce it on the final generic wire so the
      // CLI never receives an oversized turn. This is an adapter-specific cap
      // layered on the provider-neutral context policy below.
      if (model.adapter === 'codex-cli' && !codexMayResume) {
        let codexRefit = refitCodexMessagesForInputLimit(apiMessages, {
          resourceMarkers: opts?.runResourceMarkers,
          keepRecentMessages,
        });
        if (codexRefit.capacityExceeded && opts?.conversationId && !opts.executionExtensionContext) {
          // A recent, uncaptured tool result is recoverable once its exact bytes
          // are persisted. The old transport guard ran before this recovery path.
          const markers = await captureOversizedToolResultsForRefit(
            opts.conversationId, apiMessages, opts.runResourceMarkers, opts.nodeId, opts.durableContext,
          );
          opts.runResourceMarkers = markers;
          // Materialize the URI on the wire too: merely teaching Codex's
          // normalizer about a marker would leave read_resource unarmed.
          const capturedMessages = compactForWire(apiMessages, {
            resourceMarkers: markers, canUseTools: true, compactRecentToolResults: true,
            allowLossyTruncation: false, toolResultHeadChars: OVERFLOW_TOOL_RESULT_HEAD_CHARS,
          });
          markModelInputMessages(modelInputForArchive, capturedMessages.flatMap((message, index) =>
            message === apiMessages[index] ? [] : [apiSourceIds[index]]), 'content-truncated',
          'Oversized tool content was stored exactly and replaced with a resource-backed excerpt before Codex dispatch.');
          apiMessages = capturedMessages;
          effectiveTools = ensureReadResourceArmed(apiMessages, effectiveTools);
          codexRefit = refitCodexMessagesForInputLimit(apiMessages, { resourceMarkers: markers, keepRecentMessages });
        }
        if (codexRefit.capacityExceeded) {
          return { success: false, error: createModelError('context_budget_exceeded',
            new CodexInputLimitError(codexRefit.finalCharacters).message,
            modelId, undefined, { inputCharacters: codexRefit.finalCharacters }) };
        }
        if (codexRefit.compacted && !codexRefit.capacityExceeded) {
          const priorSourceIds = apiSourceIds;
          markModelInputMessages(
            modelInputForArchive,
            codexRefit.omittedMessageIndexes.map(index => priorSourceIds[index]),
            'emergency-stripped',
            'Omitted from the Codex wire to stay below Codex Exec\'s hard input-character limit.',
          );
          markModelInputMessages(
            modelInputForArchive,
            codexRefit.truncatedMessageIndexes.map(index => priorSourceIds[index]),
            'content-truncated',
            'Content was explicitly truncated to stay below Codex Exec\'s hard input-character limit.',
          );
          recordContextCompaction(modelInputForArchive, {
            kind: 'emergency-refit',
            reason: 'Codex Exec hard character-limit preflight.',
            before: codexRefit.originalCharacters,
            after: codexRefit.finalCharacters,
            unit: 'characters',
            omittedMessages: codexRefit.omittedMessageIndexes.length,
            truncatedMessages: codexRefit.truncatedMessageIndexes.length,
            injectedMarker: CODEX_EMERGENCY_COMPACTION_MARKER,
          });
          apiMessages = codexRefit.messages;
          apiSourceIds = codexRefit.sourceMessageIndexes.map(index => (
            index === undefined ? undefined : priorSourceIds[index]
          ));
          effectiveTools = ensureReadResourceArmed(apiMessages, effectiveTools);
          log.warn('Refitted Codex input before the CLI hard character limit', {
            modelId,
            beforeCharacters: codexRefit.originalCharacters,
            afterCharacters: codexRefit.finalCharacters,
            omitted: codexRefit.omitted,
          });
        }
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
        const descriptionMaxChars = await toolDescriptionCap();
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
      const inputBudget = resolveOutgoingInputBudget(
        model.contextWindow,
        opts?.maxTokens
      );
      const hasImages = apiMessages.some(message => Array.isArray(message.content)
        && message.content.some(part => part.type === 'image_url'));
      if (hasImages && !opts?.executionExtensionContext) {
        sanitizedTools = ensureReadResourceArmed([
          ...apiMessages, { role: 'user', content: 'flujo://run/image/original' },
        ], sanitizedTools);
      }
      const prepareImages = async (wire: OpenAI.ChatCompletionMessageParam[], maxImageTokens?: number) => {
        // The CLI owns its text-only attachment rejection. Do not decode an
        // unsupported image before that authoritative preflight can run.
        if (!hasImages || resolveModelAdapter(model.provider, model.adapter) === 'antigravity-cli') return wire;
        const hydrated = await hydrateRunResourceMedia(wire, opts?.nodeId, {
          strictOpenAiAudioFormats: model.adapter === 'openai' || model.adapter === 'openai-responses',
          commitDurableMutation: task => commitFlowDurableMutation(opts?.durableContext ?? {}, task),
        });
        return prepareImageInput(hydrated, {
          inputBudget, tools: sanitizedTools, model, maxImageTokens, shouldAbort: opts?.shouldAbort,
          preserve: async url => {
            if (maxImageTokens !== undefined) return undefined;
            if (opts?.executionExtensionContext || !opts?.conversationId) return undefined;
            const parsed = parseDataUrl(url);
            if (!parsed) return url.startsWith('flujo://run/') ? url : undefined;
            const name = 'original-image-' + createHash('sha256').update(url).digest('hex');
            const existing = (await listRunResources(opts.conversationId)).find(entry => entry.name === name);
            if (existing) return existing.uri;
            const saved = await commitFlowDurableMutation(opts.durableContext ?? {}, () => writeRunResource({
              conversationId: opts.conversationId!, name, mimeType: parsed.mimeType, kind: 'image',
              data: { base64: parsed.base64 }, producedBy: { source: 'image-input', nodeId: opts.nodeId },
            }));
            return 'skipped' in saved ? undefined : saved.uri;
          },
        });
      };
      apiMessages = await prepareImages(apiMessages);
      if (!opts?.executionExtensionContext) sanitizedTools = ensureReadResourceArmed(apiMessages, sanitizedTools);
      // A persisted Codex thread owns its accumulated context and native
      // compaction. Its adapter validates the compatible delta (or full fresh
      // fallback); measuring the entire transcript here rejects valid resumes.
      if (inputBudget !== undefined && !codexMayResume) {
        if (inputBudget === 0) return {
          success: false,
          error: createModelError('context_budget_exceeded',
            'The configured output limit leaves no room for input in the context window. Lower the output-token limit.', modelId),
        };
        let estimatedInputTokens = estimateOutgoingInputTokens(apiMessages, sanitizedTools, model);
        if (estimatedInputTokens > inputBudget) {
          // A constrained private run cannot introduce resource tools or persist
          // model content while recovering from an oversized provider request.
          if (opts?.executionExtensionContext) {
            return {
              success: false,
              error: createModelError('context_budget_exceeded',
                "The private execution request exceeds the model's context budget.", modelId),
            };
          }
          let budgetMarkers = opts?.runResourceMarkers;
          if (opts?.conversationId) {
            budgetMarkers = await captureOversizedToolResultsForRefit(
              opts.conversationId,
              apiMessages,
              budgetMarkers,
              opts?.nodeId,
              opts?.durableContext,
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
            toolResultHeadChars: OVERFLOW_TOOL_RESULT_HEAD_CHARS,
          });
          const refitChangedIndexes = refittedMessages
            .map((message, index) => JSON.stringify(message) === JSON.stringify(apiMessages[index]) ? -1 : index)
            .filter(index => index >= 0);
          if (refitChangedIndexes.length > 0) {
            markModelInputMessages(
              modelInputForArchive,
              refitChangedIndexes.map(index => apiSourceIds[index]),
              'content-truncated',
              'Oversized content was shortened to a resource-backed marker during context-budget preflight.',
            );
            recordContextCompaction(modelInputForArchive, {
              kind: 'content-truncation',
              reason: 'Resource-backed context-budget preflight.',
              before: estimatedInputTokens,
              unit: 'tokens',
              truncatedMessages: refitChangedIndexes.length,
              injectedMarker: '[truncated',
            });
          }
          const refittedTools = ensureReadResourceArmed(refittedMessages, sanitizedTools);
          estimatedInputTokens = estimateOutgoingInputTokens(refittedMessages, refittedTools, model);

          if (estimatedInputTokens <= inputBudget) {
            log.warn('Refitted outgoing model request to its advertised input budget', {
              modelId,
              estimatedInputTokens,
              inputBudget,
            });
            apiMessages = refittedMessages;
            sanitizedTools = refittedTools;
          } else {
            const priorSourceIds = apiSourceIds;
            let emergency = emergencyRefitMessages(refittedMessages, {
              target: inputBudget,
              measure: candidate => estimateOutgoingInputTokens(candidate, refittedTools, model),
              keepRecentMessages,
              resourceMarkers: budgetMarkers,
            });
            let emergencyTools = refittedTools;

            // Shed bulky optional schemas while retaining the resource reader
            // needed to recover every archived observation on this wire.
            if (emergency.after > inputBudget && (emergencyTools?.length ?? 0) > 0) {
              emergencyTools = ensureReadResourceArmed(emergency.messages, undefined);
              emergency = emergencyRefitMessages(refittedMessages, {
                target: inputBudget,
                measure: candidate => estimateOutgoingInputTokens(candidate, emergencyTools, model),
                keepRecentMessages,
                resourceMarkers: budgetMarkers,
              });
            }

            if (emergency.after <= inputBudget) {
              markModelInputMessages(
                modelInputForArchive,
                emergency.omittedMessageIndexes.map(index => priorSourceIds[index]),
                'emergency-stripped',
                'Omitted from the provider wire by FLUJO\'s deterministic context-budget safety refit.',
              );
              markModelInputMessages(
                modelInputForArchive,
                emergency.truncatedMessageIndexes.map(index => priorSourceIds[index]),
                'content-truncated',
                'Content was explicitly truncated by FLUJO\'s deterministic context-budget safety refit.',
              );
              recordContextCompaction(modelInputForArchive, {
                kind: 'emergency-refit',
                reason: emergencyTools
                  ? 'Advertised model context-window preflight.'
                  : 'Advertised model context-window preflight; oversized tool definitions were also withheld for this turn.',
                before: estimatedInputTokens,
                after: emergency.after,
                unit: 'tokens',
                omittedMessages: emergency.omittedMessageIndexes.length,
                truncatedMessages: emergency.truncatedMessageIndexes.length,
                injectedMarker: EMERGENCY_CONTEXT_REFIT_MARKER,
              });
              apiMessages = emergency.messages;
              apiSourceIds = emergency.sourceMessageIndexes.map(index => (
                index === undefined ? undefined : priorSourceIds[index]
              ));
              sanitizedTools = emergencyTools;
              log.warn('Emergency-refitted outgoing request to its advertised input budget', {
                modelId,
                beforeTokens: estimatedInputTokens,
                afterTokens: emergency.after,
                inputBudget,
                omitted: emergency.omitted,
                toolsWithheld: !emergencyTools && Boolean(refittedTools?.length),
              });
            } else {
              return {
                success: false,
                error: createModelError(
                  'context_budget_exceeded',
                  `Your instructions and unrecoverable tool state cannot fit inside the model's ${inputBudget}-token input budget.`,
                  modelId,
                  undefined,
                  { estimatedInputTokens: emergency.after, inputBudget, contextWindow: model.contextWindow }
                )
              };
            }
          }
        }
      }

      // Official OpenAI Chat Completions cache strategy. Process-node calls move
      // their node-specific system instruction behind the wired conversation;
      // GPT-5.6+ additionally retain explicit breakpoints on the latest reusable
      // history boundaries.
      // This happens after every other wire rewrite so the fingerprint,
      // debugger snapshot, and provider all observe the exact same ordering.
      const preCacheMessages = apiMessages;
      const preCacheSourceIds = apiSourceIds;
      const preparedPromptCache = prepareOpenAiPromptCacheWire(apiMessages, model, {
        lateNodeInstruction: Boolean(opts?.nodeId),
      });
      apiMessages = preparedPromptCache.messages;
      if (preparedPromptCache.lateSystem) {
        apiSourceIds = [
          ...preCacheSourceIds.filter((_id, index) => preCacheMessages[index].role !== 'system'),
          ...preCacheSourceIds.filter((_id, index) => preCacheMessages[index].role === 'system'),
        ];
      }
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
        opts?.onFinalWire?.(apiMessages, visualDiagnostic, modelInputForArchive);
      } catch (error) {
        log.warn('Final-wire observer failed; continuing request', { error });
      }

      // Select the completion adapter for this model's provider/SDK. The
      // OpenAI-compatible adapter wraps the original hardened-client path; the
      // native adapters (Anthropic, Gemini, Claude CLI) translate to/from their
      // own APIs but return the same OpenAI-shaped response, so everything below
      // is provider-agnostic.
      const adapter = getCompletionAdapter(model, singlePhysicalAttempt ? 'openai' : undefined);

      log.debug(`calling chatcompletion`)
      log.verbose('calling chatcompletion now with ADAPTER', model.adapter || 'openai')
      log.verbose('calling chatcompletion now with MODEL', model.name)
      log.verbose('calling chatcompletion now with TEMP', temperature)

      // --- Prepare the exact request being sent ---
      log.debug('[ModelHandler.generateCompletion] Sending request via adapter', { adapter: model.adapter || 'openai', model: model.name });

      // --- Auto-unload Ollama: resolve setting and root URL once, before the
      // attempt closure captures them.  The lock is per root URL so parallel
      // fan-out lanes that target DIFFERENT servers are not serialised. ---
      const autoUnloadOllama = (!ownerBound && model.provider === 'ollama' && Boolean(model.baseUrl))
        ? await isAutoUnloadOllamaEnabled()
        : false;
      const ollamaRootForUnload = autoUnloadOllama && model.baseUrl
        ? normaliseOllamaRoot(model.baseUrl)
        : null;
      let opaqueCredentialId = await credentialFingerprint(decryptedApiKey).catch(() => undefined);
      let routingModel = model;
      let providerAttemptOrdinal = 0;
      // One LOGICAL provider call; every retry below reuses this invocation id
      // and gets its own attempt id, so retries never look like separate calls.
      const providerInvocationId = newStatisticsInvocationId();
      let sdkDispatchOrdinal = 0;
      // Self-orchestrating adapters can make several SDK requests inside one
      // completion. Track streamed transcript/steering messages so each later
      // dispatch archive captures the canonical conversation as it existed at
      // that exact request boundary, not the call's initial static array.
      const canonicalSource = opts?.canonicalMessages ?? messages;
      const pagedCanonical = opts?.archiveModelTurns && opts.conversationId
        && (canonicalSource.length > 1000 || estimateArchiveSnapshotBytes(canonicalSource) > 8 * 1024 * 1024)
        ? await preparePagedCanonicalArchive(opts.conversationId, canonicalSource, opts.durableContext,
          // Same opt-in as the dispatch archive below: page preparation of one
          // large history must wait for concurrent writes rather than refuse.
          !opts.nativeBrokerAuthority ? { wait: true, signal: abortController.signal } : undefined)
        : undefined;
      if (opts?.archiveModelTurns) {
        archiveSnapshotReservation = reserveArchiveSnapshot(pagedCanonical ? [] : canonicalSource);
      }
      const archiveCanonicalMessages = opts?.archiveModelTurns
        ? pagedCanonical ? [] : structuredClone(canonicalSource)
        : undefined;
      const archivedMessageBytes = new Map(archiveCanonicalMessages?.map(message => [message.id, estimateArchiveSnapshotBytes(message)]));
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
            ?? (routingModel.contextWindow ? { contextWindow: routingModel.contextWindow } : undefined);
          recordStatisticsEvent(createStatisticsEvent({
            type: 'model.attempt',
            runId: opts.runId,
            node: opts.nodeId ? { id: opts.nodeId } : undefined,
            model: { id: routingModel.id, name: routingModel.displayName || routingModel.name },
            provider: {
              id: routingModel.provider || routingModel.adapter || 'unknown',
              name: routingModel.adapter || routingModel.provider,
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
      let disableReasoningForRecovery = false;
      const attempt = async (
        attemptMessages: OpenAI.ChatCompletionMessageParam[],
        attemptTools: OpenAI.ChatCompletionFunctionTool[] | undefined,
        attemptTemperature = temperature,
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
        let nativeReceipt: NativeInvocationReceipt | undefined;
        let nativeSession: ReturnType<typeof createNativeInvocationSession> | undefined;
        let nativeTerminal = false;
        let nativeSdkRequestStarted = false;
        let nativeLiveObserved = false;
        let nativeSdkOutcome: 'completed' | 'error' | 'cancelled' | undefined;
        if (opts?.nativeBrokerAuthority) attemptProducedOutput = true;
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
          if (isStreamedAssistantProse(message)) streamedAssistantProseIds.add(message.id);
          if (archiveCanonicalMessages) {
            const nextBytes = estimateArchiveSnapshotBytes(message);
            const difference = nextBytes - (archivedMessageBytes.get(message.id) ?? 0);
            if (difference > 0) archiveSnapshotReservation?.grow(difference);
            if (pagedCanonical) pagedCanonical.upsert(message);
            else upsertMessageById(archiveCanonicalMessages, structuredClone(message));
            if (difference < 0) archiveSnapshotReservation?.shrink(-difference);
            archivedMessageBytes.set(message.id, nextBytes);
          }
          opts?.onTranscriptMessage?.(message);
        };

        // Same guard for streamed deltas and for virtual tools executed in-loop
        // by self-orchestrating adapters: a side effect (or user-visible text)
        // means the call must fail terminally instead of being replayed.
        // Blank leading deltas are not an answer. Withhold them until visible
        // content arrives so an empty/length response can retry without leaving
        // a blank assistant draft. Bound this transient buffer; the final message
        // still retains the provider's complete content.
        let pendingWhitespace: ModelStreamDelta | undefined;
        const onModelDelta = opts?.onModelDelta
          ? (delta: ModelStreamDelta) => {
              if (!attemptProducedOutput && !delta.mediaPart && !delta.toolCallDelta
                && !delta.contentDelta?.trim()) {
                const prefix = pendingWhitespace?.messageId === delta.messageId
                  ? pendingWhitespace.contentDelta ?? '' : '';
                pendingWhitespace = { messageId: delta.messageId,
                  contentDelta: (prefix + (delta.contentDelta ?? '')).slice(0, 8192) };
                return;
              }
              attemptProducedOutput = true;
              if (pendingWhitespace?.messageId === delta.messageId && pendingWhitespace.contentDelta) {
                opts.onModelDelta!(pendingWhitespace);
              }
              pendingWhitespace = undefined;
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
        // A resource reader can be armed by wire compaction after callModel
        // built its initial virtual-tool map. Give ordinary native SDK loops
        // the same scoped executor; sealed native/private inventories retain
        // their own admitted ports and are never expanded here.
        const recoveryExecutors = opts?.conversationId && !opts.nativeBrokerAuthority && !opts.executionExtensionContext
          && attemptTools?.some(tool => tool.function.name === READ_RESOURCE_TOOL_NAME)
          && !opts.localToolExecutors?.[READ_RESOURCE_TOOL_NAME]
          ? { ...opts.localToolExecutors, [READ_RESOURCE_TOOL_NAME]: async (args: Record<string, unknown>): Promise<unknown> => {
              const outcome = await executeRunResourceTool(READ_RESOURCE_TOOL_NAME, args, {
                conversationId: opts.conversationId,
                maxImageTokens: model.contextWindow ? Math.min(8192, Math.floor(model.contextWindow / 8)) : 8192,
                node: opts.nodeId ? { nodeId: opts.nodeId, nodeType: 'process' } : undefined,
                ...opts.durableContext,
              });
              return nativeRunResourceResult(outcome);
            } }
          : opts?.localToolExecutors;
        const localToolExecutors = recoveryExecutors
          ? Object.fromEntries(
              Object.entries(recoveryExecutors).map(([toolName, executor]) => [
                toolName,
                async (args: Record<string, unknown>): Promise<unknown> => {
                  await opts?.beforeToolDispatch?.();
                  attemptProducedOutput = true;
                  const result = await executor(args);
                  await assertFlowExecutionCurrent(opts?.durableContext ?? {});
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
          let providerMetadata: ModelCallResult['providerMetadata'];
          let media: ModelMediaPart[] | undefined;
          let contextUsage: ModelCallResult['contextUsage'];
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
              let nativeInventory: NativeInvocationSessionPayload['inventory'] & { digest: string } | undefined;
              const nativeToolPort = opts?.nativeBrokerAuthority
                ? await (async () => {
                    await opts.nativeBrokerAuthority!.assertCurrent();
                    const nativeTools = structuredClone(attemptTools ?? []);
                    const nativeBindings = structuredClone(opts.toolNameMap ?? {});
                    const nativeExecutors = Object.freeze({ ...localToolExecutors });
                    const hasHandoff = nativeTools.some(tool => tool.type === 'function'
                      && (tool.function.name === 'handoff' || tool.function.name.startsWith('handoff_to_')));
                    const terminationProtocol = hasHandoff && opts.nativeOriginalProcessHost
                      ? model.adapter === 'claude-cli' ? NATIVE_HANDOFF_PROTOCOL
                        : model.adapter === 'codex-cli' ? CODEX_NATIVE_HANDOFF_PROTOCOL : undefined
                      : undefined;
                    if (terminationProtocol) {
                      assertNativeOriginalProcessHost(opts.nativeOriginalProcessHost);
                      if (opts.nativeOriginalProcessHost.terminationProtocol !== terminationProtocol) throw new Error('Native Original adapter/termination protocol mismatch.');
                    }
                    const inventoryDigest = nativeToolInventoryDigest(nativeTools, nativeBindings, nativeExecutors, terminationProtocol);
                    nativeInventory = { digest: inventoryDigest, tools: nativeTools,
                      ...(terminationProtocol ? { terminationProtocol } : {}),
                      bindings: nativeBindings, syntheticNames: Object.keys(nativeExecutors).sort() };
                    nativeReceipt = await prepareNativeInvocation({
                      conversationId: opts.conversationId!, runId: opts.runId!, nodeId: opts.nodeId!,
                      modelId, leaseEpoch: opts.nativeBrokerAuthority!.leaseEpoch, inventoryDigest,
                      attemptOrdinal: sdkDispatchOrdinal + 1,
                      inputDigest: nativeDigest({ modelId, messages: hydratedMessages, tools: nativeTools,
                        temperature: attemptTemperature, maxTokens: opts.maxTokens }),
                    });
                    return createNativeToolPort({
                      receipt: nativeReceipt, tools: nativeTools, toolNameMap: nativeBindings,
                      localToolExecutors: nativeExecutors, service: mcpService, requestToolApproval: opts.requestToolApproval,
                      beforeToolDispatch: opts.beforeToolDispatch,
                      afterToolDispatch: () => assertFlowExecutionCurrent(opts.durableContext ?? {}),
                      authorizePersonaCoreMcp: opts.authorizePersonaCoreMcp,
                      authority: opts.nativeBrokerAuthority!, signal: abortController.signal,
                      terminationProtocol, originalProcessHost: opts.nativeOriginalProcessHost,
                      executionExtensionContext: opts.executionExtensionContext,
                      contextWindow: model.contextWindow,
                    });
                  })()
                : undefined;
              const markNativeSdkFinished = () => {
                if (!nativeSession || nativeSession.session.phase() === 'sdk-finished') return;
                // The original stream has ended. A delayed archive/host outcome
                // acknowledgement must not leave a cancellable live handle.
                nativeToolPort?.cancel();
                nativeSession.emit('sdk-finished');
              };
              const input = {
              model,
              apiKey: decryptedApiKey,
              beforeModelDispatch: async () => {
                if (modelStepContext) await assertExecutionExtensionCurrent(modelStepContext);
                await opts?.beforeModelDispatch?.();
              },
              temperatureOverride: opts?.temperatureOverride !== undefined
                ? normalizeModelTemperature(opts.temperatureOverride, model.provider, model.adapter, model.name)
                : undefined,
              onRoutingModel: async (member: Model) => {
                routingModel = member;
                opts?.onModelRouted?.(member.id);
                const key = await modelService.resolveAndDecryptApiKey(member.ApiKey);
                opaqueCredentialId = await credentialFingerprint(key ?? '').catch(() => undefined);
              },
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
              onSdkRequest: (nativeReceipt || (opts?.archiveModelTurns && opts.conversationId && opts.nodeId))
                ? async (snapshot: SdkRequestSnapshot): Promise<string | undefined> => {
                    if (nativeReceipt && nativeSdkRequestStarted) {
                      throw new NativeInvocationHeldError(nativeReceipt.invocationId);
                    }
                    try {
                      const archiveInput = {
                        ...(nativeReceipt ? { id: nativeReceipt.invocationId } : {}),
                        durableContext: opts?.durableContext,
                        ...(!nativeReceipt ? { writeAdmission: { wait: true, signal: abortController.signal } } : {}),
                        conversationId: opts!.conversationId!, runId: opts?.runId,
                        nodeId: opts!.nodeId!, nodeName: opts?.nodeName,
                        modelId: routingModel.id, modelName: routingModel.displayName || routingModel.name,
                        adapter: snapshot.adapter, operation: snapshot.operation,
                        attempt: ++sdkDispatchOrdinal,
                        canonicalMessages: archiveCanonicalMessages ?? opts?.canonicalMessages ?? messages,
                        canonicalArchive: pagedCanonical,
                        genericWire: snapshot.wireMessages ?? hydratedMessages,
                        sdkRequest: snapshot.request, modelInput: modelInputForArchive,
                        visualCompaction: visualDiagnostic,
                      };
                      const entry = await archiveModelDispatch(archiveInput, () => ({
                        ...archiveInput,
                        canonicalMessages: archiveCanonicalMessages
                          ? structuredClone(archiveCanonicalMessages) : archiveInput.canonicalMessages,
                        genericWire: snapshot.wireMessages !== undefined
                          ? structuredClone(snapshot.wireMessages) : archiveInput.genericWire,
                      }));
                      executionEventBus.emit(opts!.conversationId!, {
                        type: 'model:dispatch',
                        turn: entry,
                      });
                      await flushConversationLog(opts!.conversationId!);
                      if (nativeReceipt) {
                        nativeReceipt = await submitNativeInvocation(nativeReceipt);
                        await opts!.nativeBrokerAuthority!.assertCurrent();
                        abortController.signal.throwIfAborted();
                        if (opts?.nativeInvocationSessionHook) {
                          const archived = await readNativeModelTurnSnapshot(nativeReceipt.owner.conversationId,
                            entry.id, opts.nativeInvocationSessionHook.root.workspace, abortController.signal);
                          if (archived) assertNativeArchiveFormat(archived, entry.archiveVersion);
                          if (!archived || archived.entry.outcome !== 'running' || archived.entry.id !== nativeReceipt.invocationId
                            || archived.entry.conversationId !== nativeReceipt.owner.conversationId
                            || archived.entry.runId !== nativeReceipt.owner.runId
                            || archived.entry.node.nodeId !== nativeReceipt.owner.nodeId
                            || archived.entry.modelId !== nativeReceipt.owner.modelId
                            || archived.entry.attempt !== nativeReceipt.owner.attemptOrdinal
                            || archived.entry.adapter !== snapshot.adapter
                            || archived.entry.operation !== snapshot.operation
                            || !nativeInventory || nativeInventory.digest !== nativeReceipt.owner.inventoryDigest) {
                            throw new NativeInvocationHeldError(nativeReceipt.invocationId);
                          }
                          const lineage = await readNativeOriginLineage({
                            receipt: nativeReceipt, authority: opts.nativeBrokerAuthority!,
                            root: opts.nativeInvocationSessionHook.root, signal: abortController.signal,
                          });
                          const payloadRef = await saveNativeSessionPayload({
                            invocationId: nativeReceipt.invocationId,
                            archive: { sdkRequest: archived.sdkRequest, genericWire: archived.genericWire,
                              media: archived.media },
                            inventory: { tools: nativeInventory.tools, bindings: nativeInventory.bindings,
                                ...(nativeInventory.terminationProtocol ? { terminationProtocol: nativeInventory.terminationProtocol } : {}),
                              syntheticNames: nativeInventory.syntheticNames },
                          });
                          const savedPayload = await readNativeSessionPayload(payloadRef);
                          if (savedPayload.invocationId !== nativeReceipt.invocationId
                            || nativeDigest(savedPayload.archive.sdkRequest) !== nativeDigest(archived.sdkRequest)
                            || nativeDigest(savedPayload.archive.genericWire) !== nativeDigest(archived.genericWire)
                            || nativeDigest(savedPayload.archive.media) !== nativeDigest(archived.media)
                            || nativeDigest(savedPayload.inventory.tools) !== nativeDigest(nativeInventory.tools)
                            || nativeDigest(savedPayload.inventory.bindings) !== nativeDigest(nativeInventory.bindings)
                            || nativeDigest(savedPayload.inventory.syntheticNames) !== nativeDigest(nativeInventory.syntheticNames)) {
                            throw new NativeInvocationHeldError(nativeReceipt.invocationId);
                          }
                          nativeSession = createNativeInvocationSession({
                            receipt: nativeReceipt, lineage,
                            archive: {
                              dispatchId: entry.id, adapter: archived.entry.adapter,
                                archiveVersion: archived.version,
                              operation: archived.entry.operation,
                              sanitizedSdkRequestDigest: nativeDigest(archived.sdkRequest),
                              sanitizedGenericWireDigest: nativeDigest(archived.genericWire),
                              mediaCount: archived.media.length,
                            },
                              inventory: { digest: nativeInventory.digest, toolCount: nativeInventory.tools.length,
                                ...(nativeInventory.terminationProtocol ? { terminationProtocol: nativeInventory.terminationProtocol } : {}) },
                            payloadRef,
                          }, abortController.signal, () => {
                            abortController.abort();
                            nativeToolPort?.cancel();
                          });
                          await saveNativeSessionOrigin(nativeSession.session.descriptor);
                          const savedOrigin = await readSavedNativeOrigin({ invocationId: nativeReceipt.invocationId,
                            authority: opts.nativeBrokerAuthority!, root: opts.nativeInvocationSessionHook.root,
                            signal: abortController.signal });
                          if (nativeDigest(savedOrigin) !== nativeDigest(nativeSession.session.descriptor)) {
                            throw new NativeInvocationHeldError(nativeReceipt.invocationId);
                          }
                          await opts.nativeInvocationSessionHook.publish(nativeSession.session);
                          abortController.signal.throwIfAborted();
                          const publishedLineage = await readNativeOriginLineage({
                            receipt: nativeReceipt, authority: opts.nativeBrokerAuthority!,
                            root: opts.nativeInvocationSessionHook.root, signal: abortController.signal,
                          });
                          if (publishedLineage.digest !== lineage.digest) {
                            throw new NativeInvocationHeldError(nativeReceipt.invocationId);
                          }
                          nativeSession.emit('issue-uncertain');
                          // A synchronous subscriber can cancel this very session.
                          abortController.signal.throwIfAborted();
                          await opts.nativeBrokerAuthority!.assertCurrent();
                          await opts.nativeInvocationSessionHook.root.assertCurrent();
                          await opts.nativeBrokerAuthority!.assertCurrent();
                          abortController.signal.throwIfAborted();
                        }
                        nativeSdkRequestStarted = true;
                      }
                      return entry.id;
                    } catch (error) {
                      if (error instanceof ModelTurnArchiveMemoryError || isConversationDurabilityError(error)) throw error;
                      if (nativeReceipt) throw error;
                      rethrowFlowExecutionAuthorityError(error);
                      log.warn('Could not archive model SDK dispatch; continuing request', { error });
                      return undefined;
                    }
                  }
                : undefined,
              onSdkRequestResult: (nativeReceipt || (opts?.archiveModelTurns && opts.conversationId))
                ? async ({ dispatchId, outcome }: {
                    dispatchId: string;
                    outcome: 'completed' | 'error' | 'cancelled';
                  }): Promise<void> => {
                    try {
                      // Claude certifies stream closure through its dedicated
                      // notification after query close and owned process exit.
                      if (nativeSession && model.adapter !== 'claude-cli') markNativeSdkFinished();
                      await updateModelDispatchOutcome(opts!.conversationId!, dispatchId, outcome, opts?.durableContext);
                      if (nativeSession) {
                        await opts!.nativeInvocationSessionHook!.acknowledgeSdkOutcome(nativeSession.session, outcome);
                        abortController.signal.throwIfAborted();
                        await opts!.nativeBrokerAuthority!.assertCurrent();
                        abortController.signal.throwIfAborted();
                        nativeSession.emit('sdk-outcome', outcome);
                      }
                      if (nativeReceipt) nativeSdkOutcome = outcome;
                      executionEventBus.emit(opts!.conversationId!, {
                        type: 'model:dispatch-result',
                        dispatchId,
                        outcome,
                      });
                      await flushConversationLog(opts!.conversationId!);
                    } catch (error) {
                      if (nativeReceipt || isConversationDurabilityError(error)) throw error;
                      rethrowFlowExecutionAuthorityError(error);
                      log.warn('Could not finalize model SDK dispatch archive', { dispatchId, error });
                    }
                  }
                : undefined,
              onNativeSdkLive: opts?.nativeInvocationSessionHook
                ? async (): Promise<void> => {
                    if (!nativeSession || !nativeReceipt) throw new Error('Native original session was not published.');
                    if (nativeLiveObserved) return;
                    if (nativeSession.session.phase() === 'sdk-finished') {
                      throw new Error('Native original stream already finished.');
                    }
                    await opts.nativeInvocationSessionHook!.acknowledgeLive(nativeSession.session);
                    abortController.signal.throwIfAborted();
                    await opts.nativeBrokerAuthority!.assertCurrent();
                    abortController.signal.throwIfAborted();
                    nativeLiveObserved = true;
                    nativeSession.emit('confirmed-live');
                  }
                : undefined,
              onNativeSdkFinished: opts?.nativeInvocationSessionHook ? markNativeSdkFinished : undefined,
              messages: hydratedMessages,
              tools: nativeInventory?.tools ?? attemptTools,
              temperature: attemptTemperature,
              // Effective output-token cap: node-level override → per-model default
              // (resolved in callModel, #189), falling back to the per-model value
              // for any caller that doesn't pass one. Undefined ⇒ adapter default.
              maxTokens: opts?.maxTokens ?? normalizeMaxTokens(model.maxTokens),
              ...(disableReasoningForRecovery ? { disableReasoningForRecovery: true } : {}),
              outputSchema: opts?.outputSchema,
              toolNameMap: nativeToolPort ? undefined : opts?.toolNameMap,
              localToolExecutors: nativeToolPort ? undefined : localToolExecutors,
              nativeToolPort,
              nativeOriginalProcessHost: opts?.nativeOriginalProcessHost,
              shouldEndAgenticTurn: opts?.shouldEndAgenticTurn,
              maxTurns: opts?.maxTurns,
              requestToolApproval: nativeToolPort ? undefined : opts?.requestToolApproval,
              onTranscriptMessage,
              consumeSteeringMessages: nativeToolPort ? undefined : opts?.consumeSteeringMessages,
              steering: nativeToolPort ? undefined : opts?.steering,
              onModelDelta,
              onToolProgress: nativeToolPort ? undefined : onToolProgress,
              signal: abortController.signal,
              beforeToolDispatch: nativeToolPort ? undefined : opts?.beforeToolDispatch,
              executionExtensionContext: modelStepContext,
              authorizePersonaCoreMcp: nativeToolPort ? undefined : opts?.authorizePersonaCoreMcp,
              afterToolDispatch: nativeToolPort ? undefined : () => assertFlowExecutionCurrent(opts?.durableContext ?? {}),
              commitDurableMutation: nativeToolPort ? undefined : <T>(task: () => Promise<T>) =>
                commitFlowDurableMutation(opts?.durableContext ?? {}, task),
              conversationId: opts?.conversationId,
              runId: opts?.runId,
              nodeId: opts?.nodeId,
              codexSession: nativeToolPort ? undefined : opts?.codexSession,
              onCodexSessionChange: nativeToolPort ? undefined : opts?.onCodexSessionChange,
              responsesSession: nativeToolPort ? undefined : opts?.responsesSession,
              onResponsesSessionChange: nativeToolPort ? undefined : opts?.onResponsesSessionChange,
              runResourceMarkers: opts?.runResourceMarkers,
              sessionResume: nativeToolPort ? false : opts?.sessionResume,
              systemPromptPolicy: opts?.systemPromptPolicy,
              onSessionEvent: opts?.onSessionEvent,
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
              if (opts?.modelCatalogAdmission) await assertModelCatalogLeaseOwned();
              if (modelStepContext) {
                await assertExecutionExtensionCurrent(modelStepContext);
              }
              if (!model.fallbackPolicy) await opts?.beforeModelDispatch?.();
              const nativeResult = await (opts?.onModelDelta && adapter.createStreamCompletion
                ? adapter.createStreamCompletion(input)
                : adapter.createCompletion(input));
              if (nativeReceipt) {
                if (!nativeSdkRequestStarted) throw new NativeInvocationHeldError(nativeReceipt.invocationId);
                if (abortController.signal.aborted) throw new NativeInvocationHeldError(nativeReceipt.invocationId);
                if (nativeSdkOutcome !== 'completed') throw new NativeInvocationHeldError(nativeReceipt.invocationId);
                if (!nativeResult.nativeSdkTerminal) throw new NativeInvocationHeldError(nativeReceipt.invocationId);
                await opts!.nativeBrokerAuthority!.assertCurrent();
              }
              return nativeResult;
            };

            if (autoUnloadOllama && ollamaRootForUnload) {
              ({ completion: chatCompletion, transcript, liveMessageId, media, contextUsage, providerMetadata } = await withOllamaLock(
                ollamaRootForUnload,
                async () => {
                  const prev = getLoadedModel(ollamaRootForUnload);
                  if (prev && prev !== model.name) {
                    if (opts?.modelCatalogAdmission) await assertModelCatalogLeaseOwned();
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
              ({ completion: chatCompletion, transcript, liveMessageId, media, contextUsage, providerMetadata } = await issueCompletion());
            }
          } finally {
            // Native terminalization remains part of the cancellable original
            // invocation. Keep Stop polling through its durable release write.
            if (!opts?.nativeBrokerAuthority) stopCancelWatch();
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
            const errorObj = chatCompletion.error as unknown; // Type assertion for easier access
            attemptError = errorObj;

            // Shape the message + details consistently with the thrown-error path.
            const extracted = extractProviderErrorDetails(errorObj);

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
          // A self-orchestrating adapter can intentionally stop after executing
          // a terminal local control (meeting silence). Its completion envelope
          // is text-empty, but the returned transcript contains the valid
          // assistant/tool exchange and must not be mistaken for provider loss.
          const hasTranscriptActivity = Boolean(transcript?.length);
          if (
            (choice.finish_reason === 'stop' || choice.finish_reason === 'length')
            && !hasToolCalls
            && !hasGeneratedMedia
            && !hasTextContent
            && !hasTranscriptActivity
          ) {
            attemptError = { type: 'provider_response' };
            log.error('API ended with an empty message, no media, and no tool calls.', { modelId, finishReason: choice.finish_reason });
            return {
              success: false,
              error: createModelError(
                'api_error',
                choice.finish_reason === 'length'
                  ? 'The model reached its length limit before it wrote any answer. Raise "Max output tokens" or lower the "Thinking level" in the model settings, then retry.'
                  : `Model ended the response (finish_reason "${choice.finish_reason}") with an empty message, no media and no tool calls.`,
                modelId,
                undefined,
                { reason: choice.finish_reason === 'length' ? EMPTY_LENGTH_COMPLETION_REASON : EMPTY_STOP_COMPLETION_REASON, rawResponse: chatCompletion }
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
              contextUsage,
              liveMessageId,
              providerMetadata,
            }
          };

          if (nativeReceipt) {
            await opts!.nativeBrokerAuthority!.assertCurrent();
            if (abortController.signal.aborted) throw new NativeInvocationHeldError(nativeReceipt.invocationId);
            if (nativeSession) {
              await opts!.nativeInvocationSessionHook!.acknowledgeTerminalReady(nativeSession.session);
              abortController.signal.throwIfAborted();
              await opts!.nativeBrokerAuthority!.assertCurrent();
              abortController.signal.throwIfAborted();
            }
            await finishNativeInvocation(nativeReceipt, 'completed', {
              assertCurrent: opts!.nativeBrokerAuthority!.assertCurrent,
              signal: abortController.signal,
            });
            nativeTerminal = true;
            nativeSession?.settle({ state: 'terminal', outcome: 'completed' });
            await opts?.nativeOriginalProcessHost?.releaseAfterTerminal();
          }

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
            try {
              await opts?.flushTranscriptProjection?.();
              await removeFailedStreamedAssistantProse(opts?.conversationId, streamedAssistantProseIds);
            } catch (cleanupError) {
              log.warn('Failed to clean up streamed prose while retaining the primary model failure', { cleanupError });
            }
          }
          if (nativeReceipt && isFlowExecutionAuthorityError(error)) {
            // This attempt already owns a durable Original reservation. Report
            // its held failure through the native Result contract; finally
            // still holds/drains it, and native attempts cannot auto-retry.
            // Preflight failures without a receipt retain their typed throw.
            return { success: false, error: createModelError(error.code, error.message, modelId) };
          }
          return shapeCompletionError(error, modelId, abortController.signal.aborted);
        } finally {
          if (nativeReceipt && !nativeTerminal) {
            await holdNativeInvocation(nativeReceipt).catch(() => undefined);
            nativeSession?.settle({ state: 'held' });
          }
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
        attemptTools: OpenAI.ChatCompletionFunctionTool[] | undefined,
        attemptTemperature = temperature,
      ): Promise<Result<ModelCallResult>> => {
        for (;;) {
          attemptProducedOutput = false;
          const attemptResult = await attempt(attemptMessages, attemptTools, attemptTemperature);
          if (attemptResult.success || isConversationDurabilityCode(attemptResult.error.code)) return attemptResult;
          if (singlePhysicalAttempt || getHarnessExecution()) return attemptResult;

          if (abortController.signal.aborted || opts?.shouldAbort?.()) return attemptResult;
          if (opts?.nativeBrokerAuthority) return attemptResult;
          if (attemptProducedOutput) return attemptResult;
          // The policy has already applied its trigger and replay boundaries.
          // An outer rate-limit replay must not restart that decision (including
          // a disabled trigger or steering/approval activity observed inside it).
          if (model.fallbackPolicy) return attemptResult;
          if (supportsLocalModelAuth(resolveModelAdapter(model.provider, model.adapter))) return attemptResult;
          if (automaticRetriesUsed >= MAX_AUTOMATIC_MODEL_RETRIES) {
            log.warn('Automatic session-limit retries exhausted; returning the provider error', {
              modelId,
              retries: automaticRetriesUsed,
            });
            return attemptResult;
          }

          const plan = planAutomaticRetry(attemptResult.error, { retriesUsed: automaticRetriesUsed });
          if (!plan) return attemptResult;

          automaticRetriesUsed += 1;
          const nextAttempt = automaticRetriesUsed + 1;
          log.warn('Provider call can recover; waiting before an automatic retry', {
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
                category: plan.reason === 'session_limit' ? 'rate_limit' : 'provider_failure',
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

      // An empty `stop` or reasoning-only `length` is safe to replay when it has no prose,
      // media, transcript activity, or tool call/side effect. Give the provider
      // five retries first (preserving the exact prompt/cache prefix). After
      // two retries, raise temperature to 1 for exactly the next attempt, then
      // restore the configured temperature. If all five retries are empty,
      // make one final attempt with an explicit user nudge so models that became
      // stuck at an assistant boundary can recover. If that is empty too, return
      // the original normalized error shape.
      if (!singlePhysicalAttempt && !opts?.nativeBrokerAuthority && !result.success && isEmptyStoppedCompletionError(result.error)) {
        for (let retry = 1; retry <= EMPTY_STOP_RETRIES_BEFORE_SYNTHETIC_MESSAGE; retry++) {
          if (abortController.signal.aborted || opts?.shouldAbort?.() || attemptProducedOutput) break;
          // Replaying an exhausted reasoning budget unchanged can consume every
          // retry without producing a visible token. Keep the same Free/model
          // route and output cap, but ask OpenRouter to turn reasoning off for
          // this recovery request. Other adapters and saved settings are intact.
          if (!result.success && result.error.details?.reason === EMPTY_LENGTH_COMPLETION_REASON
            && model.provider === 'openrouter'
            && (!model.adapter || model.adapter === 'openai' || model.adapter === 'openai-responses')) {
            disableReasoningForRecovery = true;
          }
          const retryTemperature = retry === EMPTY_STOP_TEMPERATURE_RETRY
            ? EMPTY_STOP_RETRY_TEMPERATURE
            : temperature;
          log.warn('Model returned an empty stopped completion; retrying the same request', {
            modelId,
            retry,
            maxRetriesBeforeSyntheticMessage: EMPTY_STOP_RETRIES_BEFORE_SYNTHETIC_MESSAGE,
            temperatureRaised: retry === EMPTY_STOP_TEMPERATURE_RETRY,
          });
          result = await attemptWithLimitRetry(apiMessages, sanitizedTools, retryTemperature);
          if (result.success || !isEmptyStoppedCompletionError(result.error)) break;
        }

        if (
          !result.success
          && isEmptyStoppedCompletionError(result.error)
          && !abortController.signal.aborted
          && !opts?.shouldAbort?.()
          && !attemptProducedOutput
        ) {
          const syntheticRetryMessages: OpenAI.ChatCompletionMessageParam[] = [
            ...apiMessages,
            { role: 'user', content: EMPTY_STOP_SYNTHETIC_USER_MESSAGE },
          ];
          log.warn('Model repeatedly returned an empty stopped completion; retrying once with a synthetic user message', {
            modelId,
          });
          try {
            opts?.onFinalWire?.(syntheticRetryMessages, visualDiagnostic, modelInputForArchive);
          } catch (error) {
            log.warn('Final-wire observer failed during empty-completion retry; continuing retry', { error });
          }
          result = await attemptWithLimitRetry(syntheticRetryMessages, sanitizedTools);
        }
      }

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
      // recent tail costs nothing here. If resource-backed shrinking is still
      // insufficient, apply the same structurally-safe emergency refit used by
      // proactive budgeting. This path is adapter-neutral.
      if (
        !opts?.executionExtensionContext &&
        !opts?.nativeBrokerAuthority &&
        !attemptProducedOutput && !abortController.signal.aborted &&
        !result.success &&
        isContextOverflowError(result.error)
      ) {
        const beforeChars = JSON.stringify(apiMessages).length;
        let refitMarkers = opts?.runResourceMarkers;
        if (opts?.conversationId) {
          await assertFlowExecutionCurrent(opts.durableContext ?? {});
          refitMarkers = await captureOversizedToolResultsForRefit(
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
          allowLossyTruncation: false,
          toolResultHeadChars: OVERFLOW_TOOL_RESULT_HEAD_CHARS,
        });
        const reactiveChangedIndexes = refitMessages
          .map((message, index) => JSON.stringify(message) === JSON.stringify(apiMessages[index]) ? -1 : index)
          .filter(index => index >= 0);
        if (reactiveChangedIndexes.length > 0) {
          markModelInputMessages(
            modelInputForArchive,
            reactiveChangedIndexes.map(index => apiSourceIds[index]),
            'content-truncated',
            'Oversized content was shortened to a resource-backed marker after a provider context-length rejection.',
          );
          recordContextCompaction(modelInputForArchive, {
            kind: 'content-truncation',
            reason: 'One automatic retry after provider context rejection.',
            before: estimateOutgoingInputTokens(apiMessages, sanitizedTools, model),
            unit: 'tokens',
            truncatedMessages: reactiveChangedIndexes.length,
            injectedMarker: '[truncated',
          });
        }
        // A fixed 8192-token image cap cannot shrink an image already below
        // that cap. Provider tokenization may still reject that image (notably
        // on small windows); reduce its current pixel budget on the retry.
        const rejectedImageCosts = refitMessages.flatMap(message => Array.isArray(message.content)
          ? message.content.filter(part => part.type === 'image_url')
            .map(part => imageTokens(part.image_url.url, part.image_url.detail)) : []);
        const retryImageTokens = rejectedImageCosts.length
          ? Math.max(1, Math.floor(rejectedImageCosts.reduce((least, cost) => Math.min(least, cost), 16384) / 2)) : 8192;
        let retryMessages = await prepareImages(refitMessages, retryImageTokens);
        let retryTools = ensureReadResourceArmed(refitMessages, sanitizedTools);
        // The provider has just said the request is too long, so the retry must
        // be materially smaller even when the catalogue window says it fits.
        const retryTarget = Math.min(inputBudget ?? Infinity, Math.max(
          1,
          Math.floor(estimateOutgoingInputTokens(apiMessages, sanitizedTools, model) * 0.7),
        ));
        let retryEstimate = estimateOutgoingInputTokens(retryMessages, retryTools, model);
        const priorSourceIds = apiSourceIds;
        let retrySourceIds = apiSourceIds;
        if (retryEstimate > retryTarget) {
          // Omitted decisions stay searchable. Without the archive the retry
          // keeps today's behaviour: canonical history is unchanged either way.
          let sourceArchiveUri: string | undefined;
          try {
            sourceArchiveUri = await archiveContextForRefit(
              apiMessages, apiSourceIds, opts?.conversationId, opts?.nodeId, opts?.durableContext,
            );
          } catch (error) {
            rethrowFlowExecutionAuthorityError(error);
            log.warn('Could not archive the rejected request before the smaller retry; retrying without it', { error });
          }
          if (sourceArchiveUri) {
            retryTools = ensureReadResourceArmed([{ role: 'assistant', content: sourceArchiveUri }], retryTools);
          }
          let emergency = emergencyRefitMessages(retryMessages, {
            target: retryTarget,
            measure: candidate => estimateOutgoingInputTokens(candidate, retryTools, model),
            keepRecentMessages,
            resourceMarkers: refitMarkers,
            sourceArchiveUri,
          });
          if (emergency.after > retryTarget && (retryTools?.length ?? 0) > 0) {
            retryTools = ensureReadResourceArmed(emergency.messages, undefined);
            emergency = emergencyRefitMessages(retryMessages, {
              target: retryTarget,
              measure: candidate => estimateOutgoingInputTokens(candidate, retryTools, model),
              keepRecentMessages,
              resourceMarkers: refitMarkers,
              sourceArchiveUri,
            });
          }
          if (emergency.after <= retryTarget) {
            markModelInputMessages(
              modelInputForArchive,
              emergency.omittedMessageIndexes.map(index => priorSourceIds[index]),
              'emergency-stripped',
              'Omitted from the retry wire after the provider rejected the original request for context length.',
            );
            markModelInputMessages(
              modelInputForArchive,
              emergency.truncatedMessageIndexes.map(index => priorSourceIds[index]),
              'content-truncated',
              'Content was explicitly truncated on the retry after a provider context-length rejection.',
            );
            recordContextCompaction(modelInputForArchive, {
              kind: 'emergency-refit',
              reason: 'One automatic retry after a provider context-length rejection.',
              before: estimateOutgoingInputTokens(apiMessages, sanitizedTools),
              after: emergency.after,
              unit: 'tokens',
              omittedMessages: emergency.omittedMessageIndexes.length,
              truncatedMessages: emergency.truncatedMessageIndexes.length,
              injectedMarker: EMERGENCY_CONTEXT_REFIT_MARKER,
            });
            retryMessages = emergency.messages;
            retrySourceIds = emergency.sourceMessageIndexes.map(index => (
              index === undefined ? undefined : priorSourceIds[index]
            ));
            retryEstimate = emergency.after;
          }
        }
        const afterChars = JSON.stringify(retryMessages).length;
        if (afterChars < beforeChars && retryEstimate <= retryTarget) {
          apiMessages = retryMessages;
          apiSourceIds = retrySourceIds;
          sanitizedTools = retryTools;
          log.warn('Context-length overflow; retrying once with a compacted provider wire', {
            modelId,
            beforeChars,
            afterChars,
            retryEstimate,
            retryTarget,
          });
          try {
            opts?.onFinalWire?.(retryMessages, visualDiagnostic, modelInputForArchive);
          } catch (error) {
            log.warn('Final-wire observer failed during overflow refit; continuing retry', { error });
          }
          result = await attemptWithLimitRetry(retryMessages, retryTools);
        } else {
          log.warn('Context-length overflow but nothing on the wire left to compact; returning the original error', { modelId });
        }
      }

      return result;
    } catch (error) {
      // Setup (model fetch / key decrypt / compaction) threw — attempts shape
      // their own errors and never throw out.
      return shapeCompletionError(error, modelId, abortController.signal.aborted);
    } finally {
      // A native attempt keeps Stop polling through terminal persistence. Every
      // outer return path, including a held invocation, must then release it.
      stopCancelWatch();
      if (completionScope) releaseToolCall(completionScope, completionCallId);
      archiveSnapshotReservation?.release();
    }
  }

  /**
   * Process tool calls - pure function
   */
  public static async processToolCalls( // Make public static
    input: ToolCallProcessingInput
  ): Promise<Result<ToolCallProcessingResult>> {
    return traceSpan('tool.process', () => withSubflowOutputConsumption(() => processToolCallsAdmitted(input)));
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
