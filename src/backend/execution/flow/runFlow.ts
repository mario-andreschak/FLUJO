import {
  applyExecutionRunInput,
  applyOriginalOwnerRunInput,
  prepareExecutionSubflowInput,
  runWithExecutionInput,
  validateExecutionExtensionRun,
  executionExtensionSharesPersonaAuthority,
  runWithExecutionConversationAccess,
  assertExecutionExtensionCurrent,
} from '@/backend/execution/extensions';
import { createLogger } from '@/utils/logger';
import { getHarnessExecution } from '@/backend/services/harness/executionScope';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { withConversationExecutionLock } from '@/backend/execution/flow/conversationExecutionLock';
import { claimFlowRunAdmission, recheckFlowRunAdmission, type FlowRunAdmissionPermit } from './runAdmission';
import { traceMark, traceSpan } from './turnTrace';
import { assertSubflowLaneCount, preflightSubflowHandoffArguments, subflowWorkerLimit, withSubflowPreparationBudget, type SubflowPreparationBudget } from './subflowPreparationBudget';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import {
  forget as forgetConversationCacheEntry,
  markTerminal as markConversationTerminal,
  noteWrite as noteConversationWrite,
} from '@/backend/execution/flow/conversationStateCache';
import {
  ownerScopeForRun,
  releaseRunOwnedBashSessions,
} from '@/backend/services/mcp/ownerScope';
import {
  reconcileConversationLog,
  repairDanglingToolCalls,
  appendRawForState,
  prepareConversationSequence,
  warmConversationSequence,
  flushConversationLog,
} from '@/backend/execution/flow/conversationLog';
import { isConversationSequenceSafetyError, type ConversationSequenceSafetyError } from './conversationLogSequence';
import { isConversationPublicationError, type ConversationPublicationError } from './conversationPublication';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { HUMAN_STEP_TOOL_NAME } from '@/utils/shared/humanStep';
import { recordWaitingHumanTask } from '@/backend/services/humanTasks/humanTaskIndex';
import { EmitFn } from '@/shared/types/execution/events';
import OpenAI from 'openai';
import { TOOL_CALL_ACTION, FINAL_RESPONSE_ACTION, HUMAN_APPROVAL_ACTION, ERROR_ACTION, STAY_ON_NODE_ACTION } from '@/backend/execution/flow/types';
import { FlujoChatMessage } from '@/shared/types/chat';
import { approvalForBatch } from './approvalSetting';
import { addLoadedDeferredTools } from './toolLoading/planStepTools';
import { requireFunctionToolCalls } from '@/shared/types/openai';
import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { waitForActiveSubflows } from './subflowCommunication';
import { isInternalToolName } from '@/backend/execution/flow/handlers/toolNamespace';
import { emitErrorOnce, emitNormalizedErrorOnce, deriveLastErrorFromLastResponse } from '@/backend/execution/flow/normalizeError';
import { flowService } from '@/backend/services/flow/index';
import { releaseUnsavedRunStore, resolveStepToolResults } from './stepToolResults';
import { StorageKey } from '@/shared/types/storage';
import { MAX_SUBFLOW_DEPTH } from '@/backend/execution/flow/constants';
import { isCancelledByAncestry, isConversationDeleted } from '@/backend/execution/flow/cancellation';
import { buildConversationTitle, isDefaultConversationTitle } from '@/utils/shared/conversationTitle';
import { setElicitationContext, clearElicitationContext } from '@/backend/services/mcp/elicitationContext';
import { GRACEFUL_CAP_SUMMARY_INSTRUCTION, GRACEFUL_CAP_TOOL_RESULT } from '@/backend/execution/flow/handlers/gracefulCap';
import { isMeetingTurnSilent } from '@/backend/execution/flow/handlers/meetingTools';
import { DEFAULT_AGENTIC_MAX_TURNS } from '@/shared/types/model/model';
import {
  classifyRecoveryFailure,
  commitRecoveryCheckpoint,
  commitRecoveryTransition,
  commitToolCheckpoint,
  markDanglingToolEffectsUnknown,
  setRecoveryTransition,
} from '@/backend/execution/flow/recoveryCheckpoint';
import { acknowledgeSubflowContinuation } from '@/backend/execution/flow/subflowRecovery';
import { withSubflowOutputConsumption } from '@/backend/execution/flow/subflowOutputBudget';
import { normalizeSessionKey } from '@/backend/execution/flow/sessionManagement';
import { hydrateLazyToolPayloads } from '@/backend/execution/flow/lazyToolPayloads';
import { combineAbortSignals } from '@/backend/execution/flow/combineAbortSignals';
import { registerCancellableRun } from '@/backend/execution/flow/cancellationCoordinator';
import { answerFromHandoffArguments, lacksFinishAnswer, markNoAnswer, NO_ANSWER_TEXT } from '@/backend/execution/flow/finishAnswer';
import type { FlowRunInput, FlowRunMessageInput, FlowRunResult, FlowRunStatus } from './runFlowContract';
import { publishRunFlowEvent } from './runFlowEvents';
import { unattendedDriveForward } from './unattendedDriveForward';
import { findStagedHandoffAssistant, isHandoffToolCall, unansweredOrdinaryCalls } from './stagedHandoff';
import { decisionsOfThisRun, describeRunError, runSuccessOutput } from './runFlowResult';
import { validateFlowRunInput } from './runInputValidation';
import { assertLoadedStateMayRun, loadRunState } from './runStateLoading';
import { createRunStatistics, resolveRunFlowRevision } from './runStatistics';
import { admitTurnMessages } from './runTurnAdmission';
import { routeTurnStart } from './runTurnRouting';
import { runPreflightChecks } from './runPreflight';
import { installRunInputs, openRunState } from './runStateSetup';
import {
  consumeAttachRequest, hasAttachRequest, latestModelInput, matchedToolBreakpointName, pauseForAttachAtSafePoint,
  pauseForDebug, previewNextModelInput, toolNodeIdsFor, type BoundaryDetails,
} from './runDebugPause';
import { accumulateUsage } from './runUsage';
import { drainSteering } from './runSteeringDrain';
import { decideHeldCallsLive, stepRequiresApproval } from './runToolApproval';
import { nodeBreakpoints } from '@/utils/shared/debugBreakpoints';
import {
  applyToolRepeatGuard,
  TOOL_REPEAT_TEMPERATURE,
} from '@/backend/execution/flow/toolRepeatGuard';

const log = createLogger('backend/execution/flow/runFlow');

// Persist conversation state WITHOUT the in-memory-only debug execution trace.
const persistState = persistConversationState;

export type { FlowRunInput, FlowRunMessageInput, FlowRunResult, FlowRunStatus } from './runFlowContract';

/**
 * The keystone. Extracted (behavior-preserving) from the old
 * processChatCompletionInternal: state init + the agent loop + final persist +
 * response-content resolution. Returns a typed FlowRunResult instead of an
 * OpenAI NextResponse, so callers other than the OpenAI shim (subflows,
 * scheduler) can run flows without the HTTP/OpenAI coupling.
 */
export async function runFlow(input: FlowRunInput): Promise<FlowRunResult> {
  if (getHarnessExecution()) input = { ...input, mode: 'ephemeral', conversationId: undefined, runId: undefined,
    abortSignal: getHarnessExecution()!.signal };
  const admission = claimFlowRunAdmission(input);
  try {
    return await runFlowAdmitted(input, admission);
  } finally {
    admission.release();
  }
}

async function runFlowAdmitted(input: FlowRunInput, admission: FlowRunAdmissionPermit): Promise<FlowRunResult> {
  traceMark('runFlow.admitted');
  const delegated=await prepareExecutionSubflowInput(input);
  if(delegated)return runWithExecutionInput(delegated,()=>runFlowAdmitted(delegated, admission));
  input = await applyOriginalOwnerRunInput(applyExecutionRunInput(input));
  await validateExecutionExtensionRun(input);
  recheckFlowRunAdmission(admission, input);
  const ownerSignal = combineAbortSignals(input.abortSignal, input.executionAuthority?.signal);
  const registration = await registerCancellableRun({
    runId: input.runId,
    conversationId: input.conversationId,
    signal: ownerSignal,
  });
  const registeredInput: FlowRunInput = {
    ...input,
    abortSignal: combineAbortSignals(ownerSignal, registration.signal),
  };
  try {
    const execute = () => {
      traceMark('runFlow.locked');
      // A lock/barrier can outlive the original input estimate or process
      // headroom. Recheck before touching the conversation it protects.
      recheckFlowRunAdmission(admission, registeredInput);
      return runFlowUnlocked(registeredInput);
    };
    if (!registeredInput.conversationId) return await execute();
    const run = () => withConversationExecutionLock(registeredInput.conversationId!, execute);
    if (executionExtensionSharesPersonaAuthority(registeredInput.executionExtensionContext, registeredInput.executionAuthority)) {
      return await runWithExecutionConversationAccess(registeredInput.conversationId,
        () => assertExecutionExtensionCurrent(registeredInput.executionExtensionContext), run);
    }
    return await withConversationExecutionLock(
      registeredInput.conversationId,
      execute,
    );
  } finally {
    registration.release();
  }
}

async function runFlowUnlocked(input: FlowRunInput): Promise<FlowRunResult> {
  const { personaInstructionContext, personaCoreAppRefs } = validateFlowRunInput(input);

  const startTime = Date.now();

  const flujo = input.flujo ?? true;
  const requireApproval = input.requireApproval === undefined ? undefined : input.requireApproval === true; // missing: the saved setting
  const flujodebug = input.debug ?? false;
  const continueDebug = input.continueDebug ?? false;
  const userTurn = input.userTurn ?? false;
  const ephemeral = input.mode === 'ephemeral';

  // Reconstruct the legacy `data` shape the body below reads from.
  const inputMessages: FlowRunMessageInput[] = input.messages
    ?? (input.prompt !== undefined ? [{ role: 'user', content: input.prompt }] : []);
  const data: { model?: string; messages: FlowRunMessageInput[]; processNodeId?: string } = {
    model: input.modelName,
    messages: inputMessages,
    processNodeId: input.processNodeId,
  };

  log.info('runFlow invoked', {
    flowId: input.flowId,
    model: input.modelName,
    messageCount: inputMessages.length,
    mode: ephemeral ? 'ephemeral' : 'conversation',
    flujo,
    requireApproval,
    flujodebug,
    conversationId: input.conversationId,
  });

  // --- 1. Initialize or Retrieve State ---
  const effectiveConvId = input.conversationId || crypto.randomUUID();
  await traceSpan('runFlow.warmSequence', () => warmConversationSequence(effectiveConvId));
  prepareConversationSequence(effectiveConvId);
  const storageKey = `conversations/${effectiveConvId}` as StorageKey;

  log.info(`Effective Conversation ID for this run: ${effectiveConvId}`, { providedId: input.conversationId });

  const { loadedState, stateSource } = await loadRunState(input, effectiveConvId, storageKey, ephemeral);

  traceMark('state.loaded');
  const resetPersonaPromptPrefix = await assertLoadedStateMayRun(
    loadedState, input, effectiveConvId, personaInstructionContext,
  );

  // Approval/debug resumes are continuations of the same logical run. A new
  // user turn on a completed/error conversation receives a fresh id below.
  const resumingPausedLogicalRun = Boolean(
    !resetPersonaPromptPrefix
    &&
    !userTurn
    &&
    loadedState?.logicalRunId
    && (
      loadedState.status === 'awaiting_tool_approval'
      || loadedState.status === 'paused_debug'
      || loadedState.debugResumeAfterDetach
    )
  );

  const opened = openRunState({
    loadedState, stateSource, effectiveConvId, processNodeId: data.processNodeId, input, flujodebug,
  });
  let sharedState = opened.sharedState;
  const { resumingAfterError } = opened;

  const { harnessInitialVariables, logicalRunId } = await installRunInputs({
    sharedState, input, effectiveConvId, flujodebug, userTurn, ephemeral, requireApproval,
    resumingPausedLogicalRun, resetPersonaPromptPrefix, personaInstructionContext, personaCoreAppRefs,
  });
  const { ensureRunStarted, finalizeRun } = createRunStatistics({
    state: () => sharedState, input, logicalRunId, effectiveConvId, startTime, runFlow,
  });

  if ((sharedState.runDepth ?? 0) > MAX_SUBFLOW_DEPTH) {
    log.error(`runFlow aborted: subflow depth ${sharedState.runDepth} exceeds max ${MAX_SUBFLOW_DEPTH}`);
    sharedState.status = 'error';
    return finalizeRun({
      status: 'error',
      conversationId: effectiveConvId,
      outputText: '',
      messages: sharedState.messages,
      error: { message: `Subflow recursion limit (${MAX_SUBFLOW_DEPTH}) exceeded`, statusCode: 500 },
      finalAction: ERROR_ACTION,
      sharedState,
    });
  }

  // Conversation GET responses may carry short display previews for large tool
  // bodies. Restore those references before the client history can replace the
  // canonical transcript (also covers a split copied into a new conversation).
  if (data.messages?.length) {
    data.messages = await hydrateLazyToolPayloads(
      data.messages,
      sharedState.messages ?? [],
      effectiveConvId,
      sharedState,
    ) as FlowRunMessageInput[];
  }

  // Snapshot the pre-turn messages for the log reconcile below: the incoming
  // request may REPLACE the message list (the chat client sends its full,
  // possibly pruned/edited history each turn), and the append-only log needs
  // the diff, not the replacement.
  const messagesBeforeTurn: FlujoChatMessage[] = [...(sharedState.messages ?? [])];
  const admittedMessageIds = new Set<string>();

  const flowNotResolved = await admitTurnMessages({
    sharedState, stateSource, input, data, effectiveConvId, storageKey, userTurn, flujodebug, admittedMessageIds, finalizeRun,
  });
  if (flowNotResolved) return flowNotResolved;

  await resolveRunFlowRevision(sharedState);
  ensureRunStarted();

  // --- Bring the append-only conversation log in line with this turn's input ---
  // Bootstraps the log for brand-new/legacy conversations and records the diff
  // (new turns, edits, pruned messages) for logged ones, BEFORE any run event
  // is emitted. Ephemeral runs are refused inside. Advisory on failure: the
  // legacy SharedState persistence below still covers the conversation.
  try {
    await traceSpan('log.reconcile', () => reconcileConversationLog(sharedState, messagesBeforeTurn, admittedMessageIds));
    // Issue #256: heal any assistant tool_calls turn left unanswered by a
    // crash/restart mid-tool before the run loop builds a provider request.
    // Persist each synthetic result via the log-only path so the projection is
    // self-healing and the repair is auditable in the transcript.
    const repaired = repairDanglingToolCalls(sharedState);
    if (repaired.length) {
      log.info(`Repaired ${repaired.length} dangling tool call(s) for ${effectiveConvId} at run start (issue #256).`);
      markDanglingToolEffectsUnknown(sharedState, 'running');
      await appendRawForState(sharedState, [
        ...repaired.map(m => ({ type: 'message' as const, message: m })),
        { type: 'recovery:checkpoint', checkpoint: sharedState.recovery!.currentCheckpoint! },
        { type: 'recovery:transition', recovery: { ...sharedState.recovery! } },
      ]);
    }
  } catch (error) {
    log.warn(`Conversation-log reconcile failed for ${effectiveConvId}; continuing`, error);
  }

  await routeTurnStart({
    sharedState, effectiveConvId, userTurn, stateSource, ephemeral,
    processNodeId: data.processNodeId, resumingAfterError, messagesBeforeTurn,
  });

  // --- 2. Main Execution Logic ---
  let currentAction: string | undefined = undefined;
  // Set when the pre-run consistency check below fails. The execution loop is
  // skipped and the standard terminal/error path reports it.
  let preflightError = false;
  const MAX_INTERNAL_ITERATIONS = 150;
  let internalIterations = 0;
  // Unattended drive-forward (issue #218): per-node nudge counter, run-scoped
  // (a resume starts fresh). Keyed by the Process node id that stalled.
  const unattendedNudges = new Map<string, number>();
  // Graceful landing (issue #253): per-node agentic-turn counter for the
  // request/response tool loop. Incremented each time the loop re-enters with a
  // tool-call action for the same Process node; once it reaches that node's
  // resolved turn budget we force a final text-only summary instead of running
  // more tools. Run-scoped (a resume starts fresh).
  const nodeTurnCounts = new Map<string, number>();

  // --- Execution event emission (live progress + debugger) ---
  const isConversationDurabilityFailure = (error: unknown): error is ConversationSequenceSafetyError | ConversationPublicationError =>
    isConversationSequenceSafetyError(error) || isConversationPublicationError(error);
  let sequenceFailure: ConversationSequenceSafetyError | ConversationPublicationError | undefined;
  let sequenceErrorCleanup = false;
  let lastEmissionAdmitted = false;
  let errorEventAdmitted = false;
  const underlyingEmit: EmitFn = input.emit ?? executionEventBus.emitterFor(effectiveConvId, event => {
    lastEmissionAdmitted = true;
    if (event.type === 'error') errorEventAdmitted = true;
    if (event.type === 'message' && event.message.id) emittedMessageIds.add(event.message.id);
  });
  const emit: EmitFn = event => {
    lastEmissionAdmitted = false;
    if (sequenceFailure) {
      // A broken sequence cannot stamp another error about that same failure.
      // Normal work still throws, so no later dispatch is silently permitted.
      if (sequenceErrorCleanup || event.type === 'error') return;
      throw sequenceFailure;
    }
    // Opaque callbacks have no trusted acceptance receipt. Once attempted,
    // never replay their error/message event automatically after a throw.
    if (input.emit && event.type === 'error') errorEventAdmitted = true;
    try {
      underlyingEmit(event);
      lastEmissionAdmitted = true;
      if (event.type === 'error') errorEventAdmitted = true;
    }
    catch (error) {
      if (isConversationDurabilityFailure(error)) {
        sequenceFailure = error;
        if (sequenceErrorCleanup) return; // Preserve the original execution error.
      }
      throw error;
    }
  };
  // A custom emitter forwards child events onto the parent channel. Recovery
  // records for persisted children must instead append to the child's own log;
  // omitting the emitter selects that direct durable path.
  const recoveryEmit: EmitFn | undefined = input.emit ? undefined : emit;
  // Emission is tracked by message IDENTITY, not index: ProcessNode.post
  // REPLACES sharedState.messages with a system-message-prefixed copy of the
  // node context, so an index cursor shifts and re-emits the last pre-step
  // message (the user's turn — seen as a duplicated bubble in the live view).
  // Everything present at run start counts as already known to the client
  // (it fetches full state on connect / shows the user message optimistically).
  const emittedMessageIds = new Set<string>(
    sharedState.messages.map(m => m.id).filter((id): id is string => !!id)
  );

  const emitNewMessages = (inputMessageIds?: ReadonlySet<string>) => {
    for (const msg of sharedState.messages) {
      // Strengthen the id invariant at the emission boundary: a message
      // without an id could never be tracked (or deduped by any consumer).
      if (!msg.id) msg.id = crypto.randomUUID();
      if (emittedMessageIds.has(msg.id)) continue;
      // The node's system prompt (prepended into the transcript by
      // ProcessNode.post's write-back) is model plumbing, not conversation
      // content — never emitted under the old index cursor either (it lands
      // BEFORE the cursor). Keep it out of the live stream.
      if (msg.role === 'system') { emittedMessageIds.add(msg.id); continue; }
      if (input.emit) emittedMessageIds.add(msg.id);
      emit({
        type: 'message',
        message: msg,
        messageOrigin: inputMessageIds?.has(msg.id) ? 'input' : 'internal',
        node: msg.processNodeId ? { nodeId: msg.processNodeId } : undefined,
      });
      if (lastEmissionAdmitted) { emittedMessageIds.add(msg.id); accumulateUsage(sharedState, emit, msg); }
    }
  };

  const applyRepeatGuard = (processedCalls: readonly import('./types').ToolCallInfo[] | undefined) => {
    const guardState = sharedState.toolRepeatGuard
      ?? { logicalRunId, entries: [] };
    sharedState.toolRepeatGuard = guardState;
    const decision = applyToolRepeatGuard(guardState, processedCalls);
    if (decision.raiseTemperature) {
      sharedState.temperatureOverrideOnce = TOOL_REPEAT_TEMPERATURE;
      log.info(`Repeated-tool guard raised the next model turn temperature for ${effectiveConvId}.`);
    }
    for (const content of decision.hints) {
      sharedState.messages.push({
        id: crypto.randomUUID(),
        role: 'user',
        content,
        timestamp: Date.now(),
        processNodeId: sharedState.currentNodeId,
        // Synthetic control-plane guidance must survive latest-message and
        // isolated input scoping so it reaches the very next model turn.
        injected: true,
      } as FlujoChatMessage);
    }
  };

  // --- Elicitation context: bind active run to each MCP server in this flow ---
  // The elicitation handler (registered at connect time) looks up the active
  // conversationId + unattended flag here when a server calls elicitation/create.
  const elicitationServerNames: string[] = [];
  if (sharedState.flowId) {
    try {
      const elicitFlow = sharedState.flowSnapshot ?? await flowService.getFlow(sharedState.flowId);
      if (elicitFlow) {
        for (const node of elicitFlow.nodes || []) {
          const serverName = node.data?.properties?.boundServer as string | undefined;
          if (node.data?.type === 'mcp' && serverName) {
            elicitationServerNames.push(serverName);
            setElicitationContext(serverName, {
              conversationId: effectiveConvId,
              getUnattended: () => !!(sharedState.unattended),
            });
          }
        }
      }
    } catch (err) {
      log.debug('Could not enumerate MCP servers for elicitation context; skipping', { err });
    }
  }

  if (await runPreflightChecks({ sharedState, input, effectiveConvId, userTurn, stateSource })) {
    currentAction = ERROR_ACTION;
    preflightError = true;
  }

  // Cancellation covers this run's own flag AND any ancestor's (issue #109): a
  // subflow child has its own SharedState, so the parent's flag only reaches it
  // through the parentRunId chain. Once an ancestor is found cancelled, the flag
  // is copied onto this state so descendants (and later checks) short-circuit.
  let cancelledByAncestor = false;
  const runtimeAbortSignal = combineAbortSignals(
    input.abortSignal,
    input.executionAuthority?.signal,
  );
  Object.defineProperty(sharedState, 'abortSignal', {
    value: runtimeAbortSignal,
    configurable: true,
    writable: true,
    enumerable: false,
  });
  const runCancelled = (): boolean => {
    if (runtimeAbortSignal?.aborted) {
      sharedState.isCancelled = true;
      return true;
    }
    if (sharedState.isCancelled) return true;
    if (isCancelledByAncestry(sharedState.parentRunId, FlowExecutor.conversationStates)) {
      cancelledByAncestor = true;
      sharedState.isCancelled = true;
      return true;
    }
    return false;
  };

  const processToolCallsRecoverably = async (
    args: Parameters<typeof ModelHandler.processToolCalls>[0],
    persistAfter = false,
  ): ReturnType<typeof ModelHandler.processToolCalls> => withSubflowOutputConsumption(async () => {
    await commitToolCheckpoint(storageKey, sharedState, args.toolCalls, 'before', recoveryEmit);
    const markUnknown = async () => {
      try {
        await commitToolCheckpoint(storageKey, sharedState, args.toolCalls, 'unknown', recoveryEmit);
      } catch (error) {
        if (!isConversationDurabilityFailure(error)) throw error;
        // The tool already failed. Keep that primary outcome; normal terminal
        // persistence below saves this unknown-effect classification without
        // recursively numbering it or masking the primary failure on a retry.
        sequenceFailure ??= error;
      }
    };
    let result: Awaited<ReturnType<typeof ModelHandler.processToolCalls>>;
    try {
      result = await ModelHandler.processToolCalls({
        ...args,
        // The tool result size limit of the step and model that read these results (#1226).
        ...(args.modelContextWindow === undefined ? await resolveStepToolResults(sharedState) : {}),
        signal: combineAbortSignals(args.signal, runtimeAbortSignal),
        beforeToolDispatch: input.executionAuthority?.assertCurrent,
        executionAuthority: sharedState.executionAuthority,
        executionExtensionContext: sharedState.executionExtensionContext,
        personaAttribution: sharedState.personaAttribution,
        // #1448: deferred tool descriptions and code mode.
        toolCatalog: sharedState.stepToolCatalog,
        markToolsLoaded: (names) => addLoadedDeferredTools(sharedState, names),
        requireToolApproval: approvalForBatch(sharedState),
        onApprovalRequired: sharedState.onApprovalRequired,
        approvalConversationId: sharedState.approvalConversationId,
      });
    } catch (error) {
      await markUnknown();
      throw error;
    }
    if (!result.success) await markUnknown();
    else {
      // Own inline subflow output through its actual transcript publication,
      // including the new serialized tool strings in the parent checkpoint.
      const messages: FlujoChatMessage[] = result.value.toolCallMessages.map(msg => ({
        ...msg, id: crypto.randomUUID(), timestamp: Date.now(), processNodeId: sharedState.currentNodeId,
      }));
      sharedState.messages.push(...messages);
      applyRepeatGuard(result.value.processedToolCalls);
      FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
      emitNewMessages();
      await commitToolCheckpoint(storageKey, sharedState, args.toolCalls, 'completed', recoveryEmit);
      if (persistAfter) {
        try {
          sharedState.updatedAt = Date.now();
          await persistState(storageKey, sharedState);
        } catch (error) {
          log.error(`Failed to save state after debug tool execution for conv ${effectiveConvId}:`, error);
        }
      }
    }
    return result;
  });

  const singleStep = !!sharedState.debugMode && !continueDebug;
  if (!userTurn && sharedState.status === 'paused_debug') {
    // A Step request resumes one safe boundary. Mark the transient in-flight
    // state accurately; pauseForDebug below parks it again before returning.
    sharedState.status = 'running';
  }
  // Stops the run for a person's decision on `heldCalls`. Other calls in the
  // batch run first: a batch has no order guarantee (#252), and this is what
  // lets a read-only call go ahead without a click while a change waits.
  const holdForApproval = async (
    heldCalls: OpenAI.ChatCompletionMessageFunctionToolCall[],
    batch: OpenAI.ChatCompletionMessageFunctionToolCall[],
    authoredByFlow = !approvalForBatch(sharedState),
  ): Promise<void> => {
    // A saved run can wait for a person. A transient one has nothing to come
    // back to, so what a flow requires fails there rather than being skipped.
    const noApprover = sharedState.onApprovalRequired === 'fail' || (authoredByFlow && sharedState.ephemeral);
    if (noApprover) {
      // Headless fail-fast (#115): approval is required, but this run has
      // no interactive approver. Execute nothing.
      const toolName = heldCalls[0]?.function.name ?? 'unknown';
      const reason = sharedState.onApprovalRequired === 'fail' ? 'approvalPolicy: fail' : 'this run is not saved';
      const message = toolName === HUMAN_STEP_TOOL_NAME
        ? `This flow has a Human step, but nobody can answer it in this run (${reason}). Start the flow from the chat, an automation or a saved API run.`
        : `Headless run requires approval for tool "${toolName}" but no approver is available (${reason}).`;
      log.info(`[approval] Failing fast for tool "${toolName}" (conv ${effectiveConvId}): ${reason}`);
      sharedState.status = 'error';
      sharedState.pendingToolCalls = heldCalls;
      sharedState.lastResponse = {
        success: false,
        error: message,
        errorDetails: { message, type: 'approval_required', name: toolName },
      };
      currentAction = ERROR_ACTION;
      return;
    }

    const freeCalls = batch.filter((call) => !heldCalls.includes(call));
    if (freeCalls.length > 0) {
      const freeResult = await processToolCallsRecoverably({
        toolCalls: freeCalls, toolNameMap: sharedState.toolNameMap, offeredToolNames: sharedState.offeredToolNames, emit,
        conversationId: sharedState.ephemeral ? undefined : sharedState.conversationId,
        runId: logicalRunId,
        node: sharedState.currentNodeId ? { nodeId: sharedState.currentNodeId } : undefined,
        shouldAbort: runCancelled,
        mcpNodes: sharedState.currentMCPNodes,
      });
      if (!freeResult.success) {
        log.error(`Tool processing before an approval pause failed for conv ${effectiveConvId}`, { error: freeResult.error });
        sharedState.lastResponse = { success: false, error: 'Tool processing failed', errorDetails: freeResult.error };
        currentAction = ERROR_ACTION;
        return;
      }
    }

    log.info(`[approval] Pausing execution for tool approval for conv ${effectiveConvId}`);
    sharedState.status = 'awaiting_tool_approval';
    sharedState.pendingToolCalls = heldCalls;
    sharedState.lastResponse = undefined;
    FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
    try {
      sharedState.updatedAt = Date.now();
      if (isDefaultConversationTitle(sharedState.title) && sharedState.messages.length > 0) {
        const firstUserMessage = sharedState.messages.find(m => m.role === 'user');
        if (firstUserMessage && typeof firstUserMessage.content === 'string') {
          sharedState.title = buildConversationTitle(firstUserMessage.content);
          log.verbose(`Updated conversation title for ${effectiveConvId} before pausing to: ${sharedState.title}`);
        }
      }
      await persistState(storageKey, sharedState); // chokepoint refuses ephemeral states
      log.verbose(`Saved state before pausing for approval for conv ${effectiveConvId}`);
    } catch (error) {
      log.error(`Failed to save state before pausing for approval for conv ${effectiveConvId}:`, error);
      const humanTask = sharedState.humanTask;
      if (humanTask && heldCalls.some((call) => call.id === humanTask.toolCallId)) {
        // A Human step promises a wait that survives a restart. One that was not
        // saved cannot keep that promise, so say so instead of seeming to wait.
        const message = 'The Human step could not be saved, so the run cannot wait for an answer. Nothing after it ran.';
        sharedState.status = 'error';
        sharedState.humanTask = undefined;
        sharedState.pendingToolCalls = undefined;
        sharedState.lastResponse = { success: false, error: message, errorDetails: { message, type: 'flow_error', code: 'human_step_not_saved' } };
        currentAction = ERROR_ACTION;
        return;
      }
    }
    await recordWaitingHumanTask(sharedState, effectiveConvId, heldCalls.map((call) => call.id));
    emit({ type: 'run:awaiting_approval', pendingToolCalls: heldCalls });
  };

  try {
    // Initial owned-state emissions can exhaust too; they must reach the same
    // terminal cleanup as execution failures before any provider dispatch.
    traceMark('run.start');
    emit({ type: 'run:start', flowId: sharedState.flowId });
    await commitRecoveryTransition(storageKey, sharedState, 'running', {}, recoveryEmit);
    traceMark('loop.start');
    if (!preflightError) {
      while (true) {
        internalIterations++;
        log.debug(`--- Starting Execution Step ${internalIterations} for Conv ${effectiveConvId} ---`);

        if (internalIterations > MAX_INTERNAL_ITERATIONS) {
          log.warn(`Max internal iterations (${MAX_INTERNAL_ITERATIONS}) reached for conv ${effectiveConvId}. Breaking loop.`);
          if (currentAction !== ERROR_ACTION) {
            sharedState.lastResponse = { success: false, error: `Maximum internal iterations (${MAX_INTERNAL_ITERATIONS}) reached.` };
            currentAction = ERROR_ACTION;
          }
          break;
        }

        if (runCancelled()) {
          log.info(`Cancellation flag detected for conv ${effectiveConvId}. Terminating execution.`);
          sharedState.status = 'error';
          sharedState.lastResponse = { success: false, error: 'Execution cancelled by user.' };
          currentAction = ERROR_ACTION;
          break;
        }

        // meeting_control(silent) is a terminal control for this participant's
        // current barrier round. The action buffer is freshly installed for
        // every round, so this stops only this run and naturally resets on the
        // next coordinator turn.
        if (isMeetingTurnSilent(sharedState.meetingTurn)) {
          log.info(`Meeting participant ended the current round silently for conv ${effectiveConvId}.`);
          sharedState.status = 'completed';
          currentAction = FINAL_RESPONSE_ACTION;
          break;
        }

        // A heartbeat can fail or another owner can recover an expired lease
        // between loop iterations without this process receiving an abort event.
        // Verify the authoritative fence before doing more Persona work.
        await input.executionAuthority?.assertCurrent();
        if (input.executionExtensionContext) await (await import('@/backend/execution/extensions')).assertExecutionExtensionCurrent(input.executionExtensionContext);

        // Mid-run steering: deliver anything the user sent while this run has
        // been working, BEFORE the next model call, so the correction lands on
        // the very next turn instead of after the run finishes. Deferred
        // automatically while a tool exchange is unresolved (see drainSteering).
        // The first iteration also picks up anything left over from a previous
        // run that ended before its inbox was drained.
        await drainSteering(sharedState, effectiveConvId, emitNewMessages);

        // A completed model turn can be parked before its action is applied.
        // Consume that action exactly once on resume instead of calling the
        // model again and potentially producing a different decision.
        let actionReadyFromDebugPause = false;
        let steppedThroughControlNode = false;
        if (sharedState.debugPendingAction) {
          currentAction = sharedState.debugPendingAction.action;
          sharedState.debugPendingAction = undefined;
          actionReadyFromDebugPause = true;
          log.info(`[Debug Resume] Applying pending action "${currentAction}" for conv ${effectiveConvId}.`);
        }

        // Resume a mixed ordinary-tools + handoff batch after an approval,
        // debugger pause, or process restart. Execute only unanswered ordinary
        // calls; once none remain, commit the staged edge without another model
        // turn. Approval/debug pending lists retain precedence while parked.
        if (
          !actionReadyFromDebugPause
          && sharedState.handoffRequested
          && !sharedState.debugPendingToolCalls?.length
          && sharedState.status !== 'awaiting_tool_approval'
        ) {
          const stagedAssistant = findStagedHandoffAssistant(sharedState);
          if (stagedAssistant) {
            const unanswered = unansweredOrdinaryCalls(sharedState, stagedAssistant);
            currentAction = unanswered.length > 0
              ? TOOL_CALL_ACTION
              : sharedState.handoffRequested.edgeId;
            actionReadyFromDebugPause = true;
            log.info('[Staged Handoff] Resuming mixed tool batch', {
              conversationId: effectiveConvId,
              unansweredOrdinaryCalls: unanswered.length,
              nextAction: currentAction,
            });
          }
        }

        // Debug step granularity: execute tool calls a previous step paused before.
        if (!actionReadyFromDebugPause && sharedState.debugPendingToolCalls && sharedState.debugPendingToolCalls.length > 0) {
          const pendingCalls = sharedState.debugPendingToolCalls;
          // After one call in a model-produced batch, expose the next call as its
          // own BEFORE boundary. Advancing from AFTER call N to BEFORE call N+1
          // intentionally performs no side effect.
          if (
            singleStep
            && sharedState.debugBoundary?.operation === 'tool'
            && sharedState.debugBoundary.phase === 'after'
          ) {
            const nextCall = pendingCalls[0];
            pauseForDebug(sharedState, emit, {
              phase: 'before-tool',
              boundary: {
                operation: 'tool',
                phase: 'before',
                nodeId: sharedState.currentNodeId,
                toolCalls: [nextCall],
                ...(toolNodeIdsFor(sharedState, [nextCall]) ? { toolNodeIds: toolNodeIdsFor(sharedState, [nextCall]) } : {}),
                ...(latestModelInput(sharedState) ? { modelInput: latestModelInput(sharedState) } : {}),
              },
            });
            FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
            try {
              sharedState.updatedAt = Date.now();
              await persistState(storageKey, sharedState);
            } catch (error) {
              log.error(`Failed to save before-tool debugger boundary for conv ${effectiveConvId}:`, error);
            }
            break;
          }

          const callsToExecute = singleStep ? pendingCalls.slice(0, 1) : pendingCalls;
          const remainingCalls = pendingCalls.slice(callsToExecute.length);
          sharedState.debugPendingToolCalls = remainingCalls.length > 0 ? remainingCalls : undefined;
          log.info(`[Debug Step] Executing ${callsToExecute.length} pending tool call(s) for conv ${effectiveConvId}.`);
          const toolProcessingResult = await processToolCallsRecoverably({
            toolCalls: callsToExecute, toolNameMap: sharedState.toolNameMap, offeredToolNames: sharedState.offeredToolNames, emit,
            // Run-resource auto-capture: ephemeral (subflow-child) runs never
            // write resources — same policy as persistConversationState.
            conversationId: sharedState.ephemeral ? undefined : sharedState.conversationId,
            runId: logicalRunId,
            node: sharedState.currentNodeId ? { nodeId: sharedState.currentNodeId } : undefined,
            shouldAbort: runCancelled,
            mcpNodes: sharedState.currentMCPNodes, // Issue #239: native resource tools
          }, true);
          if (!toolProcessingResult.success) {
            log.error(`Debug tool processing failed for conv ${effectiveConvId}`, { error: toolProcessingResult.error });
            sharedState.lastResponse = { success: false, error: 'Tool processing failed', errorDetails: toolProcessingResult.error };
            currentAction = ERROR_ACTION;
            break;
          }
          const nextModelPreview = remainingCalls.length === 0
            ? await previewNextModelInput(sharedState, effectiveConvId)
            : null;
          const afterToolBoundary: BoundaryDetails = {
            operation: 'tool',
            phase: 'after',
            nodeId: sharedState.currentNodeId,
            toolCalls: callsToExecute,
            ...(toolNodeIdsFor(sharedState, callsToExecute) ? { toolNodeIds: toolNodeIdsFor(sharedState, callsToExecute) } : {}),
            ...(remainingCalls.length === 0 ? { nextOperation: 'model' as const } : {}),
            ...(nextModelPreview?.modelInput
              ? { modelInput: nextModelPreview.modelInput }
              : latestModelInput(sharedState)
                ? { modelInput: latestModelInput(sharedState) }
                : {}),
          };
          const attachedAfterTool = await pauseForAttachAtSafePoint(sharedState, emit, effectiveConvId, storageKey, 'after-tool', afterToolBoundary);
          if (singleStep && !attachedAfterTool) {
            log.info(`[Debug Step] Paused after tool execution for conv ${effectiveConvId}.`);
            pauseForDebug(sharedState, emit, { phase: 'after-tool', boundary: afterToolBoundary });
          }
          if (singleStep || attachedAfterTool) break;
          continue;
        }

        if (!actionReadyFromDebugPause) {
        // Breakpoint check (node-scoped; `tool:` breakpoints are evaluated after
        // the model returns, before any resulting action is applied).
        const armedNodeBreakpoints = nodeBreakpoints(sharedState.breakpoints);
        const attachArmed = hasAttachRequest(sharedState);
        if (!singleStep && (armedNodeBreakpoints.length > 0 || attachArmed)) {
          const nextNodeId = await FlowExecutor.peekNextNodeId(sharedState);
          // '*' is a one-shot "attach" breakpoint set by the Debugger button
          // (setBreakpoints(convId, ['*'])): pause before whatever node comes
          // next, then consume the sentinel so a subsequent Continue resumes
          // normally instead of re-pausing at every node.
          const wildcard = attachArmed;
          const hit = !!nextNodeId && (wildcard || armedNodeBreakpoints.includes(nextNodeId));
          if (hit && (attachArmed || sharedState.lastBreakNodeId !== nextNodeId)) {
            if (wildcard) {
              consumeAttachRequest(sharedState);
            }
            log.info(`Breakpoint hit at node ${nextNodeId}${wildcard ? ' (attach)' : ''} for conv ${effectiveConvId}. Pausing.`);
            sharedState.lastBreakNodeId = nextNodeId;
            const modelPreview = await previewNextModelInput(sharedState, effectiveConvId);
            pauseForDebug(sharedState, emit, {
              reason: 'breakpoint',
              phase: 'before-node',
              nodeId: nextNodeId,
              kind: wildcard ? 'attach' : 'node',
              boundary: {
                operation: 'node',
                phase: 'before',
                nodeId: nextNodeId,
                ...(modelPreview?.nodeId === nextNodeId
                  ? { modelInput: modelPreview.modelInput }
                  : {}),
              },
            });
            try {
              sharedState.updatedAt = Date.now();
              await persistState(storageKey, sharedState); // chokepoint refuses ephemeral states
            } catch (error) {
              log.error(`Failed to save state on breakpoint for conv ${effectiveConvId}:`, error);
            }
            break;
          } else if (nextNodeId && sharedState.lastBreakNodeId && nextNodeId !== sharedState.lastBreakNodeId) {
            sharedState.lastBreakNodeId = undefined;
          }
        }

        // A debugger-started user turn stops before its very first executable
        // node. Older debugger sessions did not carry a boundary cursor, so key
        // this only to the fresh user turn instead of treating every missing
        // cursor as an initial pause (backward-compatible resumes still run).
        if (singleStep && userTurn && internalIterations === 1) {
          const nextNodeId = await FlowExecutor.peekNextNodeId(sharedState);
          if (nextNodeId) {
            const modelPreview = await previewNextModelInput(sharedState, effectiveConvId);
            pauseForDebug(sharedState, emit, {
              phase: 'before-node',
              nodeId: nextNodeId,
              boundary: {
                operation: 'node',
                phase: 'before',
                nodeId: nextNodeId,
                ...(modelPreview?.nodeId === nextNodeId
                  ? { modelInput: modelPreview.modelInput }
                  : {}),
              },
            });
            FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
            try {
              sharedState.updatedAt = Date.now();
              await persistState(storageKey, sharedState);
            } catch (error) {
              log.error(`Failed to save initial before-node debug boundary for conv ${effectiveConvId}:`, error);
            }
            break;
          }
        }

        if (sharedState.messages.length > 0) {
          const lastFewMessages = sharedState.messages.slice(-3);
          log.verbose(`Message history before step ${internalIterations}`, lastFewMessages);
        } else {
          log.verbose(`No messages in history before step ${internalIterations}`);
        }

        // 2a. Execute one step of the flow. Recovery checkpoints deliberately
        // order journal append before snapshot persistence, so a restart can
        // always select the latest fully committed safe boundary. With
        // low-latency saves on, step boundaries reach disk with the next full
        // save; tool checkpoints never wait (see RecoveryDurability).
        const checkpointNodeId = await FlowExecutor.peekNextNodeId(sharedState)
          ?? sharedState.currentNodeId;
        await commitRecoveryCheckpoint(storageKey, sharedState, {
          phase: 'node:before',
          nodeId: checkpointNodeId,
          safe: true,
          durability: 'untilNextSave',
        }, recoveryEmit);
        const assistantMessageIdBeforeStep = [...sharedState.messages].reverse().find(
          message => message.role === 'assistant',
        )?.id;
        const stepResult = await FlowExecutor.executeStep(sharedState, emit);
        if (sequenceFailure) throw sequenceFailure;
        sharedState = stepResult.sharedState;
        currentAction = stepResult.action;
        emitNewMessages();
        if (currentAction === HUMAN_APPROVAL_ACTION) {
          const asked = sharedState.pendingToolCalls ?? [];
          await holdForApproval(asked, asked, true);
          break;
        }
        if (currentAction !== ERROR_ACTION) {
          await commitRecoveryCheckpoint(storageKey, sharedState, {
            phase: 'node:after',
            nodeId: checkpointNodeId,
            safe: true,
            durability: 'untilNextSave',
          }, recoveryEmit);
        }
        sharedState.updatedAt = Date.now();
        if (isDefaultConversationTitle(sharedState.title) && sharedState.messages.length > 0) {
          const firstUserMessage = sharedState.messages.find(m => m.role === 'user');
          if (firstUserMessage && typeof firstUserMessage.content === 'string') {
            sharedState.title = buildConversationTitle(firstUserMessage.content);
            log.verbose(`Updated conversation title for ${effectiveConvId} after step ${internalIterations} to: ${sharedState.title}`);
          }
        }

        log.info(`Step ${internalIterations} completed for conv ${effectiveConvId}. Action: ${currentAction}`, { currentNodeId: sharedState.currentNodeId });
        log.verbose(`Shared state after step ${internalIterations}`, sharedState);

        // A Process node execution is one complete model turn. Park HERE —
        // after the assistant narration/tool arguments are durable, but before
        // tools, approvals, handoffs, or finalization consume its action. This
        // is the missing boundary that previously made Step jump straight from
        // narration to a handoff (and made Attach wait for that handoff).
        const latestAssistant = [...sharedState.messages].reverse().find(
          message => message.role === 'assistant',
        );
        const completedModelTurn =
          !!latestAssistant
          && latestAssistant.id !== assistantMessageIdBeforeStep
          && latestAssistant.processNodeId === checkpointNodeId;
        // Only inspect calls produced by this model turn. Looking backwards for
        // the last assistant with calls would re-trigger an old tool breakpoint
        // when a later assistant turn contains only final narration.
        const producedToolCalls = completedModelTurn ? latestAssistant?.tool_calls : undefined;
        const toolBreakpointName = matchedToolBreakpointName(sharedState, producedToolCalls);
        const attachRequested = hasAttachRequest(sharedState);

        if (
          currentAction !== ERROR_ACTION
          && (completedModelTurn || singleStep)
          && (singleStep || attachRequested || !!toolBreakpointName)
        ) {
          const attached = attachRequested ? consumeAttachRequest(sharedState) : false;
          const pendingCalls = currentAction === TOOL_CALL_ACTION
            ? requireFunctionToolCalls(producedToolCalls).filter((call) => !isHandoffToolCall(call))
            : undefined;
          const debugHandoff = ![
            ERROR_ACTION,
            FINAL_RESPONSE_ACTION,
            TOOL_CALL_ACTION,
            STAY_ON_NODE_ACTION,
          ].includes(currentAction)
            ? await FlowExecutor.resolveHandoff(sharedState, currentAction)
            : undefined;
          const isHandoff = debugHandoff?.isSuccessorEdge === true;
          // Start/static/control nodes have no meaningful internal work to stop
          // between their AFTER boundary and their outgoing edge. A Step across
          // one of those nodes therefore applies the graph transition and parks
          // at the target node, where the next Process input can be inspected.
          const transparentControlHandoff = singleStep && !completedModelTurn && isHandoff;
          steppedThroughControlNode = transparentControlHandoff;

          // Without approvals, the next Step executes exactly this captured
          // batch and pauses after its results. With approvals enabled, retain
          // the action instead so resuming still passes through the approval
          // approval gate rather than accidentally bypassing it.
          if (!transparentControlHandoff) {
            if (pendingCalls?.length && !approvalForBatch(sharedState) && !pendingCalls.some((call) => stepRequiresApproval(sharedState, call))) {
              sharedState.debugPendingToolCalls = pendingCalls;
            } else {
              sharedState.debugPendingAction = {
                action: currentAction,
                nodeId: checkpointNodeId,
                phase: 'after-model',
              };
            }

            const boundary: BoundaryDetails = isHandoff
            ? {
                operation: 'handoff',
                phase: 'before',
                nodeId: checkpointNodeId,
                edgeId: currentAction,
                ...(debugHandoff.targetNodeId ? { targetNodeId: debugHandoff.targetNodeId } : {}),
                ...(producedToolCalls?.length ? { toolCalls: producedToolCalls } : {}),
                previousOperation: completedModelTurn ? 'model' : 'node',
                ...(latestModelInput(sharedState) ? { modelInput: latestModelInput(sharedState) } : {}),
              }
            : pendingCalls?.length
              ? {
                  operation: 'tool',
                  phase: 'before',
                  nodeId: checkpointNodeId,
                  toolCalls: [pendingCalls[0]],
                  ...(toolNodeIdsFor(sharedState, [pendingCalls[0]])
                    ? { toolNodeIds: toolNodeIdsFor(sharedState, [pendingCalls[0]]) }
                    : {}),
                  previousOperation: 'model',
                  ...(latestModelInput(sharedState) ? { modelInput: latestModelInput(sharedState) } : {}),
                }
              : {
                  operation: 'node',
                  phase: 'after',
                  nodeId: checkpointNodeId,
                  ...(completedModelTurn && latestModelInput(sharedState) ? { modelInput: latestModelInput(sharedState) } : {}),
                };
            pauseForDebug(sharedState, emit, {
              reason: attached || toolBreakpointName ? 'breakpoint' : 'debug',
              phase: isHandoff
                ? 'before-handoff'
                : pendingCalls?.length
                  ? 'before-tool'
                  : 'after-node',
              nodeId: checkpointNodeId,
              kind: attached ? 'attach' : toolBreakpointName ? 'tool' : undefined,
              ...(toolBreakpointName ? { toolName: toolBreakpointName } : {}),
              boundary,
            });
            FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
            try {
              sharedState.updatedAt = Date.now();
              await persistState(storageKey, sharedState);
            } catch (error) {
              log.error(`Failed to save state at post-model debug boundary for conv ${effectiveConvId}:`, error);
            }
            break;
          }
        }
        }

        log.debug(`[Action Handling] Step ${internalIterations}: Received action "${currentAction}" for conv ${effectiveConvId}`);

        if (!currentAction) {
          sharedState.lastResponse = { success: false, error: 'Execution reached action handling without a node action.' };
          currentAction = ERROR_ACTION;
        }

        // 2b. Handle the action returned by the step
        if (currentAction === ERROR_ACTION) {
          log.info(`[Action Handling] Step ${internalIterations}: Handling ERROR_ACTION for conv ${effectiveConvId}`);
          log.error(`Error action received during step ${internalIterations} for conv ${effectiveConvId}`, { error: sharedState.lastResponse });
          break;
        }

        // #1419: the step that fetched a missing answer is done. Follow the
        // hand-off to Finish it postponed; if the model still wrote nothing,
        // the reply says so in words instead of being empty.
        if (currentAction === FINAL_RESPONSE_ACTION && sharedState.finishAnswerTurn) {
          const { edgeId, nodeId } = sharedState.finishAnswerTurn;
          sharedState.finishAnswerTurn = undefined;
          if (lacksFinishAnswer(sharedState.lastResponse, undefined, sharedState.messages)) {
            log.warn(`[#1419] Model wrote no answer when asked again for conv ${effectiveConvId}; replying that it gave none.`);
            markNoAnswer(sharedState.messages, nodeId);
            sharedState.lastResponse = NO_ANSWER_TEXT;
          }
          currentAction = edgeId;
        }

        if (currentAction === FINAL_RESPONSE_ACTION) {
          log.info(`[Action Handling] Step ${internalIterations}: Handling FINAL_RESPONSE_ACTION for conv ${effectiveConvId}`);
          log.info(`Final response action received at step ${internalIterations} for conv ${effectiveConvId}`);

          // Self-orchestrating adapters execute meeting_control locally inside
          // one provider call. When they return, do not let unattended routing,
          // steering, or another graph step reopen the participant's turn.
          if (isMeetingTurnSilent(sharedState.meetingTurn)) {
            sharedState.status = 'completed';
            log.info(`Meeting silence completed the current round turn for conv ${effectiveConvId}.`);
            break;
          }

          // Graceful landing (issue #253): this FINAL_RESPONSE is the forced
          // text-only summary we requested when the turn budget was spent. Mark
          // the run `capped` (a success-like terminal state distinct from error,
          // so captureVariable/lastOutput chaining still fires on the summary)
          // and finish — do NOT drive forward or drain steering; the plane has
          // landed on purpose.
          if (sharedState.forceSummaryTurn) {
            sharedState.forceSummaryTurn = false;
            sharedState.capped = true;
            sharedState.status = 'capped';
            log.info(`[#253] Graceful landing complete for conv ${effectiveConvId}; status=capped.`);
            break;
          }

          // Unattended safety net (issue #218): a Process node that ended its
          // turn on plain text (no tool call / handoff) would silently complete
          // the run here. In unattended mode, drive it forward along its single
          // non-returning successor instead (or nudge on ambiguity), so a model
          // that "narrates and stops" can't dead-end the flow halfway. Returns
          // 'complete' for interactive runs, finish nodes, and genuine leaves —
          // preserving today's behavior for everything except the stall case.
          const driven = await unattendedDriveForward(sharedState, emit, unattendedNudges);
          if (driven === 'advanced') {
            emitNewMessages();
            FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
            continue;
          }
          if (driven === 'nudged') {
            emitNewMessages();
            FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
            continue;
          }

          // Mid-run steering, last call: a message posted while the model was
          // producing this final response would otherwise be stranded in the
          // inbox with the run already over. Fold it in and keep going — the
          // user asked the running agent something, so the running agent
          // answers it rather than making them re-send into a fresh turn.
          if (await drainSteering(sharedState, effectiveConvId, emitNewMessages)) {
            log.info(`Steering message arrived as ${effectiveConvId} was completing; continuing the run to answer it.`);
            FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
            continue;
          }

          if (await waitForActiveSubflows(sharedState, runtimeAbortSignal)) {
            if (await drainSteering(sharedState, effectiveConvId, emitNewMessages)) continue;
          }
          if (runCancelled()) break;
          sharedState.status = 'completed';
          log.info(`Setting conversation status to 'completed' for conv ${effectiveConvId}`);
          break;
        }

        if (currentAction === TOOL_CALL_ACTION) {
          log.info(`[Action Handling] Step ${internalIterations}: Handling TOOL_CALL_ACTION for conv ${effectiveConvId}`);
          log.info(`Tool call action received at step ${internalIterations} for conv ${effectiveConvId}`);
          // In a staged handoff, approvals or prior tool results may follow the
          // owning assistant turn. Locate that turn explicitly and execute only
          // unanswered ordinary calls; handoff tools are control flow, never MCP
          // work for ModelHandler.
          const lastAssistantMsg = sharedState.handoffRequested
            ? findStagedHandoffAssistant(sharedState)
            : [...sharedState.messages].reverse().find((message) => message.role === 'assistant');
          const ordinaryToolCalls = lastAssistantMsg
            ? unansweredOrdinaryCalls(sharedState, lastAssistantMsg)
            : [];

          if (lastAssistantMsg?.role === 'assistant' && ordinaryToolCalls.length > 0) {
            if (flujo) {
              // --- Graceful landing at the agentic-turn cap (issue #253) ---
              // The R/R tool loop is where per-node maxTurns is actually enforced
              // (adapters ignore it — FLUJO drives the loop here). Count this
              // node's tool turns; once the budget is spent, DO NOT run more
              // tools — answer the pending calls synthetically and force one
              // final text-only summary turn so the run "lands the plane".
              const capNodeId = sharedState.currentNodeId;
              // A mixed batch has already selected a successor. Its ordinary
              // calls are part of that committed operation and must not be
              // discarded by the source node's agentic-turn landing cap.
              if (capNodeId && !sharedState.forceSummaryTurn && !sharedState.handoffRequested) {
                const turns = (nodeTurnCounts.get(capNodeId) ?? 0) + 1;
                nodeTurnCounts.set(capNodeId, turns);
                const cap = sharedState.turnBudgets?.[capNodeId] ?? DEFAULT_AGENTIC_MAX_TURNS;
                if (turns >= cap) {
                  log.info(`[#253] Turn budget (${cap}) reached for node ${capNodeId} on conv ${effectiveConvId}; forcing a graceful summary turn instead of executing tools.`);
                  const nowTs = Date.now();
                  // Answer every still-pending tool call synthetically so the
                  // transcript stays well-formed (unanswered tool_calls 400).
                  const cappedToolResults: FlujoChatMessage[] = ordinaryToolCalls.map((tc) => ({
                    id: crypto.randomUUID(),
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: GRACEFUL_CAP_TOOL_RESULT,
                    timestamp: nowTs,
                    processNodeId: capNodeId,
                  } as FlujoChatMessage));
                  const summaryInstruction: FlujoChatMessage = {
                    id: crypto.randomUUID(),
                    role: 'user',
                    content: GRACEFUL_CAP_SUMMARY_INSTRUCTION,
                    timestamp: nowTs + 1,
                    processNodeId: capNodeId,
                  } as FlujoChatMessage;
                  sharedState.messages.push(...cappedToolResults, summaryInstruction);
                  sharedState.forceSummaryTurn = true;
                  sharedState.cappedReason = 'maxTurns';
                  FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
                  emitNewMessages();
                  if (!sharedState.ephemeral) {
                    try {
                      await appendRawForState(
                        sharedState,
                        [...cappedToolResults, summaryInstruction].map((m) => ({ type: 'message', message: m, messageOrigin: 'internal' })),
                      );
                    } catch (err) {
                      log.warn(`Failed to append graceful-cap messages to log for ${effectiveConvId}`, err);
                    }
                  }
                  continue;
                }
              }
              // --- Flujo=true: Handle optional approval ---
              const approvalOn = approvalForBatch(sharedState), heldCalls = approvalOn ? ordinaryToolCalls : ordinaryToolCalls.filter((call) => stepRequiresApproval(sharedState, call));
              const rejectedLive = heldCalls.length > 0 ? await decideHeldCallsLive(sharedState, runtimeAbortSignal, emitNewMessages, heldCalls) : undefined;
              if ((approvalOn || heldCalls.length > 0) && !rejectedLive) {
                await holdForApproval(heldCalls, ordinaryToolCalls, !approvalOn);
                break;
              } else {
                const runnableCalls = rejectedLive
                  ? ordinaryToolCalls.filter((call) => !rejectedLive.has(call.id))
                  : ordinaryToolCalls;
                log.info(`[flujo=true] Processing ${runnableCalls.length} tools internally for conv ${effectiveConvId}`);
                const toolProcessingResult = await processToolCallsRecoverably({
                  toolCalls: runnableCalls, toolNameMap: sharedState.toolNameMap, offeredToolNames: sharedState.offeredToolNames, emit,
                  conversationId: sharedState.ephemeral ? undefined : sharedState.conversationId,
                  runId: logicalRunId,
                  node: sharedState.currentNodeId ? { nodeId: sharedState.currentNodeId } : undefined,
                  shouldAbort: runCancelled,
                  mcpNodes: sharedState.currentMCPNodes, // Issue #239: native resource tools
                  unattended: sharedState.unattended, // Issue #258
                });

                if (!toolProcessingResult.success) {
                  log.error(`Internal tool processing failed for conv ${effectiveConvId}`, { error: toolProcessingResult.error });
                  sharedState.lastResponse = { success: false, error: 'Tool processing failed', errorDetails: toolProcessingResult.error };
                  currentAction = ERROR_ACTION;
                  break;
                }

                if (isMeetingTurnSilent(sharedState.meetingTurn)) {
                  sharedState.status = 'completed';
                  currentAction = FINAL_RESPONSE_ACTION;
                  log.info(`Meeting silence stopped the agentic tool loop for conv ${effectiveConvId}.`);
                  break;
                }
                const attachedAfterTool = await pauseForAttachAtSafePoint(sharedState, emit, effectiveConvId, storageKey, 'after-tool', {
                  operation: 'tool',
                  phase: 'after',
                  nodeId: sharedState.currentNodeId,
                  toolCalls: ordinaryToolCalls,
                  ...(toolNodeIdsFor(sharedState, ordinaryToolCalls)
                    ? { toolNodeIds: toolNodeIdsFor(sharedState, ordinaryToolCalls) }
                    : {}),
                  nextOperation: 'model',
                });
                if (attachedAfterTool) break;
                if (sharedState.handoffRequested) {
                  currentAction = sharedState.handoffRequested.edgeId;
                  log.info(`[Staged Handoff] Ordinary tools completed; committing edge ${currentAction}.`);
                } else {
                  log.info(`Continuing loop for conv ${effectiveConvId} after internal tool processing (no approval needed).`);
                  continue;
                }
              }
            } else {
              // --- flujo=false: Handle internal vs external tools ---
              log.info(`[flujo=false] Tool call action received for conv ${effectiveConvId}. Checking tool types.`);
              const allToolCalls = ordinaryToolCalls;
              const internalTools: OpenAI.ChatCompletionMessageFunctionToolCall[] = [];
              const externalTools: OpenAI.ChatCompletionMessageFunctionToolCall[] = [];

              allToolCalls.forEach(tc => {
                if (tc.type === 'function' && isInternalToolName(tc.function.name, sharedState.toolNameMap)) {
                  log.verbose('tool is internal:', tc.function.name);
                  internalTools.push(tc);
                } else {
                  log.verbose('tool is external:', tc.function.name);
                  externalTools.push(tc);
                }
              });

              const heldInternalCalls = internalTools.filter((call) => stepRequiresApproval(sharedState, call));
              if (heldInternalCalls.length > 0) {
                await holdForApproval(heldInternalCalls, internalTools);
                break;
              }

              if (internalTools.length > 0) {
                log.info(`[flujo=false] Processing ${internalTools.length} internal tools for conv ${effectiveConvId}. External tools (${externalTools.length}) will be ignored this step.`);
                const toolProcessingResult = await processToolCallsRecoverably({
                  toolCalls: internalTools, toolNameMap: sharedState.toolNameMap, offeredToolNames: sharedState.offeredToolNames, emit,
                  conversationId: sharedState.ephemeral ? undefined : sharedState.conversationId,
                  runId: logicalRunId,
                  node: sharedState.currentNodeId ? { nodeId: sharedState.currentNodeId } : undefined,
                  shouldAbort: runCancelled,
                  mcpNodes: sharedState.currentMCPNodes, // Issue #239: native resource tools
                });

                if (!toolProcessingResult.success) {
                  log.error(`[flujo=false] Internal tool processing failed for conv ${effectiveConvId}`, { error: toolProcessingResult.error });
                  sharedState.lastResponse = { success: false, error: 'Internal tool processing failed', errorDetails: toolProcessingResult.error };
                  currentAction = ERROR_ACTION;
                  break;
                }

                log.info(`Continuing loop for conv ${effectiveConvId} after internal tool processing (flujo=false).`);
                continue;

              } else if (externalTools.length > 0) {
                log.info(`[flujo=false] Found ${externalTools.length} external tools for conv ${effectiveConvId}. Wrapping in XML and returning.`);

                const xmlToolStrings: string[] = [];
                for (const toolCall of externalTools) {
                  if (toolCall.type === 'function') {
                    try {
                      const args = JSON.parse(toolCall.function.arguments || '{}');
                      let paramsXml = '';
                      for (const key in args) {
                        const value = String(args[key]).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');                      paramsXml += `\n<${key}>${value}</${key}>`;
                      }
                      xmlToolStrings.push(`<${toolCall.function.name}>${paramsXml}\n</${toolCall.function.name}>`);
                    } catch (parseError) {
                      log.error(`[flujo=false] Failed to parse arguments for external tool ${toolCall.function.name}`, { args: toolCall.function.arguments, error: parseError, convId: effectiveConvId });
                      xmlToolStrings.push(`<${toolCall.function.name}>\n<error>Failed to parse arguments: ${parseError instanceof Error ? parseError.message : String(parseError)}</error>\n</${toolCall.function.name}>`);
                    }
                  }
                }

                sharedState.lastResponse = {
                  _flujo_xml_tools: xmlToolStrings.join('\n\n'),
                };

                currentAction = FINAL_RESPONSE_ACTION;
                log.info(`[flujo=false] Prepared XML for external tools. Exiting loop for conv ${effectiveConvId}.`);
                break;

              } else {
                log.warn(`[flujo=false] TOOL_CALL_ACTION received for conv ${effectiveConvId} but no tools found after classification. Treating as final.`);
                currentAction = FINAL_RESPONSE_ACTION;
                break;
              }
            }
          } else {
            log.warn(`TOOL_CALL_ACTION received for conv ${effectiveConvId} but no tool_calls found in last message. Treating as final.`);
            currentAction = FINAL_RESPONSE_ACTION;
            break;
          }
        }

        // Check if action is an edgeId (Handoff).
        const handoff = await FlowExecutor.resolveHandoff(sharedState, currentAction);

        if (handoff.isSuccessorEdge) {
          log.info(`[Action Handling] Step ${internalIterations}: Handling Handoff Action (Edge ID) for conv ${effectiveConvId}`);
          log.info(`Handoff action received for conv ${effectiveConvId}. Edge: ${currentAction}`);
          const nextNodeId = handoff.targetNodeId;
          if (typeof nextNodeId === 'string' && nextNodeId.length > 0) {

            // Reset any caller handoff input at the transition: it is single-shot
            // and scoped to exactly ONE target node. The block below re-sets it
            // for `nextNodeId` when this handoff carries caller args. Clearing it
            // here (rather than relying on the target's prep to consume it) keeps
            // it from leaking to a later node or a REVISIT of the same node — a
            // process node reads it WITHOUT clearing (its tool loop re-runs prep
            // each iteration), so its lifecycle is managed here instead.
            // Clear only after preparation admission succeeds, so a refusal
            // preserves the canonical pending handoff and assistant call IDs.

            // Ordinary tool results may now sit after the assistant batch. Keep
            // the handoff bound to the turn that originally selected this edge.
            const lastAssistantMsg = sharedState.handoffRequested
              ? findStagedHandoffAssistant(sharedState)
              : [...sharedState.messages].reverse().find((message) => message.role === 'assistant');
            const isSubflowHandoff = sharedState.handoffTargetTypes?.[nextNodeId] === 'subflow';
            const prepareHandoff = async (budget?: SubflowPreparationBudget) => {
            if (budget) {
              // Losing targets also allocate acknowledgements. Admit the complete
              // original batch before filtering it into winning/losing calls.
              assertSubflowLaneCount(lastAssistantMsg?.tool_calls?.length ?? 0);
              preflightSubflowHandoffArguments(requireFunctionToolCalls(lastAssistantMsg?.tool_calls), budget);
            }
            // A later deterministic edge can follow a completed handoff turn,
            // for example when a user resumes after Finish. Its existing result
            // must not be duplicated or its old caller brief captured again.
            const answeredCallIds = new Set(sharedState.messages
              .filter((message) => message.role === 'tool')
              .map((message) => message.tool_call_id));
            const handoffCallsForBoundary = lastAssistantMsg?.role === 'assistant'
              ? requireFunctionToolCalls(lastAssistantMsg.tool_calls).filter(
                  (call) => isHandoffToolCall(call) && !answeredCallIds.has(call.id),
                )
              : undefined;

            if (handoffCallsForBoundary?.length) {
              const allHandoffCalls = handoffCallsForBoundary ?? [];
              // Spawn-with-brief (issue #156): the routing model may call the SAME
              // handoff tool several times in one turn — each call is one spawned
              // lane of the target sub-agent, briefed by its `task` argument. So
              // the capture walks EVERY handoff call that resolves to the chosen
              // target (via handoffNameMap; legacy names embed the node id), not
              // just the first one, and answers each with its own tool result so
              // the transcript stays well-formed (one result per tool_call id).
              const resolveCallTarget = (name: string): string =>
                sharedState.handoffNameMap?.[name] || name.replace('handoff_to_', '');
              const matchingCalls = allHandoffCalls.filter(
                tc => tc.type === 'function' && resolveCallTarget(tc.function.name) === nextNodeId
              );
              // Defensive: an edge chosen without a decodable matching call (e.g.
              // a deterministic-condition route after a tool-call turn) keeps the
              // legacy "first handoff call" pairing so its result never dangles.
              const callsToAnswer = matchingCalls.length > 0 ? matchingCalls : allHandoffCalls.slice(0, 1);

              if (callsToAnswer.length === 0) {
                log.warn(`Handoff action received for edge ${currentAction}, but could not find corresponding handoff tool call in last assistant message.`);
              }

              // Capture caller-supplied handoff input: `prompt` (issue #96,
              // single-call caller prompt), `task` briefs (issue #156 spawns —
              // one per call), and the legacy `parallelFlows`/`concurrencyLimit`
              // (issue #130; no tool exposes them anymore but a resumed old
              // conversation may still send them). Single-shot and node-id-scoped;
              // the target node's prep consumes and clears it. A malformed args
              // string must NEVER break routing — parse defensively per call.
              const briefs: string[] = [];
              const sessionKeys: Array<string | null> = [];
              let callerPrompt = '';
              let signalBody = '';
              let callerFlows: string[] | undefined;
              let callerConcurrency: number | undefined;
              // Reject excessive argument work before any JSON allocation or
              // tool acknowledgement. The defensive parse catch below must
              // never swallow a capacity refusal and silently discard jobs.
              const captureHandoffCalls = () => callsToAnswer.forEach((call, laneIdx) => {
                if (call.type === 'function') {
                  try {
                    const parsedArgs = JSON.parse(call.function.arguments || '{}');
                    const task = typeof parsedArgs?.task === 'string' ? parsedArgs.task.trim() : '';
                    const prompt = typeof parsedArgs?.prompt === 'string' ? parsedArgs.prompt.trim() : '';
                    const body = typeof parsedArgs?.body === 'string' ? parsedArgs.body.trim() : '';
                    if (!signalBody && body) signalBody = body;
                    // `task` is always a spawn brief; a `prompt` on a MULTI-call
                    // turn clearly means per-instance instructions too. On a
                    // single-call turn `prompt` keeps its issue-#96 meaning.
                    const brief = task || (callsToAnswer.length > 1 ? prompt : '');
                    // Every Subflow handoff call is one queued job, even when it
                    // omits `task` and therefore uses the node's configured input.
                    // Other target types retain the old non-empty-only behavior.
                    if (isSubflowHandoff || brief) {
                      briefs.push(brief);
                      const sessionKey = normalizeSessionKey(parsedArgs?.sessionKey);
                      sessionKeys.push(sessionKey ?? null);
                      if (parsedArgs?.sessionKey !== undefined && !sessionKey) {
                        log.warn('Ignoring invalid Subflow sessionKey; this job will use fresh/per-node behavior', {
                          targetNodeId: nextNodeId,
                          lane: laneIdx + 1,
                        });
                      }
                    }
                    if (!callerPrompt && prompt) callerPrompt = prompt;
                    if (!callerFlows && Array.isArray(parsedArgs?.parallelFlows)) {
                      const flows = parsedArgs.parallelFlows.filter(
                        (f: unknown): f is string => typeof f === 'string' && f.trim() !== '',
                      );
                      if (flows.length > 0) callerFlows = flows;
                    }
                    const rawLimit = parsedArgs?.concurrencyLimit;
                    if (callerConcurrency === undefined && typeof rawLimit === 'number' && rawLimit >= 1) {
                      callerConcurrency = Math.floor(rawLimit);
                    }
                  } catch (parseError) {
                    log.warn(`Could not parse handoff tool-call arguments for edge ${currentAction}; ignoring caller input for this call`, { parseError });
                  }
                }
                sharedState.messages.push({
                  id: crypto.randomUUID(),
                  role: 'tool',
                  tool_call_id: call.id,
                  content: JSON.stringify({
                    status: 'Handoff processed',
                    targetNodeId: nextNodeId,
                    ...(callsToAnswer.length > 1 ? { lane: laneIdx + 1, laneCount: callsToAnswer.length } : {}),
                  }),
                  timestamp: Date.now(),
                  processNodeId: sharedState.currentNodeId,
                });
              });
              if (isSubflowHandoff) {
                  for (const call of callsToAnswer) {
                    let args: { concurrencyLimit?: unknown; parallelFlows?: unknown };
                    try { args = JSON.parse(call.function.arguments || '{}'); }
                    catch { continue; }
                    if (typeof args?.concurrencyLimit === 'number') subflowWorkerLimit(args.concurrencyLimit);
                    if (Array.isArray(args?.parallelFlows)) assertSubflowLaneCount(args.parallelFlows.length);
                  }
                  sharedState.handoffInput = undefined;
                  captureHandoffCalls();
              } else { sharedState.handoffInput = undefined; captureHandoffCalls(); }
              // Handoff calls that targeted a DIFFERENT node lost the route (one
              // successor wins per turn). Answer them too — a tool_call id
              // without a result corrupts the persisted transcript — with an
              // explicit not-executed status. (All handoff plumbing is stripped
              // from the model wire either way.)
              for (const call of allHandoffCalls) {
                if (callsToAnswer.includes(call)) continue;
                sharedState.messages.push({
                  id: crypto.randomUUID(),
                  role: 'tool',
                  tool_call_id: call.id,
                  content: JSON.stringify({ status: 'Not executed', reason: 'A different handoff was chosen this turn.' }),
                  timestamp: Date.now(),
                  processNodeId: sharedState.currentNodeId,
                });
                log.warn(`Handoff call ${call.type === 'function' ? call.function.name : call.id} targeted a different node than the chosen route; answered as not executed.`);
              }
              // A lone brief also serves as the caller prompt so a single
              // `task`-style call still drives an isolated allowCallerPrompt
              // subflow that never opted into spawning.
              if (!callerPrompt && briefs.length === 1) callerPrompt = briefs[0];
              const isSignalHandoff = sharedState.handoffTargetTypes?.[nextNodeId] === 'signal';
              const hasCallerSessionKey = sessionKeys.some((key) => key !== null);
              if (isSignalHandoff || signalBody || callerPrompt || briefs.length > 0 || hasCallerSessionKey || (callerFlows && callerFlows.length > 0)) {
                sharedState.handoffInput = {
                  targetNodeId: nextNodeId,
                  prompt: callerPrompt,
                  ...(isSignalHandoff ? { fromHandoffTool: true } : {}),
                  ...(signalBody ? { signalBody } : {}),
                  ...(briefs.length > 0 ? { tasks: briefs } : {}),
                  ...(hasCallerSessionKey ? { sessionKeys } : {}),
                  ...(callerFlows && callerFlows.length > 0 ? { parallelFlows: callerFlows } : {}),
                  ...(callerConcurrency !== undefined ? { concurrencyLimit: callerConcurrency } : {}),
                };
                log.info(`Captured caller handoff input for node ${nextNodeId}`, {
                  promptChars: callerPrompt.length,
                  signalBodyChars: signalBody.length,
                  spawnBriefs: briefs.length,
                  sessionKeys: sessionKeys.filter((key) => key !== null).length,
                  fanoutCount: callerFlows?.length ?? 0,
                });
              } else {
                // Issue #169 belt-and-suspenders: a handoff to an isolated,
                // non-fanout, allowCallerPrompt subflow that has NO authored
                // promptTemplate WITHOUT a caller-supplied prompt (a provider
                // ignored the schema `required` we now emit in
                // ProcessNode.generateHandoffTools) would start the subflow with
                // an empty prompt and stall silently. Surface a clear, actionable
                // warning instead of proceeding quietly.
                try {
                  const handoffFlow = sharedState.flowSnapshot
                    ?? await flowService.getFlow(sharedState.flowId);
                  const targetNode = handoffFlow?.nodes?.find(n => n.id === nextNodeId);
                  const targetProps = targetNode?.data?.properties as { inputMode?: string; allowCallerPrompt?: boolean; allowCallerFanout?: boolean; promptTemplate?: string; isolatedPrompt?: string } | undefined;
                  // The target's authored isolated message: promptTemplate for a
                  // subflow, isolatedPrompt for a process node (issue #96).
                  const authoredIsolated =
                    targetNode?.type === 'subflow' ? targetProps?.promptTemplate : targetProps?.isolatedPrompt;
                  if (
                    (targetNode?.type === 'subflow' || targetNode?.type === 'process') &&
                    targetProps?.inputMode === 'isolated' &&
                    targetProps?.allowCallerPrompt !== false &&
                    targetProps?.allowCallerFanout !== true &&
                    !(authoredIsolated?.trim())
                  ) {
                    log.warn(
                      `Handoff to isolated ${targetNode?.type} node ${nextNodeId} has neither a caller-supplied prompt nor an authored message; the target will start with an empty prompt and may stall. The routing model should have supplied the required "prompt" argument (issue #169).`,
                      { targetNodeId: nextNodeId },
                    );
                  }
                } catch (guardErr) {
                  log.debug('Issue #169 empty-prompt handoff guard check failed (non-fatal)', { guardErr });
                }
              }

              // NOTE: we no longer append a synthetic "The handoff was
              // successful. Continue" user message. The receiving node now
              // builds its model context via buildNodeContext('scoped'), which
              // strips this handoff tool-call/result so the model sees a clean
              // conversation ending on the real task and responds naturally.
              // See ~/.claude/plans/execution-core-v2.md.
            } else {
              sharedState.handoffInput = undefined;
              log.warn(`Handoff action received for edge ${currentAction}, but the last message was not an assistant message with tool calls.`);
            }
            return handoffCallsForBoundary;
            };
            const handoffCallsForBoundary = isSubflowHandoff
              ? await withSubflowPreparationBudget(prepareHandoff) : await prepareHandoff();

            // #1419: a hand-off to Finish with no answer would end the run with
            // an empty reply. Take the answer from the call's arguments, or ask
            // this step once more, without tools, before going to Finish.
            if (
              handoff.targetNodeType === 'finish'
              && handoffCallsForBoundary?.length
              && sharedState.currentNodeId
              && !(sharedState.meetingParticipant && sharedState.meetingTurn)
              && lacksFinishAnswer(sharedState.lastResponse, lastAssistantMsg, sharedState.messages)
            ) {
              const fromArguments = answerFromHandoffArguments(handoffCallsForBoundary);
              if (fromArguments) {
                log.info(`[#1419] Hand-off to Finish carried its answer as an argument for conv ${effectiveConvId}.`);
                sharedState.messages.push({
                  id: crypto.randomUUID(),
                  role: 'assistant',
                  content: fromArguments,
                  timestamp: Date.now(),
                  processNodeId: sharedState.currentNodeId,
                });
                sharedState.lastResponse = fromArguments;
              } else {
                log.info(`[#1419] Hand-off to Finish without an answer for conv ${effectiveConvId}; asking node ${sharedState.currentNodeId} once more without tools.`);
                sharedState.finishAnswerTurn = { nodeId: sharedState.currentNodeId, edgeId: currentAction };
                sharedState.handoffRequested = undefined;
                emitNewMessages();
                FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
                continue;
              }
            }

            emitNewMessages();
            const fromNodeId = sharedState.currentNodeId;
            const advancedSubflow = acknowledgeSubflowContinuation(sharedState, fromNodeId);
            // The engine marks only Process -> one-way TERMINAL Subflow calls.
            // Sequential Subflows and explicit bidirectional edges omit this,
            // and every later transition clears any previous marker.
            sharedState.pendingSubflowReturn = handoff.implicitSubflowReturn;
            sharedState.currentNodeId = nextNodeId;
            if (advancedSubflow) await persistConversationState(storageKey, sharedState);
            sharedState.handoffRequested = undefined;
            emit({
              type: 'handoff',
              from: fromNodeId ? { nodeId: fromNodeId } : undefined,
              toNodeId: nextNodeId,
              edgeId: currentAction,
            });
            log.info(`Transitioning conv ${effectiveConvId} to node ${sharedState.currentNodeId}`);
            FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
            if (singleStep) {
              const modelPreview = await previewNextModelInput(sharedState, effectiveConvId);
              log.info(`[Debug Step] Paused at handoff target node ${sharedState.currentNodeId} for conv ${effectiveConvId}.`);
              pauseForDebug(sharedState, emit, {
                phase: steppedThroughControlNode ? 'before-node' : 'after-handoff',
                nodeId: steppedThroughControlNode ? nextNodeId : fromNodeId,
                boundary: steppedThroughControlNode
                  ? {
                      operation: 'node',
                      phase: 'before',
                      nodeId: nextNodeId,
                      edgeId: currentAction,
                      ...(modelPreview?.nodeId === nextNodeId
                        ? { modelInput: modelPreview.modelInput }
                        : {}),
                    }
                  : {
                      operation: 'handoff',
                      phase: 'after',
                      nodeId: fromNodeId,
                      targetNodeId: nextNodeId,
                      edgeId: currentAction,
                      ...(handoffCallsForBoundary?.length ? { toolCalls: handoffCallsForBoundary } : {}),
                      ...(modelPreview?.nodeId === nextNodeId
                        ? { modelInput: modelPreview.modelInput, nextOperation: 'model' }
                        : { nextOperation: 'node' }),
                    },
              });
              break;
            }
            log.info(`Continuing loop for conv ${effectiveConvId} after handoff.`);
            continue;
          } else {
            log.error(`Handoff failed for conv ${effectiveConvId}: Successor node for edge ${currentAction} has invalid ID.`);
            sharedState.lastResponse = { success: false, error: `Handoff failed: Target node for edge ${currentAction} has invalid ID.` };
            currentAction = ERROR_ACTION;
            break;
          }
        }

        if (currentAction === STAY_ON_NODE_ACTION) {
          log.info(`[Action Handling] Step ${internalIterations}: Handling STAY_ON_NODE_ACTION for conv ${effectiveConvId}`);
          log.info(`Stay on node action received for conv ${effectiveConvId} at step ${internalIterations}`);
          break;
        }

        log.warn(`Unrecognized action '${currentAction}' received at step ${internalIterations} for conv ${effectiveConvId}. Treating as final response.`);
        currentAction = FINAL_RESPONSE_ACTION;
        break;

      } // --- End while loop ---
    } // --- End execution block ---

  } catch (loopError) {
    sequenceErrorCleanup = true;
    log.error(`Unhandled error during execution loop for conv ${effectiveConvId}`, { loopError });
    if (currentAction !== ERROR_ACTION && runCancelled()) {
      // A cancellation can surface as a thrown error (the model-call watch
      // aborts the in-flight provider request, which throws out of the step).
      // Report it as the standard cancellation outcome, not a provider failure.
      sharedState.status = 'error';
      sharedState.lastResponse = { success: false, error: 'Execution cancelled by user.' };
      currentAction = ERROR_ACTION;
    }
    if (currentAction !== ERROR_ACTION) {
      const modelDetails = loopError && typeof loopError === 'object' && 'details' in loopError
        ? loopError.details
        : undefined;
      sharedState.lastResponse = {
        success: false,
        error: loopError instanceof Error ? loopError.message : String(loopError),
        errorDetails: loopError instanceof Error
          ? {
              name: loopError.name,
              message: loopError.message,
              stack: loopError.stack,
              ...(modelDetails && typeof modelDetails === 'object' ? modelDetails : {}),
            }
          : undefined,
      };
      currentAction = ERROR_ACTION;
      // Issue #383 (gap 1): this loop-level catch previously set lastResponse
      // but never emitted an `error` event, so a failure caught here (as
      // opposed to inside FlowExecutor.executeStep) was silent on a live run.
      emitErrorOnce(sharedState, emit, loopError, {
        nodeId: sharedState.currentNodeId,
      });
    }
  }
  if (currentAction === ERROR_ACTION) sequenceErrorCleanup = true;

  // A cancellation that lands while the final step is completing (or one the
  // provider ignored) must not let the run report 'completed' — Stop means
  // stop, even when the model's answer won the race.
  // Evaluate cancellation even when the SDK abort became ERROR_ACTION, so its
  // durable recovery record cannot classify an intentional stop as retryable.
  if (runCancelled() && currentAction !== ERROR_ACTION) {
    log.info(`Cancellation flag set at run end for conv ${effectiveConvId}; reporting cancelled instead of '${sharedState.status}'.`);
    sharedState.status = 'error';
    sharedState.lastResponse = { success: false, error: 'Execution cancelled by user.' };
    currentAction = ERROR_ACTION;
  }

  // Reconcile status with the terminal action BEFORE the final persist.
  if (currentAction === ERROR_ACTION && sharedState.status !== 'error') {
    sharedState.status = 'error';
  }

  // Issue #383 (gap 1) backstop: guarantee that EVERY run ending in 'error'
  // produces at least one `error` event, even if none of the specific emit
  // sites above happened to fire for this particular failure shape. Skipped
  // for user cancellation (`isCancelled`) — a stop is not an error and must
  // keep rendering as the neutral "stopped" banner.
  if (
    currentAction === ERROR_ACTION
    && !sharedState.errorEventEmitted
    && !sharedState.isCancelled
  ) {
    const derived = deriveLastErrorFromLastResponse(sharedState.lastResponse);
    if (derived) {
      emitNormalizedErrorOnce(sharedState, emit, derived, { nodeId: sharedState.currentNodeId });
    }
  }

  // --- 3. Finalize ---
  // Clear elicitation context for all MCP servers bound in this run.
  for (const serverName of elicitationServerNames) {
    clearElicitationContext(serverName);
  }

  traceMark('loop.done');
  const finalExecutionTime = Date.now() - startTime;
  let finalStatus = sharedState.status || (currentAction === FINAL_RESPONSE_ACTION ? 'completed' : (currentAction === ERROR_ACTION ? 'error' : 'running'));
  const recordTerminalSequenceFailure = (error: unknown) => {
    if (!isConversationDurabilityFailure(error)) throw error;
    sequenceFailure ??= error;
    sequenceErrorCleanup = true;
    if (finalStatus !== 'error') {
      sharedState.lastResponse = { success: false, error: error.message, errorDetails: error.details };
      sharedState.status = 'error';
      currentAction = ERROR_ACTION;
      finalStatus = 'error';
      const classified = classifyRecoveryFailure(sharedState.lastResponse);
      setRecoveryTransition(sharedState, classified.classification, { failure: classified.failure,
        manualActionRequired: sharedState.recovery?.manualActionRequired });
      emitErrorOnce(sharedState, emit, error, { nodeId: sharedState.currentNodeId });
    }
  };
  log.info(`Execution finished for conv ${effectiveConvId}. Final Action: ${currentAction}, Final Status: ${finalStatus}`, { duration: `${finalExecutionTime}ms` });

  // A broken sequence or uncertain I/O suppresses further terminal events and
  // retains its fence.
  const publishTerminalEvent = async (event: Parameters<EmitFn>[0]) => {
    // Opaque emitters have no receipt and are attempted exactly once.
    const terminalEmit = input.emit ?? executionEventBus.emitterFor(effectiveConvId, accepted => {
      if (accepted.type === 'error') errorEventAdmitted = true;
      if (accepted.type === 'message' && accepted.message.id) emittedMessageIds.add(accepted.message.id);
    });
    if (!sequenceFailure) terminalEmit(event);
    if (!ephemeral) await flushConversationLog(effectiveConvId);
  };
  const terminalRecoveryEmit = input.emit ? undefined : publishTerminalEvent;
  if (finalStatus === 'error' && sharedState.lastError && !errorEventAdmitted) {
    try {
      await publishTerminalEvent({ type: 'error', message: sharedState.lastError.message, error: sharedState.lastError,
        node: sharedState.currentNodeId ? { nodeId: sharedState.currentNodeId } : undefined });
    } catch (error) { recordTerminalSequenceFailure(error); }
  }

  // Persist the precise recovery transition before the legacy terminal event.
  // Existing status values remain unchanged for backward compatibility.
  try {
    if (sharedState.isCancelled) {
      await commitRecoveryTransition(storageKey, sharedState, 'cancelled', {
        failure: {
          category: cancelledByAncestor ? 'ancestor_cancelled' : 'user_cancelled',
          message: cancelledByAncestor
            ? 'Execution was cancelled because an ancestor run was cancelled.'
            : 'Execution was cancelled by the user.',
          retryable: false,
        },
        cancellationRequestedAt: sharedState.recovery?.cancellationRequestedAt ?? Date.now(),
      }, terminalRecoveryEmit);
    } else if (finalStatus === 'completed') {
      // The final save below writes it; markConversationTerminal retries that save.
      await commitRecoveryTransition(storageKey, sharedState, 'completed', { durability: 'untilNextSave' }, terminalRecoveryEmit);
    } else if (finalStatus === 'capped') {
      await commitRecoveryTransition(storageKey, sharedState, 'capped', { durability: 'untilNextSave' }, terminalRecoveryEmit);
    } else if (finalStatus === 'awaiting_tool_approval' || finalStatus === 'paused_debug') {
      await commitRecoveryTransition(storageKey, sharedState, 'paused', {}, terminalRecoveryEmit);
    } else if (finalStatus === 'error') {
      const classified = classifyRecoveryFailure(sharedState.lastResponse);
      await commitRecoveryTransition(storageKey, sharedState, classified.classification, {
        failure: classified.failure,
        retryAfterAt: classified.retryAfterAt,
        manualActionRequired: classified.failure.category === 'tool_failure'
          ? true
          : sharedState.recovery?.manualActionRequired,
      }, terminalRecoveryEmit);
    }
  } catch (error) {
    // Preserve an existing execution error, or report a late safety failure,
    // then finish snapshot persistence/resource release without new sequences.
    recordTerminalSequenceFailure(error);
  }

  // Flush any trailing messages and signal terminal completion to live consumers.
  try {
    for (const msg of sharedState.messages) {
      if (!msg.id) msg.id = crypto.randomUUID();
      if (emittedMessageIds.has(msg.id) || msg.role === 'system') continue;
      await publishTerminalEvent({ type: 'message', message: msg, messageOrigin: 'internal',
        node: msg.processNodeId ? { nodeId: msg.processNodeId } : undefined });
      emittedMessageIds.add(msg.id);
      accumulateUsage(sharedState, emit, msg);
    }
  }
  catch (error) { recordTerminalSequenceFailure(error); }
  if (finalStatus === 'completed' || finalStatus === 'error' || finalStatus === 'capped') {
    try { await publishTerminalEvent({
      type: 'run:done',
      status: finalStatus,
      ...(finalStatus === 'error' && sharedState.lastError ? { error: sharedState.lastError } : {}),
    }); } catch (error) { recordTerminalSequenceFailure(error); }
    // Flow-run event bus (issue #116): announce terminal runs so `flow-event`
    // triggers can react to chat/API/manual runs. Scheduler-fired runs are
    // announced by SchedulerService.fire() instead (de-dup), and subflow stages
    // (runDepth > 0) must NOT emit or a composed flow sprays one event per stage.
    if (
      !getHarnessExecution() && sharedState.source !== 'schedule' &&
      sharedState.source !== 'trigger' &&
      sharedState.source !== 'meeting' &&
      (sharedState.runDepth ?? 0) === 0
    ) {
      const lastMsg = sharedState.messages[sharedState.messages.length - 1];
      const outputText =
        lastMsg && lastMsg.role === 'assistant' && typeof lastMsg.content === 'string'
          ? lastMsg.content
          : undefined;
      // A capped run is a successful terminal run for flow-event/chaining
      // purposes (issue #253): the summary IS the output, so report it as
      // 'completed' to the flow-run bus.
      void publishRunFlowEvent(sharedState, finalStatus === 'capped' ? 'completed' : finalStatus, outputText);
    }
  }

  // Debugging is run-scoped. Once this run is terminal, do not leave a hidden
  // debugMode/breakpoint payload attached to the conversation for its next user
  // turn (or paint the sidebar as though an old debug session were still live).
  if (finalStatus === 'completed' || finalStatus === 'error' || finalStatus === 'capped') {
    sharedState.debugMode = false;
    sharedState.debugPauseRequested = false;
    sharedState.debugPendingAction = undefined;
    sharedState.debugPendingToolCalls = undefined;
    sharedState.debugBoundary = undefined;
    sharedState.breakpoints = [];
    sharedState.lastBreakNodeId = undefined;
  }

  // Terminal event publication can still downgrade a successful fold to an
  // error. Retain the active visit until those sequence-sensitive emissions
  // succeed, so recovery reuses its receipt rather than dispatching new children.
  if (finalStatus === 'completed' || finalStatus === 'capped') acknowledgeSubflowContinuation(sharedState, sharedState.currentNodeId);
  let finalSnapshotPersisted = false;
  let finalSnapshotFailure: ConversationSequenceSafetyError | ConversationPublicationError | undefined;
  try {
    sharedState.updatedAt = Date.now();
    if (isDefaultConversationTitle(sharedState.title) && sharedState.messages.length > 0) {
      const firstUserMessage = sharedState.messages.find(m => m.role === 'user');
      if (firstUserMessage && typeof firstUserMessage.content === 'string') {
        sharedState.title = buildConversationTitle(firstUserMessage.content);
        log.verbose(`Updated conversation title for ${effectiveConvId} before final return to: ${sharedState.title}`);
      }
    }
    traceMark('terminal.events');
    await persistState(storageKey, sharedState); // chokepoint refuses ephemeral + deleted states
    finalSnapshotPersisted = true;
    traceMark('terminal.persisted');
    log.debug(`Saved final state for conversation ${effectiveConvId} before returning.`);
  } catch (error) {
    log.error(`Failed to save final state for conversation ${effectiveConvId}:`, error);
    if (isConversationDurabilityFailure(error)) finalSnapshotFailure = error;
  }
  // A conversation deleted mid-run must not be resurrected: the persist above is
  // already refused by the tombstone; drop the in-memory state too instead of
  // re-registering it (the DELETE handler kept it alive only so this run — and
  // descendant subflows walking the ancestor chain — could observe the cancel).
  if (isConversationDeleted(effectiveConvId)) {
    FlowExecutor.conversationStates.delete(effectiveConvId);
    forgetConversationCacheEntry(effectiveConvId);
  } else {
    FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
    noteConversationWrite(effectiveConvId, sharedState);
  }

  // --- Run-owned resource release + bounded conversation memory (issue #413) ---
  // A terminal run must not leave anything of its own alive. Two distinct leaks
  // were fixed here:
  //  1. Bash background/PTY sessions the run started stayed alive for the
  //     process lifetime, because nothing ever told the Bash server the owning
  //     run had ended. `release_owner` kills the run's non-detached sessions and
  //     their descendant trees; a session explicitly started `detached` survives
  //     on purpose.
  //  2. The conversation stayed in the global state map forever. Marking it
  //     terminal makes it evictable ONLY after its durable snapshot exists, so a
  //     later resume/inspect transparently reloads it from storage.
  // Bash cleanup remains independent. Terminal persistence retries are awaited
  // so their transcript and write allocations retain this run's admission.
  const terminalStatus =
    sharedState.status === 'completed' ||
    sharedState.status === 'error' ||
    sharedState.status === 'capped';
  if (terminalStatus) {
    if (finalSnapshotPersisted && !ephemeral && (sharedState.runDepth ?? 0) === 0) {
      try {
        await (await import('@/backend/services/harness/worker')).observeHarnessConversation(sharedState, { variables: harnessInitialVariables, source: input.source });
      } catch { log.warn('Harness evidence admission deferred after terminal persistence.'); }
    }
    const runOwnerScope = ownerScopeForRun({
      runId: sharedState.logicalRunId,
      conversationId: sharedState.conversationId || effectiveConvId,
    });
    if (!getHarnessExecution()) void releaseRunOwnedBashSessions(runOwnerScope);
    if (!isConversationDeleted(effectiveConvId) && !ephemeral) {
      await traceSpan('terminal.markTerminal', () => markConversationTerminal(effectiveConvId, sharedState, async () => {
        // The snapshot above already succeeded in the normal case; only retry it
        // when that write failed, so persist-before-evict still holds.
        if (!finalSnapshotPersisted) {
          await persistState(storageKey, sharedState);
          finalSnapshotPersisted = true;
        }
      }));
    }
  }

  if (!finalSnapshotPersisted && finalSnapshotFailure) recordTerminalSequenceFailure(finalSnapshotFailure);

  // An ephemeral run is transient: drop it from the in-memory map once it
  // reaches a terminal state so isolated/subflow runs don't accumulate.
  const cleanupEphemeral = () => {
    if (
      ephemeral &&
      (sharedState.status === 'completed' ||
        sharedState.status === 'error' ||
        sharedState.status === 'capped')
    ) {
      FlowExecutor.conversationStates.delete(effectiveConvId);
      forgetConversationCacheEntry(effectiveConvId);
      void releaseUnsavedRunStore(effectiveConvId);
    }
  };

  const baseResult = {
    conversationId: sharedState.conversationId || effectiveConvId,
    messages: sharedState.messages as FlujoChatMessage[],
    usage: sharedState.usage,
    finalAction: currentAction,
    sharedState,
  };

  // --- Paused debug ---
  if (sharedState.status === 'paused_debug') {
    log.info(`Returning paused debug state for conv ${effectiveConvId}`);
    return finalizeRun({
      ...baseResult,
      status: 'paused_debug',
      outputText: '',
      pendingToolCalls: sharedState.pendingToolCalls,
    modelsUsed: sharedState.modelsUsed,
    decisions: decisionsOfThisRun(sharedState),
    });
  }

  // --- Error ---
  if (sharedState.status === 'error' || currentAction === ERROR_ACTION) {
    const { errorMessage, errorDetails, statusCode } = describeRunError(sharedState);

    log.error(`Returning error result for conv ${effectiveConvId}`, { errorMessage, errorDetails, statusCode });

    if (sharedState.status !== 'error') {
      sharedState.status = 'error';
    }

    cleanupEphemeral();
    return finalizeRun({
      ...baseResult,
      status: 'error',
      outputText: '',
      error: { message: errorMessage, details: errorDetails, statusCode },
    });
  }

  // --- Success (Final, Tool Call, Stay, or Awaiting Approval) ---
  const { responseContent, toolCalls, outputMedia } = runSuccessOutput(sharedState, currentAction, flujo);

  log.info(`Returning success result for conv ${effectiveConvId}`, { action: currentAction, status: sharedState.status, flujo, requireApproval, flujodebug });

  cleanupEphemeral();
  return finalizeRun({
    ...baseResult,
    status: (sharedState.status as FlowRunStatus) || (currentAction === FINAL_RESPONSE_ACTION ? 'completed' : 'running'),
    outputText: responseContent,
    ...(outputMedia ? { outputMedia } : {}),
    toolCalls,
    pendingToolCalls: sharedState.pendingToolCalls,
    modelsUsed: sharedState.modelsUsed,
    decisions: decisionsOfThisRun(sharedState),
  });
}
