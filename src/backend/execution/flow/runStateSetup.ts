// Opens the state object a run works on and installs this invocation's inputs on it.
import { recordVariableSource } from '@/utils/shared/edgeConditions';
import { installExecutionExtensionContext } from '@/backend/execution/extensions';
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { bindExecutionModelStepOrdinals } from '@/backend/execution/flow/modelStepOrdinals';
import { syncHumanTaskEntry, updateHumanTaskEntry } from '@/backend/services/humanTasks/humanTaskIndex';
import { dropWaitingChildSteps } from '@/backend/services/humanTasks/dropHumanTask';
import { releaseWaitingSubflows } from './subflowHumanWait';
import { SharedState, isUnattendedFlowInvocation } from '@/backend/execution/flow/types';
import { DEFAULT_CONVERSATION_TITLE } from '@/utils/shared/conversationTitle';
import { initializeRecovery } from '@/backend/execution/flow/recoveryCheckpoint';
import type { FlowRunInput } from './runFlowContract';
import { installPersonaActivitySnapshot } from './personaActivityState';
import type { RunStateSource } from './runStateLoading';
import type { PersonaInstructionContext } from '@/shared/types/enduringAgent';

const log = createLogger('backend/execution/flow/runStateSetup');

/** What opening the run's state needs from runFlow. */
export type RunStateOpening = {
  loadedState: SharedState | undefined;
  stateSource: RunStateSource;
  effectiveConvId: string;
  /** The step an edit names; resets the loaded state to start there. */
  processNodeId?: string;
  input: FlowRunInput;
  flujodebug: boolean;
};

/**
 * The state object this run works on: the loaded conversation, reset to
 * running when it had finished, errored or never run (or to the edited step),
 * or a new conversation. Also reports whether this resumes an errored run.
 */
export function openRunState(opening: RunStateOpening): { sharedState: SharedState; resumingAfterError: boolean } {
  const { loadedState, stateSource, effectiveConvId, processNodeId, input, flujodebug } = opening;
  // Issue #151: captured BEFORE the status reset below so the turn-replay guard
  // downstream can tell an error-recovery resume apart from a normal resume.
  let resumingAfterError = false;
  let sharedState: SharedState;
  if (loadedState) {
    sharedState = loadedState;
    if (sharedState.conversationId !== effectiveConvId) {
      log.warn(`Loaded state's internal conversationId (${sharedState.conversationId}) differs from effectiveConvId (${effectiveConvId}). Using effectiveConvId.`);
      sharedState.conversationId = effectiveConvId;
    }

    // --- Reset status if resuming a completed/errored conversation ---
    // Also covers status === undefined: a conversation created via the create
    // route starts with NO status, and without this its whole FIRST run reports
    // undefined to the list route — so the sidebar never showed the running dot
    // / stop button for it (the SSE run:start patch was overwritten by the next
    // list poll).
    if (stateSource !== 'new' && (sharedState.status === 'completed' || sharedState.status === 'error' || sharedState.status === undefined)) {
      log.info(`Resuming completed/errored/fresh conversation ${effectiveConvId}. Resetting status to 'running'.`);
      // Issue #151: remember this was an error-recovery resume before the status
      // is cleared, so the turn-replay redirect below can act only on it.
      resumingAfterError = sharedState.status === 'error';
      sharedState.status = 'running';
      sharedState.lastResponse = undefined;
      sharedState.lastError = undefined;
      sharedState.errorEventEmitted = false;
      sharedState.isCancelled = false;
      if (stateSource === 'storage') {
        FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
      }
    }

    // --- Handle processNodeId if provided (for edits specifically) ---
    if (processNodeId && stateSource !== 'new') {
      log.info(`Edit detected: Resetting currentNodeId for conversation ${effectiveConvId} to provided processNodeId: ${processNodeId}`);

      sharedState.currentNodeId = processNodeId;
      sharedState.status = 'running';
      sharedState.lastResponse = undefined;
      sharedState.lastError = undefined;
      sharedState.errorEventEmitted = false;
      sharedState.pendingToolCalls = undefined;
      sharedState.handoffRequested = undefined;
      sharedState.debugPendingAction = undefined;
      sharedState.debugPendingToolCalls = undefined;
      sharedState.debugBoundary = undefined;
      sharedState.debugBoundaryCounter = 0;
      sharedState.debugPauseRequested = false;
      sharedState.isCancelled = false;

      sharedState.trackingInfo = {
        executionId: crypto.randomUUID(),
        startTime: Date.now(),
        nodeExecutionTracker: [],
      };

      FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
      log.verbose(`State updated in memory with reset currentNodeId: ${sharedState.currentNodeId}`);
    }
  } else {
    log.info(`Creating new conversation state object for ID: ${effectiveConvId}`);
    sharedState = {
      trackingInfo: {
        executionId: crypto.randomUUID(),
        startTime: Date.now(),
        nodeExecutionTracker: [],
      },
      messages: [],
      flowId: '',
      conversationId: effectiveConvId,
      currentNodeId: undefined,
      status: 'running',
      // A caller-supplied title (spawn lanes: the brief) sticks — the
      // first-user-message auto-titling below only replaces the placeholder.
      title: input.title?.trim() || DEFAULT_CONVERSATION_TITLE,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugMode: flujodebug,
      // Tier 2c: the run-scoped named-variable scratchpad starts empty and is
      // seeded from FlowRunInput.variables just below.
      variables: {},
    };
  }

  return { sharedState, resumingAfterError };
}

/** What installing the run's inputs needs from runFlow. */
export type RunInputInstallation = {
  sharedState: SharedState;
  input: FlowRunInput;
  effectiveConvId: string;
  flujodebug: boolean;
  userTurn: boolean;
  ephemeral: boolean;
  requireApproval: boolean;
  resumingPausedLogicalRun: boolean;
  resetPersonaPromptPrefix: boolean;
  personaInstructionContext: PersonaInstructionContext | undefined;
  personaCoreAppRefs: string[] | undefined;
};

/**
 * Installs this invocation's inputs on the run's state: Persona snapshot and
 * authority, per-turn resets (injections, Human steps, static waits, skills),
 * variables, meeting turn, approval policy, origin and unattended flag,
 * subflow lineage and depth, and the logical run id with its recovery and
 * repeat-guard records. Returns the logical run id and the variables the run
 * started with.
 */
export async function installRunInputs(installation: RunInputInstallation): Promise<{
  harnessInitialVariables: Record<string, string>;
  logicalRunId: string;
}> {
  const {
    sharedState, input, effectiveConvId, flujodebug, userTurn, ephemeral, requireApproval,
    resumingPausedLogicalRun, resetPersonaPromptPrefix, personaInstructionContext, personaCoreAppRefs,
  } = installation;
  if (personaInstructionContext && resetPersonaPromptPrefix) {
    // Same-Activity approval/debug/crash resumes never enter this branch.
    installPersonaActivitySnapshot(sharedState, input.flowDefinition!, flujodebug);
  }

  // `injectOnce` applies to this top-level user turn. Keep the map across
  // approval/debug continuations, but clear it before a new turn re-enters the
  // flow so persisted conversation state cannot suppress a later traversal.
  if (userTurn && !resumingPausedLogicalRun && !input.parentRunId && (input.depth ?? 0) === 0) {
    sharedState.staticInjected = undefined;
  }
  if (userTurn) sharedState.modelsUsed = undefined;
  if (userTurn && sharedState.humanTask) {
    // A new message replaces a waiting Human step, as it does a Static node's wait.
    const replaced = sharedState.humanTask;
    sharedState.humanTask = undefined;
    if (sharedState.status === 'awaiting_tool_approval') {
      sharedState.status = 'running';
      sharedState.pendingToolCalls = undefined;
    }
    if (!sharedState.ephemeral) {
      await syncHumanTaskEntry(() => updateHumanTaskEntry(replaced.requestId, {
        status: 'cancelled', finishedAt: new Date().toISOString(),
      }), 'replaced by a new message');
    }
  }
  if (userTurn) {
    // It also replaces the waits of sub-flow children this run showed.
    const replacedChildren = releaseWaitingSubflows(sharedState);
    if (!sharedState.ephemeral) dropWaitingChildSteps(replacedChildren, 'A new message replaced the run that waited for this step.');
  }
  if (userTurn && sharedState.staticHold) {
    // A new message replaces an open wait. The dangling-call repair below answers the
    // waiting call, and the node asks again if the run reaches it again.
    sharedState.staticHold = undefined;
    if (sharedState.status === 'awaiting_tool_approval') {
      sharedState.status = 'running';
      sharedState.pendingToolCalls = undefined;
    }
  }

  // Tier 2c (named variables): wire the dormant FlowRunInput.variables field onto
  // the state so `${var:NAME}` can inject caller-provided inputs from the first
  // node. Values are coerced to string (the scratchpad is string-only). A fresh
  // state has `variables: {}` from the literal above; a resumed state keeps its
  // persisted vars and only merges any new caller-supplied ones.
  if (input.variables && typeof input.variables === 'object') {
    sharedState.variables = sharedState.variables ?? {};
    for (const [key, value] of Object.entries(input.variables)) {
      if (value === undefined || value === null) continue;
      sharedState.variables[key] = typeof value === 'string' ? value : String(value);
      recordVariableSource(sharedState, key, 'input');
    }
  }
  const harnessInitialVariables = structuredClone(sharedState.variables ?? {});

  // MCP Apps: each ui/update-model-context request overwrites that app's
  // previous value in the frontend-owned map. When the map accompanies a
  // future user turn, replace the persisted snapshot atomically; omission means
  // an internal resume should keep the last snapshot.
  if (input.mcpAppContexts !== undefined) {
    sharedState.mcpAppContexts = input.mcpAppContexts;
  }

  // MCP Skills are per user turn. Internal approval/debug continuations retain
  // the active selection, while a fresh turn replaces it (including clearing
  // an earlier selection when the client sends none).
  if (userTurn || input.mcpSkillSelections !== undefined) {
    sharedState.mcpSkillSelections = input.mcpSkillSelections;
  }

  // Never inherit a stale in-memory authority from an earlier invocation. A
  // paused Persona Activity must be explicitly reacquired by its dispatcher;
  // ordinary/legacy resumes remain authority-free.
  if (input.executionExtensionContext) {
    installExecutionExtensionContext(sharedState, input.executionExtensionContext);
  } else {
    delete sharedState.executionExtensionContext;
  }
  if (input.executionAuthority) {
    Object.defineProperty(sharedState, 'executionAuthority', {
      value: input.executionAuthority,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } else {
    delete sharedState.executionAuthority;
  }
  if (input.personaAttribution) {
    sharedState.personaAttribution = { ...input.personaAttribution };
    delete sharedState.personaTargetId;
  }
  if (personaCoreAppRefs !== undefined) {
    Object.defineProperty(sharedState, 'personaCoreAppRefs', {
      value: [...personaCoreAppRefs],
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } else {
    delete sharedState.personaCoreAppRefs;
  }
  if (personaInstructionContext) {
    sharedState.personaInstructionContext = structuredClone(personaInstructionContext);
  }
  if (
    input.behaviorToolRegistry
    && (!sharedState.behaviorToolRegistry || resetPersonaPromptPrefix)
  ) {
    sharedState.behaviorToolRegistry = structuredClone(input.behaviorToolRegistry);
  }
  // A meeting round is still executed by the regular flow runtime, but its
  // coordination state belongs to the sibling MeetingEngine. Install only the
  // participant's identity and a fresh per-turn action buffer here; because
  // SubflowNode does not forward these fields, child runs cannot accidentally
  // speak or vote on behalf of their parent participant.
  if (input.source === 'meeting' && input.meetingParticipant && input.meetingTurn) {
    sharedState.meetingParticipant = { ...input.meetingParticipant };
    sharedState.meetingTurn = {
      ...input.meetingTurn,
      actions: [...input.meetingTurn.actions],
    };
  } else {
    // Participant conversations are ordinary inspectable conversations once
    // a person re-enters them outside the coordinator. Do not leave stale
    // meeting capabilities or provider prefixes armed on a later chat/API run.
    // The frozen prompt and native session were created with the meeting
    // protocol, so both must be rebuilt before normal conversation continues.
    if (sharedState.meetingParticipant) {
      sharedState.frozenSystemPrompts = undefined;
      sharedState.codexSessions = undefined;
      sharedState.responsesSessions = undefined;
    }
    sharedState.meetingTurn = undefined;
  }

  // The conversation's approval setting (single source of truth).
  sharedState.requireApproval = requireApproval;

  // Tag the invocation origin and derive the run-local unattended flag from it
  // (issue #339).
  //
  // `source` is the CONVERSATION's provenance and is immutable once recorded:
  // it answers "what created this conversation", not "how was it re-entered".
  // Every resume path — approval release, debug step/continue, respond — goes
  // back through chatCompletionService, which hardcodes source:'chat'. Blindly
  // overwriting therefore relabelled a scheduled/triggered run as a user chat
  // (wrong origin badge, wrong "by origin" bucket) AND, worse, bypassed the
  // `source !== 'schedule' && source !== 'trigger'` guard on the run:done emit
  // below, so a scheduler-owned run that happened to pause for approval sprayed
  // a duplicate flow-run event on resume. Keep the first origin; only fill it
  // in when absent (fresh state, or a legacy record from before this field).
  sharedState.source = sharedState.source ?? input.source;
  // `unattended`, by contrast, stays strictly RUN-local and is always derived
  // from THIS invocation: a human releasing an approval on a scheduled run is
  // genuinely attended for that turn. Overwritten every call so a legacy
  // persisted value or a flow-level property can never influence this run.
  sharedState.unattended = isUnattendedFlowInvocation(input.source);
  if (input.plannedExecutionId) {
    sharedState.plannedExecutionId = input.plannedExecutionId;
  }
  if (input.plannedExecutionName) {
    sharedState.statisticsPlannedExecutionName = input.plannedExecutionName;
  }

  // The persistence policy travels ON the state: persistConversationState (the
  // single chokepoint) refuses ephemeral states, so no path — including
  // incremental persists deep in adapters — can leak this run to the
  // conversations store. Never unset: an ephemeral run stays ephemeral.
  if (ephemeral) {
    sharedState.ephemeral = true;
  }

  // Record the spawning run's id so cancellation propagates down the run tree
  // (issue #109): the loop guard below walks this chain, and cancelling the
  // top conversation stops every descendant subflow at its next iteration.
  if (input.parentRunId) {
    sharedState.parentRunId = input.parentRunId;
    sharedState.parentLogicalRunId = FlowExecutor.conversationStates.get(input.parentRunId)?.logicalRunId;
    // Conversation-level parent link (issue #182): formalize the subflow
    // parentage at the conversation record so the chat sidebar can render
    // Flow->Subflow->... chains without reverse-engineering run internals.
    // Additive/optional -- a conversation without these fields renders as a
    // root, so no migration is needed. Compute rootConversationId eagerly
    // (O(1) sidebar grouping) from the parent's own root, falling back to the
    // parent id when the parent state isn't resident (treat parent as root).
    sharedState.parentConversationId = input.parentRunId;
    if (!sharedState.rootConversationId) {
      const parentState = FlowExecutor.conversationStates.get(input.parentRunId);
      sharedState.rootConversationId =
        parentState?.rootConversationId ?? parentState?.conversationId ?? input.parentRunId;
    }
  }

  // Subflow re-entrancy guard: record this run's depth and refuse to start if
  // the call tree is too deep (a flow calling itself, directly or via a chain).
  sharedState.runDepth = input.depth ?? sharedState.runDepth ?? 0;
  // Event-chain depth (issue #116/#117): threaded from the firing trigger (via
  // the scheduler) or from the parent run (via SubflowNode) so a `signal` node
  // emits at the emitting run's true depth and runaway chains trip maxChainDepth.
  sharedState.chainDepth = input.chainDepth ?? sharedState.chainDepth ?? 0;
  // Headless approval policy (#115): what to do when a tool needs approval and
  // there is no interactive approver. Persisted on the state so a resumed
  // 'pause' run keeps re-pausing (not failing) on later tool calls.
  sharedState.onApprovalRequired = input.onApprovalRequired ?? sharedState.onApprovalRequired ?? 'auto';
  sharedState.approvalConversationId = input.approvalConversationId;

  const previousLogicalRunId = sharedState.logicalRunId;
  if (!resumingPausedLogicalRun) {
    // Subflow sessions are scoped to one logical parent run. Old handles stay in
    // their saved child conversations but must not leak into a later user turn.
    sharedState.subflowSessions = undefined;
    sharedState.toolRepeatGuard = undefined;
    sharedState.temperatureOverrideOnce = undefined;
    sharedState.logicalRunId = input.runId ?? crypto.randomUUID();
    sharedState.statisticsRunStartedAt = Date.now();
    sharedState.statisticsRunStarted = false;
    sharedState.statisticsRunFinished = false;
    sharedState.statisticsFlowName = input.flowDefinition?.name
      ?? (input.modelName?.startsWith('flow-') ? input.modelName.slice(5) : undefined);
    sharedState.statisticsPlannedExecutionName = input.plannedExecutionName;
  }
  const logicalRunId = sharedState.logicalRunId ?? input.runId ?? crypto.randomUUID();
  sharedState.logicalRunId = logicalRunId;
  if (input.executionExtensionContext) {
    bindExecutionModelStepOrdinals(sharedState, previousLogicalRunId);
    const { bindExecutionExtensionRun } = await import('@/backend/execution/extensions');
    await bindExecutionExtensionRun(input.executionExtensionContext, effectiveConvId, logicalRunId);
  }
  sharedState.toolRepeatGuard ??= { logicalRunId, entries: [] };
  if (sharedState.toolRepeatGuard.logicalRunId !== logicalRunId) {
    sharedState.toolRepeatGuard = { logicalRunId, entries: [] };
  }
  sharedState.debugResumeAfterDetach = false;
  sharedState.statisticsRunStartedAt ??= Date.now();
  initializeRecovery(sharedState, logicalRunId);
  if (input.lane) sharedState.subflowLane = input.lane;
  if (sharedState.subflowLane) sharedState.recovery!.lane = sharedState.subflowLane;

  return { harnessInitialVariables, logicalRunId };
}
