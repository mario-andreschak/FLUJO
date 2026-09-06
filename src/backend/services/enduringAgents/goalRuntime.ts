import {
  PersonaWorkItemSchema,
  type PersonaActivity,
  type PersonaGoalConfig,
  type PersonaGoalState,
  type PersonaWorkItem,
} from '@/shared/types/enduringAgent';
import { isEncryptionLocked } from '@/utils/encryption/secure';
import { createLogger } from '@/utils/logger';
import { getCurrentWorkspace, runWithWorkspace } from '@/utils/workspace';
import { workspaceMutationStatus } from '@/backend/services/workspace/workspaceMutationGate';
import { PersonaDomainConflictError } from './domainMutation';
import { stableEnduringAgentId } from './ids';
import {
  getPersonaFlowDispatch,
  personaFlowDispatchId,
  cancelPersonaFlowDispatchById,
  pumpPersonaFlowDispatches,
  submitPersonaFlowDispatch,
} from './personaDispatcher';
import { getPersonaRuntimeClock, type PersonaRuntimeTimer } from './runtimeClock';
import { withPersonaRuntimeLock } from './runtimeLock';
import {
  getPersona,
  getPersonaActivity,
  getPersonaDeletionTombstone,
  getPersonaWorkItem,
  listPersonasStrict,
  listPersonaWorkItems,
  savePersonaWorkItem,
} from './store';

const log = createLogger('backend/services/enduringAgents/goalRuntime');
const clock = getPersonaRuntimeClock();
const DAY_MS = 24 * 60 * 60 * 1_000;
const POLL_MS = 10_000;
const HUMAN_BLOCKERS = new Set(['information', 'approval', 'permission', 'policy']);
const TERMINAL_TASKS = new Set(['completed', 'cancelled']);
const PRIORITY = { urgent: 0, high: 1, normal: 2, low: 3 };

export function initialPersonaGoalState(config: PersonaGoalConfig, now = clock.now()): PersonaGoalState {
  return {
    ...config,
    completionPolicy: config.completionPolicy ?? 'success_criteria',
    continuationIntervalMs: config.continuationIntervalMs ?? 60_000,
    maxConsecutiveFailures: config.maxConsecutiveFailures ?? 3,
    maxRoundsPerDay: config.maxRoundsPerDay ?? 1_440,
    state: 'active',
    nextRunAt: now,
    rounds: 0,
    consecutiveFailures: 0,
    dailyWindowStartedAt: now,
    roundsInWindow: 0,
  };
}

export function clearPersonaGoalPending(goal: PersonaGoalState): PersonaGoalState {
  return {
    ...goal,
    pendingTaskId: undefined,
    pendingAttemptKey: undefined,
    pendingPrompt: undefined,
    pendingPriority: undefined,
    pendingDispatchId: undefined,
  };
}

function ready(item: PersonaWorkItem, records: readonly PersonaWorkItem[]): boolean {
  return (item.status === 'open' || item.status === 'in_progress')
    && !item.goalControlState
    && (item.deferredUntil ?? 0) <= clock.now()
    && item.dependencyIds.every((id) => records.some((record) => record.id === id && record.status === 'completed'));
}

/** Durable guard for dispatcher recovery/claim paths, which cannot retain an admission closure. */
export async function assertPersonaGoalDispatchCurrent(input: {
  personaId: string;
  taskId: string;
  dispatchId: string;
  requireReady: boolean;
}): Promise<void> {
  const { personaId, taskId, dispatchId, requireReady } = input;
  const task = await getPersonaWorkItem(personaId, taskId);
  if (!task || (!task.goal && !task.parentGoalId)) return;
  const root = task.goal ? task : await getPersonaWorkItem(personaId, task.parentGoalId!);
  if (!root?.goal || root.goal.state !== 'active' || root.goal.pendingTaskId !== task.id
    || root.goal.pendingDispatchId !== dispatchId || task.revokedGoalDispatchId === dispatchId) {
    throw new PersonaDomainConflictError('The ongoing goal no longer authorizes this saved round.', 'PERSONA_GOAL_NOT_CURRENT');
  }
  if (requireReady) {
    const records = await listPersonaWorkItems(personaId);
    if (!ready(task, records)
      || !root.dependencyIds.every((id) => records.some((item) => item.id === id && item.status === 'completed'))) {
      throw new PersonaDomainConflictError('The ongoing goal Task is no longer ready for this saved round.', 'PERSONA_GOAL_NOT_CURRENT');
    }
  }
}

/** Pure terminal policy. An Activity finishing is not the same as achieving its goal. */
export function projectPersonaGoalOutcome(
  root: PersonaWorkItem,
  task: PersonaWorkItem,
  activity: PersonaActivity,
  records: readonly PersonaWorkItem[],
  now = clock.now(),
): { root: PersonaWorkItem; taskStatus: PersonaWorkItem['status']; taskDeferredUntil?: number } {
  const original = root.goal!;
  if (original.lastActivityId === activity.id || original.state !== 'active') {
    return { root, taskStatus: task.status };
  }
  const outcome = activity.outcome;
  const isRoot = root.id === task.id;
  const success = activity.status === 'completed' && outcome?.resolution === 'succeeded';
  const taskDependenciesComplete = task.dependencyIds.every((id) => records.some((item) => item.id === id && item.status === 'completed'));
  const unfinishedChildren = records.some((item) => item.parentGoalId === root.id
    && item.id !== task.id && !TERMINAL_TASKS.has(item.status));
  const achieved = original.completionPolicy !== 'until_stopped'
    && isRoot && success && outcome?.goalAchieved === true && !unfinishedChildren
    && root.dependencyIds.every((id) => records.some((item) => item.id === id && item.status === 'completed'));
  const humanBlocker = Boolean(outcome?.blockerKind && HUMAN_BLOCKERS.has(outcome.blockerKind));
  const partialProgress = activity.status === 'completed' && outcome?.resolution === 'partial'
    && Boolean(outcome.summary && outcome.summary !== original.progressSummary);
  const progress = success || partialProgress;
  const failures = progress ? 0 : original.consecutiveFailures + 1;
  const otherReadyChildren = records.some((item) => item.parentGoalId === root.id && item.id !== task.id && ready(item, records));
  const exhausted = failures >= original.maxConsecutiveFailures;
  const recovering = exhausted || humanBlocker;
  const taskRetryDelay = Math.max(original.continuationIntervalMs, outcome?.retryAfterMs ?? 0,
    progress ? 0 : Math.min(6 * 60 * 60 * 1_000, original.continuationIntervalMs * 2 ** Math.min(failures - 1, 10)));
  const delay = otherReadyChildren ? original.continuationIntervalMs
    : Math.max(original.continuationIntervalMs, outcome?.retryAfterMs ?? 0,
    recovering ? Math.min(6 * 60 * 60 * 1_000, 5 * 60_000 * 2 ** Math.min(original.recoveryCount ?? 0, 6))
      : progress ? 0 : Math.min(6 * 60 * 60 * 1_000, original.continuationIntervalMs * 2 ** Math.min(failures - 1, 10)));
  const reason = humanBlocker
    ? outcome?.nextAction ?? outcome?.summary ?? 'This goal needs information or authorization before it can continue.'
    : 'Repeated attempts made no verified progress. Reassess the approach, inspect prior effects, and execute a different strategy.';
  const taskStatus = achieved ? 'completed'
    : isRoot ? 'open'
      : success ? taskDependenciesComplete ? 'completed' : 'open'
        : humanBlocker || exhausted ? 'blocked' : 'open';
  const nextGoal: PersonaGoalState = {
    ...clearPersonaGoalPending(original),
    state: achieved ? 'completed' : 'active',
    nextRunAt: achieved ? undefined : now + delay,
    consecutiveFailures: recovering ? 0 : failures,
    recoveryCount: (original.recoveryCount ?? 0) + (recovering ? 1 : 0),
    recoveryNotes: progress ? original.recoveryNotes : [...(original.recoveryNotes ?? []),
      `${outcome?.resolution ?? activity.status}: ${outcome?.summary ?? activity.error ?? 'No structured progress reported.'} ${outcome?.nextAction ?? ''}`.slice(0, 2_000)].slice(-10),
    ...(progress ? { lastProgressAt: now } : {}),
    progressSummary: outcome?.summary ?? original.progressSummary,
    interventionReason: humanBlocker ? reason : undefined,
    lastActivityId: activity.id,
  };
  return {
    root: PersonaWorkItemSchema.parse({
      ...root,
      status: achieved ? 'completed' : 'open',
      goal: nextGoal,
      nextAction: recovering ? `${reason} Continue any independent work and periodically recheck the blocked dependency.` : outcome?.nextAction ?? root.nextAction,
      updatedAt: Math.max(now, root.updatedAt + 1),
      completedAt: achieved ? now : undefined,
    }) as PersonaWorkItem,
    taskStatus,
    ...(!isRoot && !success && !humanBlocker && !exhausted && (!progress || outcome?.retryAfterMs)
      ? { taskDeferredUntil: now + taskRetryDelay } : {}),
  };
}

function roundPrompt(root: PersonaWorkItem, task: PersonaWorkItem, records: PersonaWorkItem[]): string {
  return [
    'Advance this ongoing Persona goal autonomously. Perform concrete useful work, verify results, and preserve the next step.',
    'When available, call report_activity_outcome before finishing. succeeded means this round/task succeeded, not that the entire goal is done. Set goal_achieved:true only in a goal round after verifying all success criteria and completing all goal tasks. For ongoing responsibilities without a finite end, leave goal_achieved false.',
    'Use partial with the concrete progress and next_action when more work remains; use transient/external blocker_kind and retry_after_ms when waiting can resolve a problem. The runtime will continue without another user prompt.',
    'If this immutable Flow does not expose report_activity_outcome, include a legacy outcome tag in your final assistant output instead: <persona_activity_outcome>{"resolution":"partial","summary":"Describe actual verified progress","nextAction":"Describe the next concrete action","goalAchieved":false}</persona_activity_outcome>. Replace the example values with your actual outcome; use camelCase nextAction, blockerKind, retryAfterMs, and goalAchieved in this legacy JSON. Use succeeded only for a successful round/task and goalAchieved:true only for verified completion of the entire goal.',
    `Goal ID: ${root.id}`,
    `Goal: ${root.title}`,
    root.description ? `Goal details: ${root.description.slice(0, 10_000)}` : '',
    `Success criteria: ${root.goal!.successCriteria}`,
    root.goal!.completionPolicy === 'until_stopped'
      ? 'Completion policy: keep this responsibility active until its owner stops it. Report achieved milestones as round progress; never declare this ongoing responsibility complete.'
      : 'Completion policy: finish only when all success criteria have been verified.',
    `Current assigned Task ID: ${task.id}`,
    task.id !== root.id ? `Task: ${task.title}\n${task.description?.slice(0, 10_000) ?? ''}` : 'This is a goal planning/execution round. Choose the most useful next action and execute it.',
    `Last progress: ${root.goal!.progressSummary ?? 'No previous progress recorded.'}`,
    ...(root.goal!.recoveryNotes?.length ? ['Previous failed approaches (inspect the evidence and choose alternatives):', ...root.goal!.recoveryNotes.slice(-5)] : []),
    `Next step: ${(task.nextAction ?? root.nextAction ?? 'Inspect existing work, then choose and execute the next useful action.').slice(0, 2_000)}`,
    'Existing goal tasks (reuse these IDs; do not duplicate existing commitments):',
    ...records.filter((item) => item.parentGoalId === root.id).slice(0, 40).map((item) => (
      `- ${item.id} [${item.status}${item.goalControlState ? `; owner ${item.goalControlState}` : ''}${item.deferredUntil ? `; retry after ${new Date(item.deferredUntil).toISOString()}` : ''}] ${item.title}; next: ${item.nextAction?.slice(0, 500) ?? ''}`
    )),
    'When available, use work_item_list to inspect the complete backlog and any shortened task details. New tasks you create inherit this goal and will run automatically after this Activity.',
    'Respect owner-paused and owner-stopped Tasks. Do not reopen them or create replacement Tasks to bypass that choice; continue independent work instead.',
    'Resolve ordinary blockers yourself and try alternatives. Ask for human input only when required information, authorization, or an external decision is genuinely unavailable; keep independent work moving.',
    'Before repeating an interrupted or failed operation, inspect persisted artifacts and external state to avoid duplicate side effects.',
  ].filter(Boolean).join('\n').slice(0, 100_000);
}

interface GoalWorkspaceRuntime {
  workspaceId: string;
  personaIds: Set<string>;
  timer?: PersonaRuntimeTimer;
  running?: Promise<void>;
  stopped: boolean;
}

declare global {
  var __flujo_persona_goal_runtimes_v1: Map<string, GoalWorkspaceRuntime> | undefined;
}
const runtimes = global.__flujo_persona_goal_runtimes_v1 ??= new Map<string, GoalWorkspaceRuntime>();

function runtime(): GoalWorkspaceRuntime {
  const workspaceId = getCurrentWorkspace();
  let current = runtimes.get(workspaceId);
  if (!current) {
    current = { workspaceId, personaIds: new Set(), stopped: false };
    runtimes.set(workspaceId, current);
  }
  return current;
}

async function reserveRound(personaId: string): Promise<PersonaWorkItem | null> {
  return withPersonaRuntimeLock(personaId, async (lock) => {
    const persona = await getPersona(personaId);
    if (!persona || await getPersonaDeletionTombstone(personaId)
      || persona.lifecycleState === 'disabled' || persona.lifecycleState === 'sleeping'
      || persona.provisioningState !== 'ready') return null;
    const records = await listPersonaWorkItems(personaId);
    const now = clock.now();
    const roots = records.filter((item) => item.goal?.state === 'active' && !TERMINAL_TASKS.has(item.status))
      .sort((a, b) => (a.goal!.nextRunAt ?? 0) - (b.goal!.nextRunAt ?? 0)
        || PRIORITY[a.priority] - PRIORITY[b.priority] || a.createdAt - b.createdAt);
    // Keep an admitted round serialized, but do not let an unadmitted intent
    // in backoff starve independent goals. Frozen intents retain their IDs.
    for (const pending of roots.filter((item) => item.goal!.pendingAttemptKey)) {
      const dispatch = pending.goal!.pendingDispatchId ? await getPersonaFlowDispatch(pending.goal!.pendingDispatchId!) : null;
      const admitted = dispatch && (dispatch.state === 'running' || dispatch.state === 'waiting'
        || (dispatch.state === 'queued' && dispatch.mailboxItemId));
      if (admitted || (pending.goal!.nextRunAt ?? 0) <= now) return pending;
    }
    for (const root of roots) {
      const goal = { ...root.goal! };
      if ((goal.nextRunAt ?? 0) > now) continue;
      if (!root.dependencyIds.every((id) => records.some((item) => item.id === id && item.status === 'completed'))) continue;
      if (goal.maxRounds !== undefined && goal.rounds >= goal.maxRounds) {
        await lock.assertOwned();
        await savePersonaWorkItem({ ...root, status: 'blocked', updatedAt: Math.max(now, root.updatedAt + 1),
          goal: { ...goal, state: 'needs_input', nextRunAt: undefined, interventionReason: 'The configured total round limit was reached. Increase the limit or remove it, then resume.' } });
        continue;
      }
      if (now - goal.dailyWindowStartedAt >= DAY_MS) {
        goal.dailyWindowStartedAt = now;
        goal.roundsInWindow = 0;
      }
      if (goal.roundsInWindow >= goal.maxRoundsPerDay) {
        await lock.assertOwned();
        await savePersonaWorkItem({ ...root, updatedAt: Math.max(now, root.updatedAt + 1), goal: {
          ...goal, nextRunAt: goal.dailyWindowStartedAt + DAY_MS,
        } });
        continue;
      }
      const children = records.filter((item) => item.parentGoalId === root.id && ready(item, records))
        .sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority] || a.createdAt - b.createdAt);
      const task = children[0] ?? root;
      if (task === root && !ready(root, records)) continue;
      const round = goal.rounds + 1;
      const attemptKey = stableEnduringAgentId('goalround', { workspaceId: getCurrentWorkspace(), personaId, goalId: root.id, round });
      const reserved = PersonaWorkItemSchema.parse({
        ...root,
        updatedAt: Math.max(now, root.updatedAt + 1),
        goal: {
          ...goal,
          rounds: round,
          roundsInWindow: goal.roundsInWindow + 1,
          pendingTaskId: task.id,
          pendingAttemptKey: attemptKey,
          pendingDispatchId: personaFlowDispatchId(personaId, attemptKey),
          pendingPrompt: roundPrompt(root, task, records),
          pendingPriority: task.priority,
        },
      }) as PersonaWorkItem;
      await lock.assertOwned();
      return savePersonaWorkItem(reserved);
    }
    return null;
  });
}

async function advancePersona(personaId: string): Promise<void> {
  if (workspaceMutationStatus().blocked || runtime().stopped) return;
  const root = await reserveRound(personaId);
  if (!root?.goal?.pendingAttemptKey || !root.goal.pendingTaskId || !root.goal.pendingPrompt) return;
  try { await advanceReservedGoal(root); }
  catch (error) {
    log.warn(`Could not admit ongoing goal ${root.id}:`, error);
    await recoverGoalAdmissionFailure(personaId, error, root.id);
  }
}

async function advanceReservedGoal(root: PersonaWorkItem): Promise<void> {
  const personaId = root.personaId;
  const intent = root.goal!;
  let dispatch = intent.pendingDispatchId ? await getPersonaFlowDispatch(intent.pendingDispatchId) : null;
  const task = await getPersonaWorkItem(personaId, intent.pendingTaskId!);
  if (intent.pendingDispatchId && task?.revokedGoalDispatchId === intent.pendingDispatchId) {
    // Recover a control interrupted after saving the child's revocation but
    // before releasing its root's pending round or cancelling the dispatcher.
    await withPersonaRuntimeLock(personaId, async (lock) => {
      const current = await getPersonaWorkItem(personaId, root.id);
      if (current?.goal?.state !== 'active' || current.goal.pendingDispatchId !== intent.pendingDispatchId) return;
      await lock.assertOwned();
      await savePersonaWorkItem({ ...current, updatedAt: Math.max(clock.now(), current.updatedAt + 1),
        goal: { ...clearPersonaGoalPending(current.goal), nextRunAt: clock.now() } });
    });
    if (dispatch && !['completed', 'error', 'cancelled'].includes(dispatch.state)) {
      await cancelPersonaFlowDispatchById({ personaId, dispatchId: dispatch.id,
        reason: 'This goal Task was paused or stopped by its owner.' }, { waitForCompletion: true });
    }
    notifyPersonaGoalChanged(personaId);
    return;
  }
  if (!dispatch || (dispatch.state === 'queued' && !dispatch.mailboxItemId)) {
    const admitted = await submitPersonaFlowDispatch({
      personaId,
      idempotencyKey: intent.pendingAttemptKey!,
      kind: 'assignment',
      priority: intent.pendingPriority ?? root.priority,
      source: { kind: 'assignment', sourceId: intent.pendingTaskId },
      relationKey: `persona-task:${intent.pendingTaskId}`,
      summary: `Ongoing goal ${root.id}`,
      flowInput: { messages: [{ role: 'user', content: intent.pendingPrompt! }], mode: 'conversation',
        title: `Ongoing goal ${root.id}`, source: 'internal', userTurn: true,
        requireApproval: false, onApprovalRequired: 'fail' },
    }, {
      waitForCompletion: false,
      validateAdmission: async () => {
        const current = await getPersonaWorkItem(personaId, root.id);
        const task = await getPersonaWorkItem(personaId, intent.pendingTaskId!);
        const persona = await getPersona(personaId);
        const records = task ? await listPersonaWorkItems(personaId) : [];
        if (runtime().stopped || workspaceMutationStatus().blocked || !current || current.goal?.state !== 'active' || current.goal.pendingAttemptKey !== intent.pendingAttemptKey
          || !task || !ready(task, records)
          || !persona || ['disabled', 'sleeping'].includes(persona.lifecycleState)) {
          throw new PersonaDomainConflictError('The ongoing goal is no longer ready for this round.');
        }
      },
    });
    dispatch = admitted.dispatch;
    await withPersonaRuntimeLock(personaId, async (lock) => {
      const current = await getPersonaWorkItem(personaId, root.id);
      if (!current?.goal || current.goal.pendingAttemptKey !== intent.pendingAttemptKey) return;
      await lock.assertOwned();
      await savePersonaWorkItem({ ...current, updatedAt: Math.max(clock.now(), current.updatedAt + 1),
        goal: { ...current.goal, pendingDispatchId: dispatch!.id } });
    });
  }
  if (dispatch.state === 'queued' && dispatch.mailboxItemId && !runtime().stopped && !workspaceMutationStatus().blocked) {
    void pumpPersonaFlowDispatches(personaId).catch((error) => log.warn(`Could not resume admitted goal work for ${personaId}:`, error));
  }
  if (dispatch.activityId && ['completed', 'error', 'cancelled'].includes(dispatch.state)) {
    const activity = await getPersonaActivity(personaId, dispatch.activityId);
    if (activity) {
      const { synchronizeAssignedWorkItemFromActivity } = await import('./workItems');
      await synchronizeAssignedWorkItemFromActivity(activity);
    }
  } else if (!dispatch.activityId && ['completed', 'error', 'cancelled'].includes(dispatch.state)) {
    await recordGoalAdmissionFailure(personaId, root, dispatch.error?.message ?? 'The goal round ended before acquiring execution authority.', true);
  }
}

async function recordGoalAdmissionFailure(personaId: string, root: PersonaWorkItem, message: string, clearPending: boolean): Promise<void> {
  await withPersonaRuntimeLock(personaId, async (lock) => {
    const current = await getPersonaWorkItem(personaId, root.id);
    if (!current?.goal || current.goal.state !== 'active'
      || current.goal.pendingAttemptKey !== root.goal?.pendingAttemptKey) return;
    const failures = current.goal.consecutiveFailures + 1;
    const now = clock.now();
    await lock.assertOwned();
    await savePersonaWorkItem({ ...current, updatedAt: Math.max(now, current.updatedAt + 1),
      nextAction: `Inspect and recover the previous admission failure before repeating work: ${message.slice(0, 2_000)}`,
      goal: {
        ...(clearPending ? clearPersonaGoalPending(current.goal) : current.goal),
        consecutiveFailures: failures,
        nextRunAt: now + Math.min(6 * 60 * 60 * 1_000, current.goal.continuationIntervalMs * 2 ** Math.min(failures - 1, 10)),
        recoveryNotes: [...(current.goal.recoveryNotes ?? []), message.slice(0, 2_000)].slice(-10),
      },
    });
  });
}

async function recoverGoalAdmissionFailure(personaId: string, error: unknown, rootId: string): Promise<void> {
  const records = await listPersonaWorkItems(personaId);
  const root = records.find((item) => item.id === rootId && item.goal?.state === 'active' && item.goal.pendingAttemptKey);
  if (!root?.goal) return;
  const task = records.find((item) => item.id === root.goal!.pendingTaskId);
  // A changed/deleted dependency invalidates this frozen admission intent. Cancel
  // it before replanning, so a later startup cannot resurrect the old delivery.
  const invalid = !task || !ready(task, records);
  if (invalid && root.goal.pendingDispatchId) {
    const dispatch = await getPersonaFlowDispatch(root.goal.pendingDispatchId);
    if (dispatch && !['completed', 'error', 'cancelled'].includes(dispatch.state)) {
      await cancelPersonaFlowDispatchById({ personaId, dispatchId: dispatch.id,
        reason: 'The saved goal task changed before its round could be admitted.' }, { waitForCompletion: true });
    }
  }
  await recordGoalAdmissionFailure(personaId, root, error instanceof Error ? error.message : 'Goal admission failed.', invalid);
}

function arm(current: GoalWorkspaceRuntime, delay = POLL_MS): void {
  if (current.stopped) return;
  current.timer?.clear();
  current.timer = clock.setTimer(() => {
    current.timer = undefined;
    void runWithWorkspace(current.workspaceId, () => reconcilePersonaGoals()).catch((error) => {
      log.warn('Ongoing goal reconciliation failed:', error);
    });
  }, delay);
  current.timer.unref();
}

/** Register a newly created/changed goal without holding the caller's mutation lock. */
export function notifyPersonaGoalChanged(personaId: string): void {
  const current = runtime();
  current.personaIds.add(personaId);
  if (current.stopped) return;
  arm(current, 1);
}

/** Bounded per-workspace sweep. No model calls occur outside normal Persona dispatch. */
export function reconcilePersonaGoals(personaId?: string): Promise<void> {
  const current = runtime();
  if (current.stopped) return Promise.resolve();
  if (personaId) current.personaIds.add(personaId);
  if (current.running) return current.running;
  current.running = runWithWorkspace(current.workspaceId, async () => {
    if (await isEncryptionLocked() || workspaceMutationStatus().blocked) return;
    for (const id of current.personaIds) {
      if (current.stopped) break;
      try { await advancePersona(id); }
      catch (error) {
        log.warn(`Could not advance ongoing goals for ${id}:`, error);
      }
    }
  }).finally(() => { current.running = undefined; arm(current); });
  return current.running;
}

/** Called after workspace unlock and runtime recovery. Pending intents retain their attempt IDs. */
export async function startPersonaGoalRuntime(): Promise<void> {
  const current = runtime();
  current.stopped = false;
  for (const persona of await listPersonasStrict()) current.personaIds.add(persona.id);
  await reconcilePersonaGoals();
}

export function stopPersonaGoalRuntime(): void {
  const current = runtime();
  current.stopped = true;
  current.timer?.clear();
  current.timer = undefined;
}
