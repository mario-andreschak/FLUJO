import { createLogger } from '@/utils/logger';
import { StorageKey } from '@/shared/types/storage';
import type { FlujoChatMessage } from '@/shared/types/chat';
import type { FlowInvocationSource } from '@/shared/types/execution/invocation';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { withConversationExecutionLock } from '@/backend/execution/flow/conversationExecutionLock';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import { appendRawForState } from '@/backend/execution/flow/conversationLog';
import { applyApprovalDecision } from '@/backend/execution/flow/resumeAfterApproval';
import {
  approvalActionFor, decideHumanTask, delegatedHumanTasks, expireHumanTask, type HumanDecisionResult, type HumanTaskReceipt,
} from '@/backend/execution/flow/humanTask';
import { isPersonaOwnedConversationState } from '@/backend/execution/flow/personaConversationOwnership';
import { acquireFlowRunAdmission, isFlowRunPressureError, withFlowRunAdmission } from '@/backend/execution/flow/runAdmission';
import { runFlow } from '@/backend/execution/flow/runFlow';
import type { HumanTaskDecision, SharedState } from '@/backend/execution/flow/types';
import { getPendingApproval, putPendingApproval, removePendingApproval } from '@/backend/services/scheduler/pendingApprovals';
import { updateRunRecord } from '@/backend/services/scheduler/runHistory';
import { resumePersonaFlowDispatch } from '@/backend/services/enduringAgents/personaDispatcher';
import { requireApprovalOf } from '@/backend/execution/flow/toolApprovalGate';
import type { HumanAnswer } from '@/utils/shared/humanStep';
import { syncHumanTaskEntry, updateHumanTaskEntry } from './humanTaskIndex';

const log = createLogger('backend/services/humanTasks/continueHumanTask');

/** Final assistant output kept in scheduled run history, as for approvals. */
const MAX_STORED_OUTPUT_CHARS = 4096;
/** Sub-flows nest at most this deep when FLUJO looks for the run that waits. */
const MAX_CHAIN = 16;

type Refusal = Extract<HumanDecisionResult, { kind: 'refused' }>;

export type HumanTaskContinuation =
  /** The run went on and stopped at its next natural point. */
  | { status: 'continued'; runStatus?: string; receipt?: HumanTaskReceipt }
  /** A Persona dispatcher took the run over; it continues there. */
  | { status: 'dispatched'; dispatchState: string; receipt?: HumanTaskReceipt }
  /** Nothing to do: no saved answer, already applied, or a different step waits now. */
  | { status: 'idle' }
  /** FLUJO is busy. The answer stays saved; the sweep tries again in a minute. */
  | { status: 'busy' }
  /** The conversation cannot continue from here (for example an incomplete Persona record). */
  | { status: 'blocked'; reason: string }
  /** An answer given with `answer` did not fit; the step keeps waiting. */
  | { status: 'refused'; refusal: Refusal };

/** An answer to record and use in one go, for runs only their Persona dispatcher may change. */
export interface HumanTaskAnswerOption {
  accept: boolean;
  answer: HumanAnswer;
  channel: HumanTaskDecision['channel'];
}

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

/** The sub-flow parent that waits for this child, if it still does. */
async function waitingParentOf(state: SharedState | undefined, conversationId: string): Promise<SharedState | undefined> {
  const parentId = state?.parentRunId ?? state?.parentConversationId;
  if (!parentId) return undefined;
  const parent = await loadConversationState(parentId).catch(() => undefined);
  return parent?.status === 'awaiting_tool_approval'
    && delegatedHumanTasks(parent).some((task) => task.conversationId === conversationId) ? parent : undefined;
}

/**
 * The top run that waits, through its sub-flows, for this conversation's Human step.
 * Answering a child goes on from there, so each Subflow step joins its children once.
 */
export async function waitingRootOf(conversationId: string): Promise<string> {
  let current = conversationId;
  for (let depth = 0; depth < MAX_CHAIN; depth += 1) {
    const parent = await waitingParentOf(await loadConversationState(current).catch(() => undefined), current);
    if (!parent?.conversationId) break;
    current = parent.conversationId;
  }
  return current;
}

/** Whether a waiting child, or one of its own children, has something to go on with. */
async function childCanGoOn(conversationId: string, depth = 0): Promise<boolean> {
  const child = await loadConversationState(conversationId).catch(() => undefined);
  if (!child || child.status !== 'awaiting_tool_approval') return true;
  if (child.humanTask) return Boolean(child.humanTask.decision);
  const nested = [...new Set(delegatedHumanTasks(child).map((task) => task.conversationId))];
  if (nested.length === 0 || depth >= MAX_CHAIN) return true;
  for (const id of nested) if (await childCanGoOn(id, depth + 1)) return true;
  return false;
}

function receiptOf(state: SharedState | undefined, requestId: string): HumanTaskReceipt | undefined {
  const decision = state?.humanTask?.requestId === requestId ? state.humanTask.decision : undefined;
  if (decision) return { requestId, decisionId: decision.decisionId, outcome: decision.outcome, decidedAt: decision.decidedAt };
  const applied = state?.humanTaskLog?.find((record) => record.requestId === requestId);
  return applied ? { requestId, decisionId: applied.decisionId, outcome: applied.outcome, decidedAt: applied.decidedAt } : undefined;
}

/** Record a time-out that is due, then hand the saved answer to the waiting call and save. */
async function consumeSavedAnswer(
  conversationId: string,
  target: SharedState,
  options: { overdue: boolean; now: Date },
): Promise<void> {
  const storageKey = `conversations/${conversationId}` as StorageKey;
  const task = target.humanTask;
  if (!task) return;
  const waiting = target.status === 'awaiting_tool_approval'
    && !!target.pendingToolCalls?.some((call) => call.id === task.toolCallId);
  if (options.overdue && expireHumanTask(target, options.now)) {
    log.info('A Human step timed out', { conversationId, requestId: task.requestId });
    await syncHumanTaskEntry(() => updateHumanTaskEntry(task.requestId, {
      status: 'decided', outcome: 'timed_out', decisionId: target.humanTask!.decision!.decisionId, decidedAt: target.humanTask!.decision!.decidedAt,
    }), 'timed out');
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
}

/** Check an answer on a copy, so a Persona's run is only handed over with an answer that fits. */
function dryRun(state: SharedState, requestId: string, answer: HumanTaskAnswerOption): Refusal | undefined {
  if (state.humanTask?.requestId !== requestId) return undefined;
  const result = decideHumanTask({ humanTask: structuredClone(state.humanTask) }, {
    requestId, accept: answer.accept, answer: answer.answer, channel: answer.channel,
  });
  return result.kind === 'refused' ? result : undefined;
}

/** Record the answer for real inside the dispatcher's preparation; the dry run already passed. */
function recordAnswer(state: SharedState, requestId: string, answer: HumanTaskAnswerOption | undefined): void {
  if (!answer || state.humanTask?.requestId !== requestId) return;
  const result = decideHumanTask(state, { requestId, accept: answer.accept, answer: answer.answer, channel: answer.channel });
  if (result.kind === 'refused') throw new Error(result.error);
}

/**
 * Go on with the top run that waits for its sub-flows' Human steps (#1095). Its Subflow
 * step looks at each waiting child again: a child with an answer goes on from where it
 * stopped, a child that still waits is asked again, and the step joins once nobody
 * waits. Without `consumeChild`, nothing happens until some child can go on, so the
 * minute sweep never wakes a parent for nothing.
 */
export async function continueWaitingParent(
  rootId: string,
  options: {
    source?: FlowInvocationSource;
    /** Runs inside the same preparation, with fresh authority for a Persona's run. */
    consumeChild?: (installAuthority: (state: SharedState) => void) => Promise<void>;
  } = {},
): Promise<HumanTaskContinuation> {
  const result = await withConversationExecutionLock(rootId, async (): Promise<HumanTaskContinuation> => {
    const parent = await loadConversationState(rootId);
    if (!parent || parent.status !== 'awaiting_tool_approval') return { status: 'idle' };
    const waits = delegatedHumanTasks(parent);
    if (waits.length === 0) return { status: 'idle' };
    if (parent.personaArchived) return { status: 'blocked', reason: 'An anonymized Persona archive is read-only.' };
    if (!options.consumeChild) {
      let ready = false;
      for (const id of new Set(waits.map((wait) => wait.conversationId))) {
        if (await childCanGoOn(id)) { ready = true; break; }
      }
      if (!ready) return { status: 'idle' };
    }

    if (isPersonaOwnedConversationState(parent)) {
      const attribution = parent.personaAttribution;
      if (!attribution?.activityId || !attribution.behaviorRevisionId) {
        return { status: 'blocked', reason: 'Persona conversation attribution is incomplete.' };
      }
      const dispatch = await resumePersonaFlowDispatch({
        personaId: attribution.personaId,
        activityId: attribution.activityId,
        behaviorRevisionId: attribution.behaviorRevisionId,
        conversationId: rootId,
        reason: 'approval',
        flowInputPatch: {
          messages: parent.messages,
          requireApproval: requireApprovalOf(parent.requireApproval),
          debug: parent.debugMode ?? false,
          continueDebug: false,
          userTurn: false,
        },
        prepare: async ({ installExecutionAuthority }) => {
          installExecutionAuthority(parent);
          await options.consumeChild?.(installExecutionAuthority);
          return 'resume' as const;
        },
      });
      return { status: 'dispatched', dispatchState: dispatch.state };
    }

    let permit;
    try {
      permit = acquireFlowRunAdmission({ conversationId: rootId, messages: parent.messages });
    } catch (error) {
      if (isFlowRunPressureError(error)) {
        log.info('FLUJO is busy; the waiting parent goes on at the next try', { conversationId: rootId });
        return { status: 'busy' };
      }
      throw error;
    }
    const run = await withFlowRunAdmission(permit, async () => {
      await options.consumeChild?.(() => undefined);
      return runFlow({
        conversationId: rootId,
        mode: 'conversation',
        flujo: true,
        requireApproval: requireApprovalOf(parent.requireApproval),
        userTurn: false,
        source: options.source ?? 'chat',
      });
    });
    return { status: 'continued', runStatus: run.status };
  });
  if (result.status === 'continued' || result.status === 'dispatched') {
    await reconcileScheduledRun(rootId).catch((error) =>
      log.warn('Could not update the scheduled run after a Human step', { conversationId: rootId, error }));
  }
  return result;
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
 *
 * A sub-flow child does not go on alone: its answer is used there, then the top run
 * that waits for it goes on (`continueWaitingParent`). A Persona's run only changes
 * through its dispatcher; with `answer`, the answer is checked first and recorded inside
 * the dispatcher's preparation, with fresh authority.
 */
export async function continueHumanTask(
  conversationId: string,
  options: { requestId?: string; expire?: boolean; now?: Date; answer?: HumanTaskAnswerOption } = {},
): Promise<HumanTaskContinuation> {
  const root = await waitingRootOf(conversationId);
  const now = options.now ?? new Date();
  let handOff: { consumeChild?: (install: (state: SharedState) => void) => Promise<void>; source: FlowInvocationSource } | undefined;
  let requestId = options.requestId;

  const result = await withConversationExecutionLock(conversationId, async (): Promise<HumanTaskContinuation> => {
    const state = await loadConversationState(conversationId);
    const task = state?.humanTask;
    if (!state || !task || (options.requestId && task.requestId !== options.requestId)) return { status: 'idle' };
    if (state.personaArchived) return { status: 'blocked', reason: 'An anonymized Persona archive is read-only.' };
    requestId = task.requestId;
    const persona = isPersonaOwnedConversationState(state);
    if (options.answer) {
      const refusal = dryRun(state, task.requestId, options.answer);
      if (refusal) return { status: 'refused', refusal };
      if (!persona) recordAnswer(state, task.requestId, options.answer);
    }

    const overdue = !task.decision && options.expire === true && now.getTime() >= Date.parse(task.expiresAt);
    if (!task.decision && !overdue && !(persona && options.answer)) return { status: 'idle' };
    const waiting = state.status === 'awaiting_tool_approval'
      && !!state.pendingToolCalls?.some((call) => call.id === task.toolCallId);
    // A run that stopped after the answer was handed over but before the step used it
    // is still 'running' on disk. Anything else has moved on and is left alone.
    if (!waiting && state.status !== 'running') return { status: 'idle' };
    const source: FlowInvocationSource = overdue || task.decision?.channel === 'expiry' ? 'internal' : 'chat';
    const consume = async (target: SharedState) => {
      recordAnswer(target, task.requestId, persona ? options.answer : undefined);
      await consumeSavedAnswer(conversationId, target, { overdue, now });
    };

    if (root !== conversationId) {
      // A sub-flow child: use the answer here, then let the waiting parent go on.
      if (persona) {
        handOff = {
          source,
          consumeChild: async (install) => {
            const child = await loadConversationState(conversationId);
            if (!child) return;
            install(child);
            await consume(child);
          },
        };
      } else {
        await consume(state);
        handOff = { source };
      }
      return { status: 'idle' };
    }

    if (persona) {
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
        if (options.answer) await persistConversationState(`conversations/${conversationId}` as StorageKey, state);
        return { status: 'busy' };
      }
      throw error;
    }
    const run = await withFlowRunAdmission(permit, async () => {
      await consume(state);
      return runFlow({
        conversationId,
        mode: 'conversation',
        flujo: true,
        requireApproval: requireApprovalOf(state.requireApproval),
        userTurn: false,
        source,
      });
    });
    await reconcileScheduledRun(conversationId).catch((error) =>
      log.warn('Could not update the scheduled run after a Human step', { conversationId, error }));
    return { status: 'continued', runStatus: run.status };
  });

  const continued = handOff ? await continueWaitingParent(root, handOff) : result;
  if (!options.answer || continued.status === 'refused' || !requestId) return continued;
  const receipt = receiptOf(await loadConversationState(conversationId).catch(() => undefined), requestId);
  return continued.status === 'continued' || continued.status === 'dispatched' ? { ...continued, receipt } : continued;
}
