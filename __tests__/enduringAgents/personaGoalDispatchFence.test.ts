import type { FlowRunInput, FlowRunResult } from '@/backend/execution/flow/runFlow';
import {
  PersonaFlowDispatcher,
  personaFlowDispatchId,
  type PersonaFlowDispatcherDependencies,
} from '@/backend/services/enduringAgents/personaDispatcher';
import {
  assertPersonaGoalDispatchCurrent,
  clearPersonaGoalPending,
  stopPersonaGoalRuntime,
} from '@/backend/services/enduringAgents/goalRuntime';
import {
  _setPersonaRuntimeLockProcessBirthProbeForTests,
  withPersonaRuntimeLock,
} from '@/backend/services/enduringAgents/runtimeLock';
import { getPersonaWorkItem, savePersonaWorkItem } from '@/backend/services/enduringAgents/store';
import { controlPersonaWorkItem, createPersonaWorkItem, updatePersonaWorkItem } from '@/backend/services/enduringAgents/workItems';
import type { PersonaWorkItem } from '@/shared/types/enduringAgent';
import { runWithWorkspace } from '@/utils/workspace';
import { createPersonaFromRole } from './fixtures/personaFactory';

let mockCrashGoalSaveId: string | undefined;
jest.mock('@/backend/services/enduringAgents/store', () => {
  const actual = jest.requireActual<typeof import('@/backend/services/enduringAgents/store')>('@/backend/services/enduringAgents/store');
  return { ...actual, savePersonaWorkItem: (item: PersonaWorkItem) => {
    if (item.id === mockCrashGoalSaveId) throw new Error('Simulated crash after saving the child control');
    return actual.savePersonaWorkItem(item);
  } };
});

let sequence = 0;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function successfulResult(input: FlowRunInput): FlowRunResult {
  return {
    status: 'completed', conversationId: input.conversationId!, runId: input.runId!,
    outputText: 'done', messages: [], sharedState: {} as FlowRunResult['sharedState'],
  };
}

async function reserveRound(target: 'root' | 'child') {
  // The regression controls exactly when dispatch starts. Disable the background
  // controller while retaining the real goal, mailbox, lease, and dispatch stores.
  stopPersonaGoalRuntime();
  const { persona } = await createPersonaFromRole({
    name: 'Frederik', idempotencyKey: 'goal-fence-persona', autonomyLevel: 'locked',
  });
  const root = await createPersonaWorkItem({
    personaId: persona.id, title: 'Make FLUJO known',
    goal: { successCriteria: 'Three verified published deliverables.', continuationIntervalMs: 10_000 },
  });
  const task = target === 'root' ? root : await createPersonaWorkItem({
    personaId: persona.id, parentGoalId: root.id, title: 'Research a suitable community',
  });
  const attemptKey = 'goal-fence-round';
  const dispatchId = personaFlowDispatchId(persona.id, attemptKey);
  await savePersonaWorkItem({
    ...root,
    goal: {
      ...root.goal!, rounds: 1, roundsInWindow: 1,
      pendingTaskId: task.id, pendingAttemptKey: attemptKey,
      pendingDispatchId: dispatchId, pendingPrompt: 'Carry out the next concrete action.',
      pendingPriority: 'normal',
    },
  });
  const input = {
    personaId: persona.id, idempotencyKey: attemptKey, kind: 'assignment' as const,
    source: { kind: 'assignment' as const, sourceId: task.id },
    relationKey: `persona-task:${task.id}`,
    flowInput: {
      source: 'internal' as const, prompt: 'Carry out the next concrete action.',
      mode: 'conversation' as const, requireApproval: false, onApprovalRequired: 'fail' as const,
    },
  };
  return { persona, root, task, dispatchId, input };
}

async function persistControlBeforeCancellation(root: PersonaWorkItem, state: 'paused' | 'stopped') {
  // Simulate a crash after controlPersonaWorkItem persists its authority change,
  // before it gets to cancelPersonaFlowDispatchById outside the runtime lock.
  await withPersonaRuntimeLock(root.personaId, async (lock) => {
    const current = (await getPersonaWorkItem(root.personaId, root.id))!;
    await lock.assertOwned();
    await savePersonaWorkItem({
      ...current, status: state === 'paused' ? 'blocked' : 'cancelled',
      goal: { ...clearPersonaGoalPending(current.goal!), state, nextRunAt: undefined },
      updatedAt: Math.max(Date.now(), current.updatedAt + 1),
    });
  });
}

async function inWorkspace(task: (workspaceId: string) => Promise<void>) {
  const workspaceId = `goal-dispatch-fence-${process.pid}-${++sequence}`;
  await runWithWorkspace(workspaceId, async () => {
    try { await task(workspaceId); } finally { stopPersonaGoalRuntime(); }
  });
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the durable control transition.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('durable ongoing goal dispatch authority', () => {
  beforeEach(() => {
    mockCrashGoalSaveId = undefined;
    // Exercise actual filesystem locking without a platform WMI subprocess.
    _setPersonaRuntimeLockProcessBirthProbeForTests(async (pid) => `win32-v2:${pid}`);
  });
  afterEach(() => { _setPersonaRuntimeLockProcessBirthProbeForTests(); });

  it.each([
    ['root', 'paused', true], ['root', 'stopped', true],
    ['child', 'paused', true], ['child', 'stopped', true],
    ['root', 'paused', false], ['root', 'stopped', false],
    ['child', 'paused', false], ['child', 'stopped', false],
  ] as const)('does not replay a %s round after %s (mailbox admitted: %s)', async (target, state, admitted) => {
    await inWorkspace(async (workspaceId) => {
      const round = await reserveRound(target);
      const runFlow = jest.fn(async (input: FlowRunInput) => successfulResult(input));
      const dependencies: Partial<PersonaFlowDispatcherDependencies> = { runFlow };
      if (!admitted) {
        dependencies.routePersonaMailboxItem = async () => { throw new Error('Simulated crash before mailbox admission'); };
      }
      const beforeCrash = new PersonaFlowDispatcher({ workspaceId, dependencies });
      const submission = beforeCrash.submit(round.input, { startPump: false });
      if (admitted) await submission;
      else await expect(submission).rejects.toThrow('Simulated crash before mailbox admission');
      const saved = await beforeCrash.get(round.dispatchId);
      expect(saved?.state).toBe('queued');
      expect(Boolean(saved?.mailboxItemId)).toBe(admitted);
      await persistControlBeforeCancellation(round.root, state);

      const restarted = new PersonaFlowDispatcher({ workspaceId, dependencies: { runFlow } });
      try {
        await restarted.reconcileAndDrain();
        await restarted.pump(round.persona.id);
        expect(runFlow).not.toHaveBeenCalled();
        expect(await restarted.get(round.dispatchId)).toMatchObject({ state: 'cancelled' });
        expect((await getPersonaWorkItem(round.persona.id, round.root.id))?.goal?.state).toBe(state);
      } finally {
        await restarted.quiesce(round.persona.id);
        await beforeCrash.quiesce(round.persona.id);
      }
    });
  });

  it('revokes live commits at the persisted stop boundary before asynchronous cancellation', async () => {
    await inWorkspace(async (workspaceId) => {
      const round = await reserveRound('child');
      const started = deferred<FlowRunInput>();
      const finish = deferred<void>();
      const runFlow = jest.fn(async (input: FlowRunInput) => {
        started.resolve(input);
        await finish.promise;
        return successfulResult(input);
      });
      const dispatcher = new PersonaFlowDispatcher({ workspaceId, dependencies: { runFlow } });
      await dispatcher.submit(round.input, { startPump: false });
      const pumping = dispatcher.pump(round.persona.id);
      try {
        const input = await Promise.race([
          started.promise,
          pumping.then(() => { throw new Error('The queued goal round did not reach runFlow.'); }),
        ]);
        const authority = input.executionAuthority!;
        const authorizedWrite = jest.fn(async () => 'committed');
        await expect(authority.commitWhileCurrent!(authorizedWrite)).resolves.toBe('committed');
        expect(authorizedWrite).toHaveBeenCalledTimes(1);

        // Finishing a child inside its Flow does not revoke the root's authority
        // to report the outcome and commit its remaining execution bookkeeping.
        await updatePersonaWorkItem(round.persona.id, round.task.id, { status: 'completed' }, {
          executionAuthority: authority,
        });
        await expect(authority.assertCurrent()).resolves.toBeUndefined();
        await expect(authority.commitWhileCurrent!(authorizedWrite)).resolves.toBe('committed');

        await persistControlBeforeCancellation(round.root, 'stopped');
        expect(authority.signal.aborted).toBe(false);
        const revokedWrite = jest.fn(async () => 'must not commit');
        await expect(authority.assertCurrent()).rejects.toMatchObject({ code: 'PERSONA_GOAL_NOT_CURRENT' });
        await expect(authority.commitWhileCurrent!(revokedWrite)).rejects.toMatchObject({ code: 'PERSONA_GOAL_NOT_CURRENT' });
        await expect(authority.commitPersonaMutation!(revokedWrite)).rejects.toMatchObject({ code: 'PERSONA_GOAL_NOT_CURRENT' });
        expect(revokedWrite).not.toHaveBeenCalled();
      } finally {
        finish.resolve();
        await pumping;
        await dispatcher.quiesce(round.persona.id);
      }
    });
  });

  it.each(['pause', 'stop'] as const)('fences a child %s crash prefix, retries cancellation, and preserves independent work', async (action) => {
    await inWorkspace(async (workspaceId) => {
      const round = await reserveRound('child');
      const sibling = await createPersonaWorkItem({
        personaId: round.persona.id, parentGoalId: round.root.id, title: 'Draft the independent announcement',
      });
      const started = deferred<FlowRunInput>();
      const finish = deferred<void>();
      const dispatcher = new PersonaFlowDispatcher({ workspaceId, dependencies: {
        runFlow: async (input) => { started.resolve(input); await finish.promise; return successfulResult(input); },
      } });
      await dispatcher.submit(round.input, { startPump: false });
      const pumping = dispatcher.pump(round.persona.id);
      let retriedControl: ReturnType<typeof controlPersonaWorkItem> | undefined;
      try {
        const input = await Promise.race([
          started.promise,
          pumping.then(() => { throw new Error('The queued child did not reach runFlow.'); }),
        ]);
        const authority = input.executionAuthority!;
        await expect(updatePersonaWorkItem(round.persona.id, round.task.id, {
          revokedGoalDispatchId: 'forged_dispatch',
        } as never, { executionAuthority: authority })).rejects.toThrow();

        mockCrashGoalSaveId = round.root.id;
        await expect(controlPersonaWorkItem(round.persona.id, round.task.id, action))
          .rejects.toThrow('Simulated crash after saving the child control');
        mockCrashGoalSaveId = undefined;
        expect(await getPersonaWorkItem(round.persona.id, round.task.id)).toMatchObject({
          status: action === 'pause' ? 'blocked' : 'cancelled', revokedGoalDispatchId: round.dispatchId,
        });
        expect((await getPersonaWorkItem(round.persona.id, round.root.id))?.goal?.pendingDispatchId).toBe(round.dispatchId);
        expect(await dispatcher.get(round.dispatchId)).toMatchObject({ state: 'running' });
        expect(authority.signal.aborted).toBe(false);
        const revokedWrite = jest.fn(async () => 'must not commit');
        await expect(authority.assertCurrent()).rejects.toMatchObject({ code: 'PERSONA_GOAL_NOT_CURRENT' });
        await expect(authority.commitWhileCurrent!(revokedWrite)).rejects.toMatchObject({ code: 'PERSONA_GOAL_NOT_CURRENT' });
        await expect(authority.commitPersonaMutation!(revokedWrite)).rejects.toMatchObject({ code: 'PERSONA_GOAL_NOT_CURRENT' });
        expect(revokedWrite).not.toHaveBeenCalled();

        // The repeated control must finish cancellation even though the child's
        // requested status already committed before the interrupted request.
        retriedControl = controlPersonaWorkItem(round.persona.id, round.task.id, action);
        await waitUntil(async () => !(await getPersonaWorkItem(round.persona.id, round.root.id))?.goal?.pendingDispatchId
          && Boolean((await dispatcher.get(round.dispatchId))?.cancellationRequestedAt));
        finish.resolve();
        await pumping;
        await retriedControl;
        expect(await dispatcher.get(round.dispatchId)).toMatchObject({ state: 'cancelled' });
        expect((await getPersonaWorkItem(round.persona.id, round.root.id))?.goal).toMatchObject({ state: 'active', consecutiveFailures: 0 });
        expect((await getPersonaWorkItem(round.persona.id, sibling.id))?.status).toBe('open');

        if (action === 'pause') {
          await controlPersonaWorkItem(round.persona.id, round.task.id, 'retry');
          const root = (await getPersonaWorkItem(round.persona.id, round.root.id))!;
          const nextDispatchId = personaFlowDispatchId(round.persona.id, 'goal-fence-next-round');
          await savePersonaWorkItem({ ...root, goal: { ...root.goal!, pendingTaskId: round.task.id,
            pendingAttemptKey: 'goal_fence_next_round', pendingDispatchId: nextDispatchId } });
          expect((await getPersonaWorkItem(round.persona.id, round.task.id))?.revokedGoalDispatchId).toBe(round.dispatchId);
          await expect(assertPersonaGoalDispatchCurrent({ personaId: round.persona.id,
            taskId: round.task.id, dispatchId: nextDispatchId, requireReady: true })).resolves.toBeUndefined();
        }
      } finally {
        mockCrashGoalSaveId = undefined;
        finish.resolve();
        await pumping;
        await retriedControl;
        await dispatcher.quiesce(round.persona.id);
      }
    });
  });

  it.each(['pause', 'stop'] as const)('preserves an idle child owner %s when a fresh root Activity replans', async (action) => {
    await inWorkspace(async (workspaceId) => {
      const round = await reserveRound('root');
      const child = await createPersonaWorkItem({
        personaId: round.persona.id, parentGoalId: round.root.id, title: 'Publish the community post',
      });
      await controlPersonaWorkItem(round.persona.id, child.id, action);
      expect(await getPersonaWorkItem(round.persona.id, child.id)).toMatchObject({
        status: action === 'pause' ? 'blocked' : 'cancelled', goalControlState: action === 'pause' ? 'paused' : 'stopped',
      });

      const started = deferred<FlowRunInput>();
      const finish = deferred<void>();
      const dispatcher = new PersonaFlowDispatcher({ workspaceId, dependencies: {
        runFlow: async (input) => { started.resolve(input); await finish.promise; return successfulResult(input); },
      } });
      await dispatcher.submit(round.input, { startPump: false });
      const pumping = dispatcher.pump(round.persona.id);
      try {
        const input = await Promise.race([
          started.promise,
          pumping.then(() => { throw new Error('The root planning round did not reach runFlow.'); }),
        ]);
        const options = { executionAuthority: input.executionAuthority! };
        await expect(updatePersonaWorkItem(round.persona.id, child.id, { status: 'open' }, options))
          .rejects.toMatchObject({ code: 'PERSONA_GOAL_TASK_OWNER_CONTROLLED' });
        await expect(updatePersonaWorkItem(round.persona.id, child.id, { status: 'completed' }, options))
          .rejects.toMatchObject({ code: 'PERSONA_GOAL_TASK_OWNER_CONTROLLED' });
        await expect(updatePersonaWorkItem(round.persona.id, child.id, { goalControlState: undefined } as never, options)).rejects.toThrow();
        await expect(updatePersonaWorkItem(round.persona.id, child.id, {
          description: 'Saved context for the owner.', nextAction: 'Preserve this task while independent work continues.',
        }, options)).resolves.toMatchObject({ description: 'Saved context for the owner.' });

        if (action === 'pause') {
          await controlPersonaWorkItem(round.persona.id, child.id, 'retry');
          expect((await getPersonaWorkItem(round.persona.id, child.id))?.goalControlState).toBeUndefined();
          // Ordinary model blockers remain recoverable once the owner resumes.
          await updatePersonaWorkItem(round.persona.id, child.id, { status: 'blocked' }, options);
          await expect(updatePersonaWorkItem(round.persona.id, child.id, { status: 'open' }, options)).resolves.toMatchObject({ status: 'open' });
        } else {
          await expect(controlPersonaWorkItem(round.persona.id, child.id, 'retry')).rejects.toMatchObject({
            code: 'PERSONA_WORK_ITEM_NOT_ACTIONABLE',
          });
        }
      } finally {
        finish.resolve();
        await pumping;
        await dispatcher.quiesce(round.persona.id);
      }
    });
  });
});
