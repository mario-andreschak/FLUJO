const submitMock = jest.fn();
const dispatches = new Map<string, import('@/backend/services/enduringAgents/personaDispatcher').PersonaFlowDispatchRecord>();
const dispatchIdentity = (_personaId: string, key: string) => `dispatch_${key.slice(-40)}`;

jest.mock('@/backend/services/enduringAgents/personaDispatcher', () => ({
  personaFlowDispatchId: (...args: [string, string]) => dispatchIdentity(...args),
  submitPersonaFlowDispatch: (...args: unknown[]) => submitMock(...args),
  getPersonaFlowDispatch: async (id: string) => dispatches.get(id) ?? null,
  listPersonaFlowDispatches: async (personaId: string) => [...dispatches.values()].filter((item) => item.personaId === personaId),
  cancelPersonaFlowDispatchById: async ({ dispatchId }: { dispatchId: string }) => {
    const dispatch = dispatches.get(dispatchId);
    if (dispatch) dispatches.set(dispatchId, { ...dispatch, state: 'cancelled' });
  },
  reprioritizePersonaWorkItemDispatches: async () => undefined,
}));

import {
  notifyPersonaGoalChanged,
  assertPersonaGoalDispatchCurrent,
  reconcilePersonaGoals,
  startPersonaGoalRuntime,
  stopPersonaGoalRuntime,
} from '@/backend/services/enduringAgents/goalRuntime';
import {
  controlPersonaWorkItem,
  assignPersonaWorkItem,
  createPersonaWorkItem,
  deletePersonaWorkItem,
  synchronizeAssignedWorkItemFromActivity,
  updatePersonaWorkItem,
} from '@/backend/services/enduringAgents/workItems';
import { _setPersonaRuntimeClockForTests } from '@/backend/services/enduringAgents/runtimeClock';
import {
  assertPersonaActivityLease,
  claimNextPersonaActivity,
  completePersonaActivity,
  enqueuePersonaMailboxItem,
  PersonaLeaseLostError,
  type PersonaActivityClaim,
} from '@/backend/services/enduringAgents/activityRuntime';
import { _setPersonaRuntimeLockProcessBirthProbeForTests } from '@/backend/services/enduringAgents/runtimeLock';
import { beginWorkspaceSnapshotBoundary } from '@/backend/services/workspace/workspaceMutationGate';
import {
  getPersona,
  getPersonaActivity,
  getPersonaWorkItem,
  savePersonaWorkItem,
  savePersonaActivity,
  updatePersona,
} from '@/backend/services/enduringAgents/store';
import type { PersonaActivity, PersonaActivityOutcome, PersonaGoalConfig, PersonaWorkItem } from '@/shared/types/enduringAgent';
import type { SubmitPersonaFlowDispatchInput, PersonaFlowDispatchRecord } from '@/backend/services/enduringAgents/personaDispatcher';
import type { FlowExecutionAuthority } from '@/backend/execution/flow/types';
import { runWithWorkspace } from '@/utils/workspace';
import { createPersonaFromRole } from './fixtures/personaFactory';

let sequence = 0;
let now = Date.now();

async function inWorkspace(task: () => Promise<void>): Promise<void> {
  await runWithWorkspace(`goal-runtime-${process.pid}-${++sequence}`, async () => {
    try { await task(); } finally { stopPersonaGoalRuntime(); }
  });
}

async function goal(config: Partial<PersonaGoalConfig> = {}) {
  const { persona } = await createPersonaFromRole({ name: 'Frederik', idempotencyKey: 'goal-persona' });
  const task = await createPersonaWorkItem({ personaId: persona.id, title: 'Make FLUJO known',
    goal: { successCriteria: 'Verify three completed research-backed deliverables.', continuationIntervalMs: 10_000, ...config } });
  now = Math.max(now, task.createdAt);
  return { persona, task };
}

async function current(task: PersonaWorkItem): Promise<PersonaWorkItem> {
  const record = await getPersonaWorkItem(task.personaId, task.id);
  if (!record) throw new Error('Missing test goal');
  return record;
}

async function finish(task: PersonaWorkItem, outcome: Partial<PersonaActivityOutcome> = {}, status: 'completed' | 'error' = 'completed'): Promise<PersonaActivity> {
  const root = await current(task);
  const dispatch = dispatches.get(root.goal!.pendingDispatchId!);
  if (!dispatch) throw new Error('No pending goal dispatch');
  const activity: PersonaActivity = {
    schemaVersion: 1, id: dispatch.activityId!, personaId: task.personaId,
    kind: 'assignment', status, source: { kind: 'assignment', sourceId: root.goal!.pendingTaskId },
    entryPointPayloadRef: dispatch.id,
    createdAt: now, updatedAt: now, completedAt: now,
    outcome: { schemaVersion: 1, resolution: 'partial', summary: `Concrete progress ${dispatch.activityId}`,
      nextAction: 'Execute the next verified deliverable.', decisionSource: 'persona_claim', evidenceRefs: [], decidedAt: now, ...outcome },
  };
  dispatches.set(dispatch.id, { ...dispatch, state: 'completed' });
  await synchronizeAssignedWorkItemFromActivity(activity);
  return activity;
}

function leaseFence(claim: PersonaActivityClaim) {
  return { workspaceId: claim.lease.workspaceId, personaId: claim.lease.personaId,
    activityId: claim.activity.id, leaseId: claim.lease.id, holderId: claim.lease.holderId,
    fencingToken: claim.lease.fencingToken };
}

function useRealActivityAdmission(): PersonaActivityClaim[] {
  const claims: PersonaActivityClaim[] = [];
  submitMock.mockImplementation(async (input: SubmitPersonaFlowDispatchInput, options: { validateAdmission?: () => Promise<void> }) => {
    await options.validateAdmission?.();
    const id = dispatchIdentity(input.personaId, input.idempotencyKey);
    await enqueuePersonaMailboxItem({ personaId: input.personaId, idempotencyKey: input.idempotencyKey,
      kind: 'assignment', source: input.source, payloadRef: id, summary: 'Goal round' });
    const claim = await claimNextPersonaActivity({ personaId: input.personaId, ttlMs: 1_000 });
    if (!claim) throw new Error('The real Activity runtime did not claim the goal round.');
    claims.push(claim);
    const dispatch = { id, personaId: input.personaId, state: 'running', activityId: claim.activity.id,
      mailboxItemId: claim.mailboxItem.id,
      admission: { kind: 'assignment', priority: input.priority ?? 'normal', source: input.source } } as PersonaFlowDispatchRecord;
    dispatches.set(id, dispatch);
    return { dispatch, duplicate: false, decision: 'queued' };
  });
  return claims;
}

describe('ongoing Persona goal runtime', () => {
  beforeEach(() => {
    now = Date.now();
    dispatches.clear();
    submitMock.mockReset();
    // Exercise durable lock ownership without coupling goal policy tests to a
    // sub-second Windows WMI subprocess deadline under parallel CI load.
    _setPersonaRuntimeLockProcessBirthProbeForTests(async (pid) => `win32-v2:${pid}`);
    _setPersonaRuntimeClockForTests({ now: () => now, monotonicNow: () => now,
      setTimer: () => ({ clear() {}, unref() {} }), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) });
    submitMock.mockImplementation(async (input: SubmitPersonaFlowDispatchInput, options: { validateAdmission?: () => Promise<void> }) => {
      const id = dispatchIdentity(input.personaId, input.idempotencyKey);
      const existing = dispatches.get(id);
      if (existing) return { dispatch: existing, duplicate: true, decision: 'duplicate' };
      await options.validateAdmission?.();
      const dispatch = {
        id, personaId: input.personaId, state: 'running', activityId: `activity_goal_${dispatches.size + 1}`,
        admission: { kind: 'assignment', priority: input.priority ?? 'normal', source: input.source },
      } as PersonaFlowDispatchRecord;
      dispatches.set(id, dispatch);
      return { dispatch, duplicate: false, decision: 'queued' };
    });
  });
  afterEach(() => {
    _setPersonaRuntimeClockForTests(undefined);
    _setPersonaRuntimeLockProcessBirthProbeForTests();
  });

  it('continues partial/successful rounds from one goal, and completes only on verified goal success', async () => {
    await inWorkspace(async () => {
      const { task } = await goal();
      await Promise.all([reconcilePersonaGoals(task.personaId), reconcilePersonaGoals(task.personaId)]);
      expect(submitMock).toHaveBeenCalledTimes(1);
      expect(submitMock.mock.calls[0][0].flowInput).toMatchObject({ requireApproval: false, onApprovalRequired: 'fail' });
      await finish(task);
      const afterFirst = await current(task);
      expect(afterFirst).toMatchObject({ status: 'open', goal: { state: 'active', rounds: 1 } });
      now = afterFirst.goal!.nextRunAt! - 1;
      await reconcilePersonaGoals();
      expect(submitMock).toHaveBeenCalledTimes(1);
      now += 1;
      await reconcilePersonaGoals();
      await finish(task, { resolution: 'succeeded', goalAchieved: false });
      expect((await current(task)).goal!.state).toBe('active');
      now = (await current(task)).goal!.nextRunAt!;
      await reconcilePersonaGoals();
      await finish(task, { resolution: 'succeeded', goalAchieved: true });
      expect(await current(task)).toMatchObject({ status: 'completed', goal: { state: 'completed', rounds: 3 } });
      expect((await current(task)).goal!.nextRunAt).toBeUndefined();
      now += 100_000;
      await reconcilePersonaGoals();
      expect(submitMock).toHaveBeenCalledTimes(3);
    });
  });

  it('keeps an until-stopped responsibility active even when a round claims the goal is achieved', async () => {
    await inWorkspace(async () => {
      const { task } = await goal({ completionPolicy: 'until_stopped' });
      await reconcilePersonaGoals(task.personaId);
      await finish(task, { resolution: 'succeeded', goalAchieved: true });
      const after = await current(task);
      expect(after.status).toBe('open');
      expect(after.goal).toMatchObject({ state: 'active', completionPolicy: 'until_stopped', rounds: 1 });
      now = after.goal!.nextRunAt!;
      await reconcilePersonaGoals();
      expect(submitMock).toHaveBeenCalledTimes(2);
      expect((await current(task)).goal!.state).toBe('active');
    });
  });

  it('preserves finite goal completion for persisted legacy goals without a completion policy', async () => {
    await inWorkspace(async () => {
      const { task } = await goal();
      expect(task.goal!.completionPolicy).toBe('success_criteria');
      await savePersonaWorkItem({ ...task, goal: { ...task.goal!, completionPolicy: undefined } });
      await reconcilePersonaGoals(task.personaId);
      await finish(task, { resolution: 'succeeded', goalAchieved: true });
      expect((await current(task)).goal!.state).toBe('completed');
    });
  });

  it('recovers a reserved admission after restart with the same frozen request and attempt ID', async () => {
    await inWorkspace(async () => {
      const { task } = await goal();
      submitMock.mockRejectedValueOnce(new Error('Interrupted before mailbox admission'));
      await reconcilePersonaGoals(task.personaId);
      const reserved = await current(task);
      const firstInput = submitMock.mock.calls[0][0];
      expect(reserved.goal).toMatchObject({ rounds: 1, pendingTaskId: task.id });
      await savePersonaWorkItem({ ...reserved, title: 'An edited display title', updatedAt: reserved.updatedAt + 1 });
      stopPersonaGoalRuntime();
      now = reserved.goal!.nextRunAt!;
      await startPersonaGoalRuntime();
      expect(submitMock.mock.calls[1][0]).toEqual(firstInput);
      expect((await current(task)).goal!.rounds).toBe(1);
    });
  });

  it('uses ready child work, preserves independent work behind a blocked child, and does not complete with unfinished children', async () => {
    await inWorkspace(async () => {
      const { task } = await goal();
      const first = await createPersonaWorkItem({ personaId: task.personaId, parentGoalId: task.id, title: 'First child', priority: 'urgent' });
      const second = await createPersonaWorkItem({ personaId: task.personaId, parentGoalId: task.id, title: 'Independent child' });
      await reconcilePersonaGoals(task.personaId);
      expect((await current(task)).goal!.pendingTaskId).toBe(first.id);
      await finish(task, { resolution: 'blocked', blockerKind: 'information', summary: 'Missing external response.', nextAction: 'Recheck external response.' });
      expect((await current(first)).status).toBe('blocked');
      expect((await current(task)).goal!.state).toBe('active');
      now = (await current(task)).goal!.nextRunAt!;
      await reconcilePersonaGoals();
      expect((await current(task)).goal!.pendingTaskId).toBe(second.id);
      await finish(task, { resolution: 'succeeded' });
      await expect(updatePersonaWorkItem(task.personaId, task.id, { status: 'completed' })).rejects.toThrow('remaining Tasks');
      now = (await current(task)).goal!.nextRunAt!;
      await reconcilePersonaGoals();
      await finish(task, { resolution: 'succeeded', goalAchieved: true });
      expect((await current(task)).goal!.state).toBe('active');
    });
  });

  it('keeps child success with a newly discovered dependency actionable instead of wedging terminal projection', async () => {
    await inWorkspace(async () => {
      const { task } = await goal();
      const child = await createPersonaWorkItem({ personaId: task.personaId, parentGoalId: task.id, title: 'Publish a researched deliverable' });
      await reconcilePersonaGoals(task.personaId);
      expect((await current(task)).goal!.pendingTaskId).toBe(child.id);
      const dependency = await createPersonaWorkItem({ personaId: task.personaId, parentGoalId: task.id, title: 'Verify newly discovered source requirement' });
      await updatePersonaWorkItem(task.personaId, child.id, { dependencyIds: [dependency.id] });
      await expect(finish(task, { resolution: 'succeeded', summary: 'Draft completed; source verification remains.' })).resolves.toBeDefined();
      expect((await current(child)).status).toBe('open');
      const root = await current(task);
      expect(root.goal).toMatchObject({ state: 'active', rounds: 1 });
      expect(root.goal!.pendingTaskId).toBeUndefined();
      now = root.goal!.nextRunAt!;
      await reconcilePersonaGoals();
      expect((await current(task)).goal!.pendingTaskId).toBe(dependency.id);
      await finish(task, { resolution: 'succeeded' });
      expect((await current(dependency)).status).toBe('completed');
      now = (await current(task)).goal!.nextRunAt!;
      await reconcilePersonaGoals();
      expect((await current(task)).goal!.pendingTaskId).toBe(child.id);
      await finish(task, { resolution: 'succeeded' });
      expect((await current(child)).status).toBe('completed');
    });
  });

  it('rejects dependency cycles through goal ownership and inherited prerequisites while retaining child dependencies', async () => {
    await inWorkspace(async () => {
      const { task } = await goal();
      const first = await createPersonaWorkItem({ personaId: task.personaId, parentGoalId: task.id, title: 'First child' });
      const second = await createPersonaWorkItem({ personaId: task.personaId, parentGoalId: task.id, title: 'Dependent child', dependencyIds: [first.id] });
      expect(second.dependencyIds).toEqual([first.id]);
      await expect(updatePersonaWorkItem(task.personaId, task.id, { dependencyIds: [first.id] })).rejects.toThrow('inherited prerequisites');
      await expect(updatePersonaWorkItem(task.personaId, first.id, { dependencyIds: [task.id] })).rejects.toThrow('ongoing goal completion');
      const other = await createPersonaWorkItem({ personaId: task.personaId, title: 'Second goal', goal: { successCriteria: 'A separate finite deliverable.' } });
      const otherChild = await createPersonaWorkItem({ personaId: task.personaId, parentGoalId: other.id, title: 'Other goal child' });
      await updatePersonaWorkItem(task.personaId, first.id, { dependencyIds: [other.id] });
      await expect(updatePersonaWorkItem(task.personaId, otherChild.id, { dependencyIds: [task.id] })).rejects.toThrow('acyclic');
      expect((await current(otherChild)).dependencyIds).toEqual([]);
      await updatePersonaWorkItem(task.personaId, first.id, { dependencyIds: [] });
      // Even without an explicit child->root edge, root prerequisites apply to
      // every child and must not create a cross-goal wait in both directions.
      await updatePersonaWorkItem(task.personaId, task.id, { dependencyIds: [other.id] });
      await expect(updatePersonaWorkItem(task.personaId, other.id, { dependencyIds: [first.id] })).rejects.toThrow('acyclic');
    });
  });

  it('backs off repeated failures into autonomous replanning rather than requiring a supervisor', async () => {
    await inWorkspace(async () => {
      const { task } = await goal({ maxConsecutiveFailures: 2 });
      await reconcilePersonaGoals(task.personaId);
      await finish(task, { resolution: 'failed', blockerKind: 'capability', summary: 'No installed browser.' });
      now = (await current(task)).goal!.nextRunAt!;
      await reconcilePersonaGoals();
      await finish(task, { resolution: 'failed', blockerKind: 'capability', summary: 'No installed browser.' });
      const recovered = await current(task);
      expect(recovered).toMatchObject({ status: 'open', goal: { state: 'active', recoveryCount: 1, consecutiveFailures: 0 } });
      expect(recovered.goal!.nextRunAt!).toBeGreaterThanOrEqual(now + 5 * 60_000);
      now = recovered.goal!.nextRunAt!;
      await reconcilePersonaGoals();
      expect(submitMock.mock.calls[2][0].flowInput.messages[0].content).toContain('No installed browser.');
      expect(submitMock.mock.calls[2][0].flowInput.messages[0].content).toContain('different strategy');
    });
  });

  it('honors pause/stop and ignores stale terminal projections or notifications after runtime shutdown', async () => {
    await inWorkspace(async () => {
      const { task } = await goal();
      await reconcilePersonaGoals(task.personaId);
      const oldActivity = await finish(task);
      await controlPersonaWorkItem(task.personaId, task.id, 'pause');
      now += 1_000_000;
      await synchronizeAssignedWorkItemFromActivity(oldActivity);
      await reconcilePersonaGoals();
      expect((await current(task)).goal!.state).toBe('paused');
      expect(submitMock).toHaveBeenCalledTimes(1);
      await controlPersonaWorkItem(task.personaId, task.id, 'retry');
      await reconcilePersonaGoals();
      const beforeStale = await current(task);
      await synchronizeAssignedWorkItemFromActivity(oldActivity);
      expect((await current(task)).goal!.pendingDispatchId).toBe(beforeStale.goal!.pendingDispatchId);
      await controlPersonaWorkItem(task.personaId, task.id, 'stop');
      expect((await current(task)).goal!.state).toBe('stopped');
      expect([...dispatches.values()].every((item) => ['completed', 'cancelled'].includes(item.state))).toBe(true);
      stopPersonaGoalRuntime();
      notifyPersonaGoalChanged(task.personaId);
      await reconcilePersonaGoals();
      expect(submitMock).toHaveBeenCalledTimes(2);
    });
  });

  it('resumes an exhausted daily allowance automatically next day and respects disabled Personas', async () => {
    await inWorkspace(async () => {
      const { task, persona } = await goal({ maxRoundsPerDay: 1 });
      await updatePersona({ ...persona, lifecycleState: 'disabled', updatedAt: persona.updatedAt + 1 });
      await reconcilePersonaGoals(task.personaId);
      expect(submitMock).not.toHaveBeenCalled();
      await updatePersona({ ...persona, lifecycleState: 'idle', updatedAt: persona.updatedAt + 2 });
      await reconcilePersonaGoals();
      await finish(task);
      now = (await current(task)).goal!.nextRunAt!;
      await reconcilePersonaGoals();
      const waiting = await current(task);
      expect(waiting.goal!.state).toBe('active');
      expect(waiting.goal!.nextRunAt).toBe(waiting.goal!.dailyWindowStartedAt + 24 * 60 * 60_000);
      expect(submitMock).toHaveBeenCalledTimes(1);
      stopPersonaGoalRuntime();
      now = waiting.goal!.nextRunAt!;
      await startPersonaGoalRuntime();
      expect((await current(task)).goal).toMatchObject({ rounds: 2, roundsInWindow: 1 });
      expect(submitMock).toHaveBeenCalledTimes(2);
    });
  });

  it('fences a pause that wins between reservation and admission, then resumes with a new intent', async () => {
    await inWorkspace(async () => {
      const { task } = await goal();
      const normalSubmit = submitMock.getMockImplementation()!;
      submitMock.mockImplementationOnce(async (_input, options) => {
        await controlPersonaWorkItem(task.personaId, task.id, 'pause');
        await options.validateAdmission();
        throw new Error('Admission should have been rejected by the pause fence');
      });
      await reconcilePersonaGoals(task.personaId);
      const paused = await current(task);
      expect(paused.goal!.state).toBe('paused');
      expect(dispatches.size).toBe(0);
      submitMock.mockImplementation(normalSubmit);
      await controlPersonaWorkItem(task.personaId, task.id, 'retry');
      now = (await current(task)).goal!.nextRunAt!;
      await reconcilePersonaGoals();
      expect(dispatches.size).toBe(1);
      expect((await current(task)).goal).toMatchObject({ rounds: 2, state: 'active' });
      expect(submitMock.mock.calls[0][0].idempotencyKey).not.toBe(submitMock.mock.calls[1][0].idempotencyKey);
    });
  });

  it('abandons an invalidated child admission and replans instead of replaying it indefinitely', async () => {
    await inWorkspace(async () => {
      const { task } = await goal();
      const child = await createPersonaWorkItem({ personaId: task.personaId, parentGoalId: task.id, title: 'Superseded child' });
      submitMock.mockImplementationOnce(async (_input, options) => {
        await updatePersonaWorkItem(child.personaId, child.id, { status: 'cancelled' });
        await options.validateAdmission();
        throw new Error('Cancelled child should never be admitted');
      });
      await reconcilePersonaGoals(task.personaId);
      const recovered = await current(task);
      expect(recovered.goal!.pendingAttemptKey).toBeUndefined();
      expect(recovered.goal!.state).toBe('active');
      now = recovered.goal!.nextRunAt!;
      await reconcilePersonaGoals();
      expect((await current(task)).goal!.pendingTaskId).toBe(task.id);
      expect(submitMock.mock.calls[1][0].source.sourceId).toBe(task.id);
    });
  });

  it('does not admit autonomous work across an active workspace snapshot boundary', async () => {
    await inWorkspace(async () => {
      const { task } = await goal();
      const boundary = await beginWorkspaceSnapshotBoundary();
      try {
        await reconcilePersonaGoals(task.personaId);
        expect(submitMock).not.toHaveBeenCalled();
      } finally { boundary.release(); }
      await reconcilePersonaGoals();
      expect(submitMock).toHaveBeenCalledTimes(1);
    });
  });

  it('inherits model-created tasks and prevents premature model completion from surviving a later runtime error', async () => {
    await inWorkspace(async () => {
      const { task, persona } = await goal();
      const activity: PersonaActivity = { schemaVersion: 1, id: 'activity_goal_authority', personaId: persona.id,
        kind: 'assignment', status: 'running', source: { kind: 'assignment', sourceId: task.id },
        createdAt: now, updatedAt: now, startedAt: now, leaseId: 'lease_goal_authority' };
      await savePersonaActivity(activity);
      const authority: FlowExecutionAuthority = {
        signal: new AbortController().signal,
        assertCurrent: async () => undefined,
        commitWhileCurrent: (operation) => operation(),
        commitPersonaMutation: (operation) => operation({ persona, activity, updatePersona: async () => persona }),
      };
      const options = { executionAuthority: authority };
      const child = await createPersonaWorkItem({ personaId: persona.id, title: 'An autonomously planned next step' }, options);
      expect(child.parentGoalId).toBe(task.id);
      await expect(updatePersonaWorkItem(persona.id, task.id, { status: 'cancelled' }, options)).rejects.toThrow('Only its owner');
      await expect(updatePersonaWorkItem(persona.id, task.id, { status: 'completed' }, options)).rejects.toThrow('Report verified goal success');
      activity.reportedOutcome = { schemaVersion: 1, resolution: 'succeeded', goalAchieved: true,
        decisionSource: 'persona_claim', evidenceRefs: [], decidedAt: now };
      await expect(updatePersonaWorkItem(persona.id, task.id, { status: 'completed' }, options)).rejects.toThrow('only after the Activity');
      await updatePersonaWorkItem(persona.id, child.id, { status: 'completed' }, options);
      await expect(updatePersonaWorkItem(persona.id, task.id, { status: 'completed' }, options)).rejects.toThrow('only after the Activity');
      await reconcilePersonaGoals(persona.id);
      await finish(task, { resolution: 'failed', goalAchieved: false, summary: 'Failure after an optimistic report.' }, 'error');
      expect((await current(task)).goal!.state).toBe('active');
      now = (await current(task)).goal!.nextRunAt!;
      await reconcilePersonaGoals();
      await finish(task, { resolution: 'succeeded', goalAchieved: true });
      expect((await current(task)).goal!.state).toBe('completed');
      await expect(updatePersonaWorkItem(persona.id, task.id, { status: 'open' }, options)).rejects.toThrow('cannot be reopened');
    });
  });

  it('does not let an unadmitted goal in backoff starve another due goal', async () => {
    await inWorkspace(async () => {
      const { task } = await goal();
      submitMock.mockRejectedValueOnce(new Error('First goal admission temporarily unavailable'));
      await reconcilePersonaGoals(task.personaId);
      const backedOff = await current(task);
      const second = await createPersonaWorkItem({ personaId: task.personaId, title: 'Independent goal',
        goal: { successCriteria: 'Finish independent deliverable.', continuationIntervalMs: 10_000 } });
      now = Math.max(now, second.createdAt);
      expect(backedOff.goal!.nextRunAt!).toBeGreaterThan(now);
      await reconcilePersonaGoals();
      expect((await current(second)).goal!.pendingTaskId).toBe(second.id);
      expect((await current(task)).goal!.pendingAttemptKey).toBe(backedOff.goal!.pendingAttemptKey);
    });
  });

  it('defers an externally waiting child without delaying its ready sibling', async () => {
    await inWorkspace(async () => {
      const { task } = await goal();
      const waiting = await createPersonaWorkItem({ personaId: task.personaId, parentGoalId: task.id, title: 'Wait for external publication', priority: 'urgent' });
      const independent = await createPersonaWorkItem({ personaId: task.personaId, parentGoalId: task.id, title: 'Independent research' });
      await reconcilePersonaGoals(task.personaId);
      await finish(task, { resolution: 'blocked', blockerKind: 'external', summary: 'Publication pending.', retryAfterMs: 24 * 60 * 60_000 });
      const root = await current(task);
      expect((await current(waiting)).deferredUntil! - root.updatedAt).toBe(24 * 60 * 60_000);
      expect(root.goal!.nextRunAt! - root.updatedAt).toBe(10_000);
      now = root.goal!.nextRunAt!;
      await reconcilePersonaGoals();
      expect((await current(task)).goal!.pendingTaskId).toBe(independent.id);
    });
  });

  it('continues ready child work after a root planning round reports an external wait', async () => {
    await inWorkspace(async () => {
      const { task } = await goal();
      await reconcilePersonaGoals(task.personaId);
      const child = await createPersonaWorkItem({ personaId: task.personaId, parentGoalId: task.id, title: 'Independent deliverable from planning' });
      await finish(task, { resolution: 'blocked', blockerKind: 'information', retryAfterMs: 24 * 60 * 60_000,
        summary: 'One channel needs an external response.', nextAction: 'Continue the independent deliverable.' });
      const root = await current(task);
      expect(root.goal!.nextRunAt! - root.updatedAt).toBe(root.goal!.continuationIntervalMs);
      now = root.goal!.nextRunAt!;
      await reconcilePersonaGoals();
      expect((await current(task)).goal!.pendingTaskId).toBe(child.id);
    });
  });

  it('waits for root dependencies before reserving associated child work', async () => {
    await inWorkspace(async () => {
      const { task } = await goal();
      const dependency = await createPersonaWorkItem({ personaId: task.personaId, title: 'Prepare required source material' });
      await updatePersonaWorkItem(task.personaId, task.id, { dependencyIds: [dependency.id] });
      const child = await createPersonaWorkItem({ personaId: task.personaId, parentGoalId: task.id, title: 'Use the required source material' });
      await reconcilePersonaGoals(task.personaId);
      expect(submitMock).not.toHaveBeenCalled();
      await updatePersonaWorkItem(task.personaId, dependency.id, { status: 'completed' });
      await reconcilePersonaGoals();
      expect((await current(task)).goal!.pendingTaskId).toBe(child.id);
    });
  });

  it('routes manual child assignment and retry through the same autonomous controller and rejects lifecycle PATCH bypasses', async () => {
    await inWorkspace(async () => {
      const { task } = await goal();
      const child = await createPersonaWorkItem({ personaId: task.personaId, parentGoalId: task.id, title: 'Child assigned from UI' });
      await assignPersonaWorkItem(child.personaId, child.id, { expectedUpdatedAt: child.updatedAt, idempotencyKey: 'manual-child-assignment' });
      expect(submitMock).not.toHaveBeenCalled();
      now = (await current(task)).goal!.nextRunAt!;
      await reconcilePersonaGoals(task.personaId);
      expect(submitMock).toHaveBeenCalledTimes(1);
      await controlPersonaWorkItem(child.personaId, child.id, 'retry');
      await reconcilePersonaGoals();
      expect(submitMock).toHaveBeenCalledTimes(1);
      await expect(updatePersonaWorkItem(task.personaId, task.id, { status: 'cancelled' })).rejects.toThrow('controls');
      await expect(updatePersonaWorkItem(task.personaId, task.id, { status: 'blocked' })).rejects.toThrow('controls');
      await controlPersonaWorkItem(task.personaId, task.id, 'pause');
      expect([...dispatches.values()].every((item) => item.state === 'cancelled')).toBe(true);
    });
  });

  it('durably fences stopped rounds after a crash prefix and retries leftover cancellations on repeated Stop', async () => {
    await inWorkspace(async () => {
      const { task } = await goal();
      await reconcilePersonaGoals(task.personaId);
      const pending = await current(task);
      const check = { personaId: task.personaId, taskId: task.id, dispatchId: pending.goal!.pendingDispatchId!, requireReady: true };
      await expect(assertPersonaGoalDispatchCurrent(check)).resolves.toBeUndefined();
      // Simulate the durable Stop write surviving a process exit before cancellation.
      await savePersonaWorkItem({ ...pending, status: 'cancelled', updatedAt: pending.updatedAt + 1,
        goal: { ...pending.goal!, state: 'stopped', nextRunAt: undefined, pendingDispatchId: undefined, pendingTaskId: undefined, pendingAttemptKey: undefined } });
      await expect(assertPersonaGoalDispatchCurrent(check)).rejects.toThrow('no longer authorizes');
      await expect(assertPersonaGoalDispatchCurrent({ ...check, requireReady: false })).rejects.toThrow('no longer authorizes');
      await controlPersonaWorkItem(task.personaId, task.id, 'stop');
      expect(dispatches.get(check.dispatchId)!.state).toBe('cancelled');
    });
  });

  it('repairs a child control crash prefix and continues independent work without the revoked round', async () => {
    await inWorkspace(async () => {
      const { task } = await goal();
      const child = await createPersonaWorkItem({ personaId: task.personaId, parentGoalId: task.id, title: 'Child paused during execution', priority: 'urgent' });
      const sibling = await createPersonaWorkItem({ personaId: task.personaId, parentGoalId: task.id, title: 'Independent sibling' });
      await reconcilePersonaGoals(task.personaId);
      const dispatchId = (await current(task)).goal!.pendingDispatchId!;
      await savePersonaWorkItem({ ...child, status: 'blocked', revokedGoalDispatchId: dispatchId, updatedAt: child.updatedAt + 1 });
      await reconcilePersonaGoals();
      expect(dispatches.get(dispatchId)!.state).toBe('cancelled');
      const recovered = await current(task);
      expect(recovered.goal!.pendingTaskId).toBeUndefined();
      now = recovered.goal!.nextRunAt!;
      await reconcilePersonaGoals();
      expect((await current(task)).goal!.pendingTaskId).toBe(sibling.id);
      expect((await current(child)).status).toBe('blocked');
      expect(submitMock).toHaveBeenCalledTimes(2);
    });
  });

  it('retains reserved goal records until they are stopped so startup can fence old deliveries', async () => {
    await inWorkspace(async () => {
      const { task } = await goal();
      await expect(deletePersonaWorkItem(task.personaId, task.id)).rejects.toThrow('Stop this ongoing goal');
      const child = await createPersonaWorkItem({ personaId: task.personaId, parentGoalId: task.id, title: 'Reserved child' });
      submitMock.mockRejectedValueOnce(new Error('Crash before durable dispatch creation'));
      await reconcilePersonaGoals(task.personaId);
      expect(dispatches.size).toBe(0);
      await expect(deletePersonaWorkItem(task.personaId, child.id)).rejects.toThrow('Stop this ongoing goal');
      await controlPersonaWorkItem(task.personaId, task.id, 'stop');
      await expect(deletePersonaWorkItem(task.personaId, child.id)).resolves.toBeUndefined();
      await expect(deletePersonaWorkItem(task.personaId, task.id)).resolves.toBeUndefined();
    });
  });

  it('starts fresh goal work after a real lease expires without replaying the uncertain Activity or losing its history', async () => {
    await inWorkspace(async () => {
      const { task } = await goal();
      const claims = useRealActivityAdmission();
      await reconcilePersonaGoals(task.personaId);
      expect(claims).toHaveLength(1);
      const first = claims[0];
      const firstDispatchId = (await current(task)).goal!.pendingDispatchId!;
      now = first.lease.expiresAt;
      await expect(assertPersonaActivityLease(leaseFence(first))).rejects.toBeInstanceOf(PersonaLeaseLostError);
      const expired = (await getPersonaActivity(task.personaId, first.activity.id))!;
      expect(expired).toMatchObject({ status: 'error', error: 'Activity lease expired before completion; automatic replay was suppressed.' });
      expect(await getPersona(task.personaId)).toMatchObject({ lifecycleState: 'idle' });
      dispatches.set(firstDispatchId, { ...dispatches.get(firstDispatchId)!, state: 'error' });
      await synchronizeAssignedWorkItemFromActivity(expired);
      const afterExpiry = await current(task);
      expect(afterExpiry.goal).toMatchObject({ state: 'active', rounds: 1, lastActivityId: first.activity.id });
      expect(afterExpiry.goal!.pendingTaskId).toBeUndefined();
      now = afterExpiry.goal!.nextRunAt!;
      await reconcilePersonaGoals();
      expect(claims).toHaveLength(2);
      const second = claims[1];
      expect(second.activity.id).not.toBe(first.activity.id);
      expect(second.lease.fencingToken).toBeGreaterThan(first.lease.fencingToken);
      expect((await current(task)).goal).toMatchObject({ state: 'active', rounds: 2 });
      const freshPrompt = submitMock.mock.calls[1][0].flowInput.messages[0].content;
      expect(freshPrompt).toContain(expired.error);
      expect(freshPrompt).toContain('inspect persisted artifacts and external state to avoid duplicate side effects');
      await expect(completePersonaActivity(leaseFence(first))).rejects.toBeInstanceOf(PersonaLeaseLostError);
      await expect(assertPersonaActivityLease(leaseFence(second))).resolves.toMatchObject({ id: second.lease.id });
      expect(await getPersonaActivity(task.personaId, first.activity.id)).toEqual(expired);
      await completePersonaActivity({ ...leaseFence(second), status: 'cancelled' });
    });
  });

  it('does not clear an unrelated administrative or corruption error gate to continue a goal', async () => {
    await inWorkspace(async () => {
      const { task, persona } = await goal();
      const claims = useRealActivityAdmission();
      await updatePersona({ ...persona, lifecycleState: 'error', updatedAt: persona.updatedAt + 1 });
      await reconcilePersonaGoals(task.personaId);
      expect(claims).toHaveLength(0);
      expect(await getPersona(task.personaId)).toMatchObject({ lifecycleState: 'error' });
      expect((await current(task)).goal!.state).toBe('active');
    });
  });

  it('keeps execution authority for the final report after a child completes itself', async () => {
    await inWorkspace(async () => {
      const { task } = await goal();
      const child = await createPersonaWorkItem({ personaId: task.personaId, parentGoalId: task.id, title: 'Complete before reporting' });
      await reconcilePersonaGoals(task.personaId);
      const root = await current(task);
      await savePersonaWorkItem({ ...child, status: 'completed', completedAt: child.updatedAt, updatedAt: child.updatedAt });
      const check = { personaId: task.personaId, taskId: child.id, dispatchId: root.goal!.pendingDispatchId!, requireReady: false };
      await expect(assertPersonaGoalDispatchCurrent(check)).resolves.toBeUndefined();
      await expect(assertPersonaGoalDispatchCurrent({ ...check, requireReady: true })).rejects.toThrow('no longer ready');
    });
  });
});
