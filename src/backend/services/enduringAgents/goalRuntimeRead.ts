import { getCurrentWorkspace } from '@/utils/workspace';
import {
  getPersonaActivity,
  getPersonaLease,
  getPersonaMailboxItem,
  getPersonaWorkItem,
} from './store';
import { getPersonaFlowDispatch, personaFlowDispatchId } from './personaDispatcher';
import { readPersonaRuntimeEvents } from './runtimeEvents';

/**
 * Read a single Goal's persisted execution lineage. Every returned field is an
 * explicit projection: dispatch inputs, mailbox payloads, Activity context and
 * lease capabilities never leave this boundary.
 */
async function readSnapshot(personaId: string, goalId: string) {
  const root = await getPersonaWorkItem(personaId, goalId);
  if (!root || root.personaId !== personaId || root.parentGoalId || !root.goal) {
    throw new Error('Goal not found for this Persona.');
  }
  const goal = root.goal;
  const result = {
    goal: {
      id: root.id,
      status: root.status,
      state: goal.state,
      version: root.updatedAt,
      nextAction: root.nextAction ?? null,
      nextRunAt: goal.nextRunAt ?? null,
      rounds: goal.rounds,
    },
    state: 'registered' as 'registered' | 'reserved' | 'queued' | 'accepted_running' | 'terminal_observed' | 'unverified',
    verified: false,
    reason: null as string | null,
    round: null as null | { number: number; attemptId: string; taskId: string; dispatchId: string },
    dispatch: null as null | { id: string; state: string },
    mailbox: null as null | { id: string; status: string },
    activity: null as null | { id: string; status: string; runId: string | null; conversationId: string | null },
    lease: null as null | { id: string; status: string },
  };
  const unverified = (reason: string) => ({ ...result, state: 'unverified' as const, verified: false, reason });
  const pending = [goal.pendingTaskId, goal.pendingAttemptKey, goal.pendingDispatchId];
  const hasPending = pending.some(Boolean);
  let round: typeof result.round = null;
  if (hasPending) {
    if (!pending.every(Boolean) || !goal.rounds) return unverified('incomplete_pending_round');
    round = {
      number: goal.rounds,
      taskId: goal.pendingTaskId!,
      attemptId: goal.pendingAttemptKey!,
      dispatchId: goal.pendingDispatchId!,
    };
  } else if (goal.rounds > 0) {
    // A completed round clears pending fields. Only the saved round event may
    // restore its task/attempt/dispatch identity; a lastActivityId alone cannot.
    const events = await readPersonaRuntimeEvents(personaId, { tail: 256 });
    const latest = [...events].reverse().find(event => event.type === 'goal:round' && event.goalId === root.id);
    if (!latest || latest.type !== 'goal:round' || latest.round !== goal.rounds) {
      return unverified('round_event_unavailable');
    }
    round = {
      number: latest.round,
      taskId: latest.taskId,
      attemptId: latest.attemptKey,
      dispatchId: latest.dispatchId,
    };
  }
  if (!round) return result;
  result.round = round;
  if (round.dispatchId !== personaFlowDispatchId(personaId, round.attemptId)) {
    return unverified('round_dispatch_mismatch');
  }
  const task = round.taskId === root.id ? root : await getPersonaWorkItem(personaId, round.taskId);
  if (!task || task.personaId !== personaId
    || (task.id !== root.id && task.parentGoalId !== root.id)
    || task.revokedGoalDispatchId === round.dispatchId) {
    return unverified('round_task_mismatch');
  }
  const dispatch = await getPersonaFlowDispatch(round.dispatchId);
  if (!dispatch) {
    if (!hasPending) return unverified('historical_round_not_current');
    result.state = 'reserved';
    result.verified = true;
    return result;
  }
  if (dispatch.id !== round.dispatchId || dispatch.personaId !== personaId
    || dispatch.workspaceId !== getCurrentWorkspace()
    || dispatch.admission.kind !== 'assignment'
    || dispatch.admission.source.kind !== 'assignment'
    || dispatch.admission.source.sourceId !== round.taskId) {
    return unverified('dispatch_identity_mismatch');
  }
  result.dispatch = { id: dispatch.id, state: dispatch.state };
  // A saved round can identify terminal history, but only the Goal's current
  // pending fields can verify a reservation or queued mailbox.
  if (!hasPending && !dispatch.activityId) return unverified('historical_round_not_current');
  if (!dispatch.mailboxItemId) {
    if (dispatch.activityId || dispatch.state !== 'queued') return unverified('dispatch_without_mailbox');
    result.state = 'reserved';
    result.verified = true;
    return result;
  }
  const mailbox = await getPersonaMailboxItem(personaId, dispatch.mailboxItemId);
  if (!mailbox || mailbox.personaId !== personaId || mailbox.id !== dispatch.mailboxItemId
    || mailbox.payloadRef !== dispatch.id || mailbox.kind !== 'assignment'
    || mailbox.source.kind !== 'assignment' || mailbox.source.sourceId !== round.taskId
    || mailbox.routingDecision !== 'queue') {
    return unverified('mailbox_identity_mismatch');
  }
  result.mailbox = { id: mailbox.id, status: mailbox.status };
  if (!dispatch.activityId) {
    if (mailbox.claimedActivityId || dispatch.state !== 'queued' || mailbox.status !== 'queued') {
      return unverified('activity_admission_incomplete');
    }
    result.state = 'queued';
    result.verified = true;
    return result;
  }
  const activity = await getPersonaActivity(personaId, dispatch.activityId);
  if (!activity || activity.personaId !== personaId || activity.id !== dispatch.activityId
    || mailbox.claimedActivityId !== activity.id
    || activity.source.kind !== 'assignment' || activity.source.sourceId !== round.taskId
    || activity.entryPointPayloadRef !== dispatch.id
    || (goal.lastActivityId && !hasPending && goal.lastActivityId !== activity.id)) {
    return unverified('activity_identity_mismatch');
  }
  result.activity = {
    id: activity.id,
    status: activity.status,
    runId: activity.runId ?? null,
    conversationId: activity.conversationId ?? null,
  };
  const terminal = ['completed', 'cancelled', 'error'];
  if (terminal.includes(dispatch.state) && terminal.includes(activity.status)) {
    result.state = 'terminal_observed';
    result.verified = true;
    return result;
  }
  if (!['running', 'waiting'].includes(dispatch.state)
    || !['running', 'waiting'].includes(activity.status)) {
    return unverified('execution_state_mismatch');
  }
  if (!hasPending) return unverified('historical_round_not_current');
  const lease = await getPersonaLease(personaId);
  if (!lease || lease.workspaceId !== getCurrentWorkspace() || lease.personaId !== personaId
    || lease.activityId !== activity.id || lease.id !== activity.leaseId
    || lease.status !== 'active' || lease.expiresAt <= Date.now()) {
    return unverified('current_lease_mismatch');
  }
  result.lease = { id: lease.id, status: lease.status };
  result.state = 'accepted_running';
  result.verified = true;
  return result;
}

export async function readPersonaGoalRuntime(personaId: string, goalId: string) {
  const snapshot = await readSnapshot(personaId, goalId);
  const changed = (reason: string) => ({ ...snapshot, state: 'unverified' as const, verified: false, reason });
  // The joins span separate persisted records. Check the root again after the
  // async reads and never promote a drifting view to accepted execution.
  const root = await getPersonaWorkItem(personaId, goalId);
  if (!root || root.personaId !== personaId || !root.goal || root.parentGoalId
    || root.updatedAt !== snapshot.goal.version || root.goal.rounds !== snapshot.goal.rounds
    || (snapshot.round && root.goal.pendingAttemptKey
      && (root.goal.pendingAttemptKey !== snapshot.round.attemptId
        || root.goal.pendingTaskId !== snapshot.round.taskId
        || root.goal.pendingDispatchId !== snapshot.round.dispatchId))) {
    return changed('snapshot_changed');
  }
  const currentPending = (candidate: typeof root) => candidate?.goal?.pendingTaskId === snapshot.round?.taskId
    && candidate?.goal?.pendingAttemptKey === snapshot.round?.attemptId
    && candidate?.goal?.pendingDispatchId === snapshot.round?.dispatchId;
  if (['reserved', 'queued', 'accepted_running'].includes(snapshot.state) && !currentPending(root)) {
    return changed('snapshot_changed');
  }
  if (snapshot.state !== 'accepted_running' && snapshot.state !== 'terminal_observed') return snapshot;
  const round = snapshot.round!;
  const dispatch = await getPersonaFlowDispatch(round.dispatchId);
  const mailbox = snapshot.mailbox && await getPersonaMailboxItem(personaId, snapshot.mailbox.id);
  const activity = snapshot.activity && await getPersonaActivity(personaId, snapshot.activity.id);
  if (!dispatch || dispatch.personaId !== personaId || dispatch.workspaceId !== getCurrentWorkspace()
    || dispatch.state !== snapshot.dispatch?.state || dispatch.activityId !== snapshot.activity?.id
    || dispatch.mailboxItemId !== snapshot.mailbox?.id
    || !mailbox || mailbox.personaId !== personaId || mailbox.payloadRef !== round.dispatchId
    || mailbox.status !== snapshot.mailbox?.status || mailbox.claimedActivityId !== snapshot.activity?.id
    || !activity || activity.personaId !== personaId || activity.status !== snapshot.activity?.status
    || activity.entryPointPayloadRef !== round.dispatchId
    || activity.runId !== (snapshot.activity?.runId ?? undefined)
    || activity.conversationId !== (snapshot.activity?.conversationId ?? undefined)) {
    return changed('bound_record_changed');
  }
  if (snapshot.state === 'accepted_running') {
    const lease = await getPersonaLease(personaId);
    if (!lease || lease.workspaceId !== getCurrentWorkspace() || lease.personaId !== personaId
      || lease.id !== snapshot.lease?.id || lease.activityId !== activity.id
      || lease.id !== activity.leaseId || lease.status !== 'active' || lease.expiresAt <= Date.now()
      || !root.goal.pendingAttemptKey || root.goal.pendingAttemptKey !== round.attemptId) {
      return changed('bound_record_changed');
    }
  }
  const finalRoot = await getPersonaWorkItem(personaId, goalId);
  if (!finalRoot || finalRoot.updatedAt !== snapshot.goal.version || finalRoot.personaId !== personaId
    || finalRoot.goal?.rounds !== snapshot.goal.rounds
    || (snapshot.state === 'accepted_running' && !currentPending(finalRoot))) return changed('snapshot_changed');
  return snapshot;
}
