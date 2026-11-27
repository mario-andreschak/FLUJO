// Persona Activity state: normalize recovered Behavior rules and install a new Activity's snapshot.
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import type { SharedState } from '@/backend/execution/flow/types';
import { type Flow, normalizeBehaviorRulesInput } from '@/shared/types/flow';
import { FEATURES } from '@/config/features';
import { FlowSnapshotSchema } from '@/shared/types/enduringAgent';

/**
 * Install a successor Persona Activity's immutable Behavior as a fresh
 * execution boundary. The conversation transcript and user-owned metadata
 * survive, but no graph-derived capability, pending action, or resumable child
 * state from the prior Activity may cross into the newly pinned revision.
 */
export function normalizeRecoveredBehaviorRules(sharedState: SharedState): void {
  const legacyState = sharedState as SharedState & {
    permissionRules?: Flow['behaviorRules'];
    savedPermissionRules?: Flow['behaviorRules'];
  };
  if (sharedState.flowSnapshot) {
    sharedState.flowSnapshot = FlowSnapshotSchema.parse(sharedState.flowSnapshot);
  }
  const snapshotRules = sharedState.flowSnapshot?.behaviorRules;

  const normalizedState = normalizeBehaviorRulesInput(legacyState);
  sharedState.behaviorRules = structuredClone(
    snapshotRules ?? normalizedState.behaviorRules ?? [],
  );
  delete legacyState.permissionRules;

  const savedAliases: {
    behaviorRules?: Flow['behaviorRules'];
    permissionRules?: Flow['behaviorRules'];
  } = {};
  if (Object.prototype.hasOwnProperty.call(sharedState, 'savedBehaviorRules')) {
    savedAliases.behaviorRules = sharedState.savedBehaviorRules;
  }
  if (Object.prototype.hasOwnProperty.call(legacyState, 'savedPermissionRules')) {
    savedAliases.permissionRules = legacyState.savedPermissionRules;
  }
  const normalizedSaved = normalizeBehaviorRulesInput(savedAliases);
  sharedState.savedBehaviorRules = structuredClone(
    snapshotRules ?? normalizedSaved.behaviorRules ?? [],
  );
  delete legacyState.savedPermissionRules;
}

export function installPersonaActivitySnapshot(
  sharedState: SharedState,
  flowDefinition: Flow,
  debug: boolean,
): void {
  const priorFlowId = sharedState.flowId;
  for (const flowId of new Set([priorFlowId, flowDefinition.id])) {
    if (flowId) FlowExecutor.clearFlowCache(flowId);
  }

  const canonicalFlow = normalizeBehaviorRulesInput(flowDefinition) as Flow;
  sharedState.flowSnapshot = structuredClone(canonicalFlow);
  sharedState.flowId = canonicalFlow.id;
  sharedState.currentNodeId = undefined;

  // Model/tool authority derived from the prior graph.
  sharedState.mcpContext = undefined;
  sharedState.currentMCPNodes = undefined;
  delete sharedState.personaCoreAppRefs;
  sharedState.armedSyntheticTools = undefined;
  sharedState.loadedDeferredTools = undefined;
  sharedState.toolNameMap = undefined;
  sharedState.offeredToolNames = undefined;
  sharedState.allowedToolNames = undefined;
  sharedState.inheritedAllowedToolNames = undefined;
  // The successor Activity starts from the immutable Behavior policy, never
  // from stale graph-derived rules or an unguarded empty policy.
  sharedState.behaviorRules = structuredClone(canonicalFlow.behaviorRules ?? []);
  sharedState.savedBehaviorRules = structuredClone(canonicalFlow.behaviorRules ?? []);
  sharedState.frozenSystemPrompts = undefined;
  sharedState.codexSessions = undefined;
  sharedState.responsesSessions = undefined;
  sharedState.turnBudgets = undefined;
  sharedState.mcpAppContexts = undefined;
  sharedState.mcpSkillSelections = undefined;

  // Graph routing, subflow recovery, and detached-task handles.
  sharedState.handoffRequested = undefined;
  sharedState.handoffInput = undefined;
  sharedState.handoffNameMap = undefined;
  sharedState.handoffTargetTypes = undefined;
  sharedState.pendingSubflowReturn = undefined;
  sharedState.subflowToolNameMap = undefined;
  sharedState.subflowDetachedToolNameMap = undefined;
  sharedState.subflowInvocations = undefined;
  sharedState.activeSubflowInvocationByNode = undefined;
  sharedState.subflowSessions = undefined;
  sharedState.subflowLane = undefined;
  sharedState.launchedTaskIds = undefined;
  sharedState.subflowOrchestratorNodeId = undefined;
  sharedState.staticInjected = undefined;

  // No paused tool/debug decision from the old Activity may execute under the
  // new lease. Debug configuration is re-established from this invocation.
  sharedState.pendingToolCalls = undefined;
  sharedState.debugPendingToolCalls = undefined;
  sharedState.debugPendingAction = undefined;
  sharedState.debugPauseRequested = false;
  sharedState.debugResumeAfterDetach = false;
  sharedState.breakpoints = [];
  sharedState.lastBreakNodeId = undefined;
  sharedState.debugMode = debug;
  sharedState.executionTrace = debug && FEATURES.ENABLE_EXECUTION_TRACKER ? [] : undefined;

  // Activity/run-scoped scratchpads and lifecycle projections.
  sharedState.variables = {};
  sharedState.variableSources = undefined;
  sharedState.todos = undefined;
  sharedState.usage = undefined;
  sharedState.logicalRunId = undefined;
  sharedState.recovery = undefined;
  sharedState.runDepth = undefined;
  sharedState.chainDepth = undefined;
  sharedState.onApprovalRequired = undefined;
  sharedState.forceSummaryTurn = undefined;
  sharedState.finishAnswerTurn = undefined;
  sharedState.capped = undefined;
  sharedState.cappedReason = undefined;
  sharedState.lastResponse = undefined;
  sharedState.lastError = undefined;
  sharedState.errorEventEmitted = false;
  sharedState.isCancelled = false;
  sharedState.status = 'running';
  sharedState.trackingInfo = {
    executionId: crypto.randomUUID(),
    startTime: Date.now(),
    nodeExecutionTracker: [],
  };

  // Statistics describe this Activity's snapshot, never its predecessor.
  sharedState.statisticsRunStartedAt = undefined;
  sharedState.statisticsRunStarted = false;
  sharedState.statisticsRunFinished = false;
  sharedState.statisticsFlowName = undefined;
  sharedState.statisticsPlannedExecutionName = undefined;
  sharedState.statisticsFlowRevisionId = undefined;
}
