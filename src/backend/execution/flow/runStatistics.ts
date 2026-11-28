// Statistics records of one logical run: started, paused and finished.
import { SharedState } from '@/backend/execution/flow/types';
import {
  classifyStatisticsError,
  createStatisticsEvent,
  recordStatisticsEvent,
} from '@/backend/services/statistics';
import { queueSubflowRunOutcome } from '@/backend/execution/flow/subflowRecovery';
import type { FlowRunInput, FlowRunResult } from './runFlowContract';

/** What the run statistics need from runFlow. `state` returns the run's current state object. */
export type RunStatisticsContext = {
  state: () => SharedState;
  input: FlowRunInput;
  logicalRunId: string;
  effectiveConvId: string;
  startTime: number;
};

/**
 * Records the run.started, run.paused and run.finished statistics of one
 * logical run, once each, and queues the finished run for subflow recovery.
 * The planned execution and Persona attribution are read when this is
 * created, as runFlow did at that point.
 */
export function createRunStatistics(context: RunStatisticsContext): {
  ensureRunStarted: () => void;
  finalizeRun: (result: Omit<FlowRunResult, 'runId'>) => FlowRunResult;
} {
  const { state, input, logicalRunId, effectiveConvId, startTime } = context;
  const created = state();
  const flowSnapshot = () => ({
    id: state().flowId || input.flowId || input.flowDefinition?.id || input.modelName || 'unknown',
    name: state().statisticsFlowName ?? state().flowSnapshot?.name ?? input.flowDefinition?.name,
  });
  const plannedExecution = created.plannedExecutionId
    ? {
        id: created.plannedExecutionId,
        name: created.statisticsPlannedExecutionName,
      }
    : undefined;
  const runPersonaAttribution = created.personaAttribution
    ? { ...created.personaAttribution }
    : undefined;
  // Lineage: the spawning run's logical id travels with every lifecycle record
  // so a child run can be rolled up under its parent without in-memory state.
  const runRevisions = () => (state().statisticsFlowRevisionId
    ? { flowRevisionId: state().statisticsFlowRevisionId }
    : undefined);
  const ensureRunStarted = () => {
    if (state().statisticsRunStarted) return;
    recordStatisticsEvent(createStatisticsEvent({
      type: 'run.started',
      runId: logicalRunId,
      source: input.source,
      flow: flowSnapshot(),
      plannedExecution,
      conversationId: effectiveConvId,
      parentRunId: state().parentRunId,
      revisions: runRevisions(),
      ...(runPersonaAttribution ? { personaAttribution: runPersonaAttribution } : {}),
    }));
    state().statisticsRunStarted = true;
  };

  const finalizeRun = (result: Omit<FlowRunResult, 'runId'>): FlowRunResult => {
    ensureRunStarted();
    const durationMs = Math.max(0, Date.now() - (state().statisticsRunStartedAt ?? startTime));
    if (result.status === 'awaiting_tool_approval' || result.status === 'paused_debug') {
      recordStatisticsEvent(createStatisticsEvent({
        type: 'run.paused',
        runId: logicalRunId,
        source: input.source,
        flow: flowSnapshot(),
        plannedExecution,
        pauseKind: result.status === 'paused_debug' ? 'debug' : 'approval',
        durationMs,
        parentRunId: state().parentRunId,
        revisions: runRevisions(),
        ...(runPersonaAttribution ? { personaAttribution: runPersonaAttribution } : {}),
      }));
    } else if (!state().statisticsRunFinished) {
      const outcome = state().isCancelled
        ? 'cancelled' as const
        : result.status === 'error'
          ? 'error' as const
          : result.status === 'capped' || state().capped
            ? 'capped' as const
            : 'completed' as const;
      recordStatisticsEvent(createStatisticsEvent({
        type: 'run.finished',
        runId: logicalRunId,
        source: input.source,
        flow: flowSnapshot(),
        plannedExecution,
        outcome,
        durationMs,
        parentRunId: state().parentRunId,
        revisions: runRevisions(),
        ...(runPersonaAttribution ? { personaAttribution: runPersonaAttribution } : {}),
        errorClass: outcome === 'error' ? classifyStatisticsError(result.error) : undefined,
        usage: result.usage ? {
          inputTokens: result.usage.promptTokens,
          outputTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
          cachedInputTokens: result.usage.cacheReadTokens,
          cacheWriteTokens: result.usage.cacheWriteTokens,
        } : undefined,
      }));
      state().statisticsRunFinished = true;
    }
    const finalized = { ...result, runId: logicalRunId };
    queueSubflowRunOutcome(finalized);
    return finalized;
  };

  return { ensureRunStarted, finalizeRun };
}
