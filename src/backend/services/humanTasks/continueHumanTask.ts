import { createLogger } from '@/utils/logger';
import { StorageKey } from '@/shared/types/storage';
import type { FlujoChatMessage } from '@/shared/types/chat';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { withConversationExecutionLock } from '@/backend/execution/flow/conversationExecutionLock';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import { appendRawForState } from '@/backend/execution/flow/conversationLog';
import { applyApprovalDecision } from '@/backend/execution/flow/resumeAfterApproval';
import { approvalActionFor, expireHumanTask } from '@/backend/execution/flow/humanTask';
import { isPersonaOwnedConversationState } from '@/backend/execution/flow/personaConversationOwnership';
import { acquireFlowRunAdmission, isFlowRunPressureError, withFlowRunAdmission } from '@/backend/execution/flow/runAdmission';
import { runFlow } from '@/backend/execution/flow/runFlow';
import type { SharedState } from '@/backend/execution/flow/types';
import { getPendingApproval, putPendingApproval, removePendingApproval } from '@/backend/services/scheduler/pendingApprovals';
import { updateRunRecord } from '@/backend/services/scheduler/runHistory';
import { resumePersonaFlowDispatch } from '@/backend/services/enduringAgents/personaDispatcher';
import { requireApprovalOf } from '@/backend/execution/flow/toolApprovalGate';

const log = createLogger('backend/services/humanTasks/continueHumanTask');

/** Final assistant output kept in scheduled run history, as for approvals. */
const MAX_STORED_OUTPUT_CHARS = 4096;

export type HumanTaskContinuation =
  /** The run went on and stopped at its next natural point. */
  | { status: 'continued'; runStatus?: string }
  /** A Persona dispatcher took the run over; it continues there. */
  | { status: 'dispatched'; dispatchState: string }
  /** Nothing to do: no saved answer, already applied, or a different step waits now. */
  | { status: 'idle' }
  /** FLUJO is busy. The answer stays saved; the sweep tries again in a minute. */
  | { status: 'busy' }
  /** The conversation cannot continue from here (for example an incomplete Persona record). */
  | { status: 'blocked'; reason: string };

function outputText(state: SharedState | undefined): string | undefined {
  const last = state?.messages[state.messages.length - 1];
  const text = last && last.role === 'assistant' && typeof last.content === 'string' ? last.content : undefined;
  if (!text) return undefined;
  return text.length > MAX_STORED_OUTPUT_CHARS ? `${text.slice(0, MAX_STORED_OUTPUT_CHARS)}…` : text;
}

/** Bring a scheduled run's history and approval inbox up to date after it went on. */
async function reconcileScheduledRun(conversationId: string): Promise<void> {
  const entry = await getPendingApproval(conversationId);
  if (!entry || entry.terminalPublication) return;
  const finalState = await loadConversationState(conversationId);
  if (finalState?.status === 'awaiting_tool_approval') {
    const remaining = (finalState.pendingToolCalls ?? []).map((call) => ({
      id: call.id, name: call.type === 'function' ? call.function.name : String(call.type),
    }));
    await putPendingApproval({ ...entry, pendingToolCalls: remaining });
    return;
  }
  const status: 'completed' | 'error' = finalState?.status === 'completed' ? 'completed' : 'error';
  await updateRunRecord(entry.plannedExecutionId, entry.runId, {
    status,
    finishedAt: new Date().toISOString(),
    outputText: outputText(finalState),
    usage: finalState?.usage,
    error: status === 'completed' ? undefined : `Run ended with status "${finalState?.status ?? 'unknown'}" after a Human step`,
    pendingApproval: undefined,
  });
  await removePendingApproval(conversationId);
}

/**
 * Continue a run whose Human step has a saved answer, or whose deadline passed.
 *
 * Shared by the answer route, which replies first and continues afterwards, and by the
 * sweep, which picks up overdue steps and answers saved before a crash. Everything
 * happens under the conversation's lock, after reading the saved state again, so two
 * callers can never apply one answer twice: the second finds nothing left to do.
 * Capacity is reserved before the answer is used, so a busy FLUJO leaves the run
 * waiting with its answer saved instead of half-continued.
 */
export async function continueHumanTask(
  conversationId: string,
  options: { requestId?: string; expire?: boolean; now?: Date } = {},
): Promise<HumanTaskContinuation> {
  return withConversationExecutionLock(conversationId, async () => {
    const state = await loadConversationState(conversationId);
    const task = state?.humanTask;
    if (!state || !task || (options.requestId && task.requestId !== options.requestId)) return { status: 'idle' };
    if (state.personaArchived) return { status: 'blocked', reason: 'An anonymized Persona archive is read-only.' };

    const storageKey = `conversations/${conversationId}` as StorageKey;
    const now = options.now ?? new Date();
    const overdue = !task.decision && options.expire === true && now.getTime() >= Date.parse(task.expiresAt);
    if (!task.decision && !overdue) return { status: 'idle' };
    const waiting = state.status === 'awaiting_tool_approval'
      && !!state.pendingToolCalls?.some((call) => call.id === task.toolCallId);
    // A run that stopped after the answer was handed over but before the step used it
    // is still 'running' on disk. Anything else has moved on and is left alone.
    if (!waiting && state.status !== 'running') return { status: 'idle' };

    /** Record a due time-out, then hand the saved answer to the waiting call and save. */
    const consume = async (target: SharedState): Promise<void> => {
      if (overdue && expireHumanTask(target, now)) {
        log.info('A Human step timed out', { conversationId, requestId: task.requestId });
        if (!waiting) {
          FlowExecutor.conversationStates.set(conversationId, target);
          await persistConversationState(storageKey, target);
        }
      }
      if (!waiting || !target.humanTask?.decision) return;
      const applied = await applyApprovalDecision(target, task.toolCallId, approvalActionFor(target.humanTask.decision));
      if (applied.outcome === 'tool_not_found' || applied.outcome === 'human_refused') {
        throw new Error('The saved answer no longer matches the waiting step.');
      }
      target.lastResponse = undefined;
      target.lastError = undefined;
      target.errorEventEmitted = false;
      FlowExecutor.conversationStates.set(conversationId, target);
      await persistConversationState(storageKey, target);
      await appendRawForState(target, applied.appendedMessages.map((message: FlujoChatMessage) => ({ type: 'message', message })));
    };

    if (isPersonaOwnedConversationState(state)) {
      const attribution = state.personaAttribution;
      if (!attribution?.activityId || !attribution.behaviorRevisionId) {
        return { status: 'blocked', reason: 'Persona conversation attribution is incomplete.' };
      }
      const dispatch = await resumePersonaFlowDispatch({
        personaId: attribution.personaId,
        activityId: attribution.activityId,
        behaviorRevisionId: attribution.behaviorRevisionId,
        conversationId,
        reason: 'approval',
        flowInputPatch: {
          messages: state.messages,
          requireApproval: requireApprovalOf(state.requireApproval),
          debug: state.debugMode ?? false,
          continueDebug: false,
          userTurn: false,
        },
        prepare: async ({ installExecutionAuthority }) => {
          installExecutionAuthority(state);
          await consume(state);
          return state.status === 'awaiting_tool_approval' ? 'yield' : 'resume';
        },
      });
      return { status: 'dispatched', dispatchState: dispatch.state };
    }

    let permit;
    try {
      permit = acquireFlowRunAdmission({ conversationId, messages: state.messages });
    } catch (error) {
      if (isFlowRunPressureError(error)) {
        log.info('FLUJO is busy; the Human step answer stays saved for the next try', { conversationId });
        return { status: 'busy' };
      }
      throw error;
    }
    const result = await withFlowRunAdmission(permit, async () => {
      await consume(state);
      return runFlow({
        conversationId,
        mode: 'conversation',
        flujo: true,
        requireApproval: requireApprovalOf(state.requireApproval),
        userTurn: false,
        source: overdue || task.decision?.channel === 'expiry' ? 'internal' : 'chat',
      });
    });
    await reconcileScheduledRun(conversationId).catch((error) =>
      log.warn('Could not update the scheduled run after a Human step', { conversationId, error }));
    return { status: 'continued', runStatus: result.status };
  });
}
