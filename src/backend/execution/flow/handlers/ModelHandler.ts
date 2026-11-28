import { isConversationDurabilityError, isConversationDurabilityCode } from '@/backend/execution/flow/conversationPublicationError';
import { getConversationStates } from '../conversationStateRegistry';
import { isCancelledByAncestry } from '../cancellation';
import { traceSpan } from '../turnTrace';
import { reserveArchiveSnapshot, estimateArchiveSnapshotBytes,
  ModelTurnArchiveMemoryError, type ArchiveMemoryReservation } from '../modelTurnArchiveWriteBudget';
import { createLogger } from '@/utils/logger';
import { getHarnessExecution } from '@/backend/services/harness/executionScope';
import { randomUUID } from 'node:crypto';
import { assertExecutionExtensionCurrent, executionExtensionCodexProfile, executionExtensionSinglePhysicalAttempt, issueExecutionModelStepContext, ExecutionExtensionError } from '@/backend/execution/extensions';
import {
  ModelCallInput,
  ModelCallResult,
  ToolCallProcessingInput,
  ToolCallProcessingResult
} from '../types/modelHandler';
import { FlujoChatMessage } from '@/shared/types/chat'; // Correct import path for FlujoChatMessage
import { Result, ExecutionError } from '../errors';
import { createModelError } from '../errorFactory';
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
import { stripHandoffPlumbing } from '../buildNodeContext';
import {
  cloneModelInputSnapshot,
  markModelInputMessages,
  recordContextCompaction,
} from './modelInputCompaction';
import OpenAI from 'openai';
import { modelService } from '@/backend/services/model';
import { assertCatalogAdmissionCurrent, assertModelCatalogLeaseOwned, withModelCatalogLease, type ModelCatalogAdmission } from '@/backend/services/model/catalogAdmission';
import { hydrateRunResourceMedia } from '@/backend/services/model/mediaHandoff';
import { resolveEffectiveMaxTurns } from './maxTurns';
import { resolveEffectiveMaxTokens } from './maxTokens';
import { COMPACTION_SUMMARY_MARKER } from './summarizingCompaction';
import { withExactSourceRecall } from '../compaction/exactSourceRecall';
import { isOwnerCredentialBoundModel, normalizeMaxTokens, validateOwnerCredentialBinding, type Model } from '@/shared/types/model';
import {
  normalizeModelTemperature,
  resolveModelAdapter,
  supportsLocalModelAuth,
  type ModelAdapter,
  type ModelProvider,
} from '@/shared/types/model/provider';
import { getCompletionAdapter } from '@/backend/services/model/adapters';
import { OpenAiUsageLike } from '@/backend/services/model/adapters/openaiUsage';
import { prepareOpenAiPromptCacheWire } from '@/backend/services/model/adapters/openaiPromptCaching';
import { fingerprintPrefix, classifyDrift, logCacheOutcome, derivePromptCacheKey } from './promptCacheMetrics';
import { mcpService } from '@/backend/services/mcp';
import { registerToolCall, releaseToolCall } from '../toolCancelRegistry';
import {
  MAX_AUTOMATIC_MODEL_RETRIES,
  planAutomaticRetry,
  waitForRetryWindow,
} from '../retryAfter';
import { executeRunResourceTool, nativeRunResourceResult, READ_RESOURCE_TOOL_NAME } from './runResourceTools';
import { withSubflowOutputConsumption } from '../subflowOutputBudget';
import type { ModelStreamDelta, ModelToolProgress, SdkRequestSnapshot } from '@/backend/services/model/adapters/types';
import type { ModelMediaPart } from '@/shared/types/model/media';
import { extractAssistantMedia } from '@/backend/services/model/adapters/messageUtils';
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
import { processToolCallsAdmitted, resolveToolUiLink } from './toolCallProcessing';
import { isAutoUnloadOllamaEnabled, isExperimentalFlagEnabled } from './modelHandlerSettings';
import { isStreamedAssistantProse, removeFailedStreamedAssistantProse } from './streamedAssistantMessages';
import { buildRunResourceMarkers, isContextOverflowError, resolveOutgoingInputBudget } from './contextWindowFit';
import { extractProviderErrorDetails, shapeCompletionError } from './providerErrorShape';
import type { GenerateCompletionOptions } from './modelCompletionContract';
import { compactWireProjection } from './wireCompaction';
import { buildSelfOrchestratedToolExecutors } from './selfOrchestratedToolExecutors';
import { createLiveModelProjection } from './liveModelProjection';
import { createModelSteering } from './modelSteering';
import { materializeModelTurn } from './modelTurnResult';
import { prepareProviderWire } from './providerWire';
import { refitWireAfterContextOverflow } from './contextOverflowRetry';

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

    const live = createLiveModelProjection({
      emit, conversationId, nodeId, durableContext, executionAuthority: input.executionAuthority,
    });
    const { liveMessageIds, onTranscriptMessage, onModelDelta, onToolProgress } = live;
    const enqueueLiveProjection = live.enqueue;
    const finishLiveProjection = live.finish;
    const flushLiveProjection = live.flush;

    const steering = createModelSteering({
      conversationId, modelAdapter, nodeId, durableContext,
      executionAuthority: input.executionAuthority, flushLiveProjection,
    });

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
        if (!live.isAccepting() || (event.kind !== 'accounting' && shouldAbort?.())) return;
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

    return materializeModelTurn({
      modelId, conversationId, nodeId, messages, toolNameMap, durableContext, emit, liveMessageIds, effectiveMaxTurns,
    }, response.value);
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

      const prepared = await prepareProviderWire(modelId, model, messages, tools, opts);
      if ('success' in prepared) return prepared;
      let { apiMessages, apiSourceIds } = prepared;
      const { sanitizedTools, modelInputForArchive, visualDiagnostic, keepRecentMessages, inputBudget, prepareImages } = prepared;

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
        const refit = await refitWireAfterContextOverflow({
          modelId, model, opts, apiMessages, apiSourceIds, sanitizedTools, modelInputForArchive,
          visualDiagnostic, keepRecentMessages, inputBudget, prepareImages,
        });
        if (refit) result = await attemptWithLimitRetry(refit.apiMessages, refit.sanitizedTools);
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
