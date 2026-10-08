const submitPersonaFlowDispatchMock = jest.fn();
const listPersonaFlowDispatchesMock = jest.fn();
const cancelPersonaFlowDispatchByIdMock = jest.fn();
const reprioritizePersonaWorkItemDispatchesMock = jest.fn();
const movePersonaWorkItemDispatchMock = jest.fn();

jest.mock('@/backend/services/enduringAgents/personaDispatcher', () => ({
  submitPersonaFlowDispatch: (...args: unknown[]) => submitPersonaFlowDispatchMock(...args),
  listPersonaFlowDispatches: (...args: unknown[]) => listPersonaFlowDispatchesMock(...args),
  cancelPersonaFlowDispatchById: (...args: unknown[]) => cancelPersonaFlowDispatchByIdMock(...args),
  reprioritizePersonaWorkItemDispatches: (...args: unknown[]) => (
    reprioritizePersonaWorkItemDispatchesMock(...args)
  ),
  movePersonaWorkItemDispatch: (...args: unknown[]) => movePersonaWorkItemDispatchMock(...args),
}));

import {
  controlPersonaWorkItem,
  createPersonaWorkItem,
  deletePersonaWorkItem,
  synchronizeAssignedWorkItemFromActivity,
  updatePersonaWorkItem,
} from '@/backend/services/enduringAgents/workItems';
import { getPersonaWorkItem } from '@/backend/services/enduringAgents/store';
import type { PersonaActivity, PersonaWorkItem } from '@/shared/types/enduringAgent';
import { runWithWorkspace } from '@/utils/workspace';
import { createPersonaFromRole } from './fixtures/personaFactory';

let workspaceSequence = 0;

function inFreshWorkspace<T>(task: () => T): T {
  workspaceSequence += 1;
  return runWithWorkspace(`work-item-controls-${process.pid}-${workspaceSequence}`, task);
}

function activeDispatch(personaId: string, workItemId: string, id = 'dispatch_task_control') {
  return {
    id,
    personaId,
    state: 'running',
    admission: {
      kind: 'assignment',
      priority: 'normal',
      source: { kind: 'assignment', sourceId: workItemId },
    },
  };
}

function terminalAssignment(
  personaId: string,
  workItemId: string,
  status: 'cancelled' | 'error',
): PersonaActivity {
  const now = Date.now();
  return {
    id: `activity_${status}_${workItemId}`,
    personaId,
    kind: 'assignment',
    source: { kind: 'assignment', sourceId: workItemId },
    status,
    createdAt: now - 2,
    updatedAt: now - 1,
    completedAt: now,
  } as PersonaActivity;
}

async function createTask(label: string): Promise<{ personaId: string; task: PersonaWorkItem }> {
  const { persona } = await createPersonaFromRole({
    name: `Control ${label}`,
    idempotencyKey: `control-${label}`,
  });
  const task = await createPersonaWorkItem({
    personaId: persona.id,
    title: `Handle ${label}`,
    priority: 'normal',
  });
  return { personaId: persona.id, task };
}

describe('Persona Task work controls', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listPersonaFlowDispatchesMock.mockResolvedValue([]);
    reprioritizePersonaWorkItemDispatchesMock.mockResolvedValue([]);
    movePersonaWorkItemDispatchMock.mockResolvedValue({ found: true, moved: true });
    submitPersonaFlowDispatchMock.mockImplementation(async (
      input: unknown,
      options?: { validateAdmission?: () => Promise<void> },
    ) => {
      await options?.validateAdmission?.();
      return { dispatch: { id: 'dispatch_submitted' }, decision: 'queued', duplicate: false, input };
    });
  });

  it.each([
    ['pause', 'blocked'],
    ['stop', 'cancelled'],
  ] as const)('persists %s intent before cancelling and terminal sync preserves %s', async (
    action,
    expectedStatus,
  ) => {
    await inFreshWorkspace(async () => {
      const { personaId, task } = await createTask(action);
      const dispatch = activeDispatch(personaId, task.id);
      listPersonaFlowDispatchesMock.mockResolvedValue([dispatch]);
      cancelPersonaFlowDispatchByIdMock.mockImplementationOnce(async () => {
        expect((await getPersonaWorkItem(task.personaId, task.id))?.status).toBe(expectedStatus);
        await synchronizeAssignedWorkItemFromActivity(
          terminalAssignment(personaId, task.id, 'cancelled'),
        );
        return { ...dispatch, state: 'cancelled' };
      });

      const result = await controlPersonaWorkItem(personaId, task.id, action);

      expect(result).toMatchObject({ action, workItem: { status: expectedStatus } });
      expect(cancelPersonaFlowDispatchByIdMock).toHaveBeenCalledWith({
        personaId,
        dispatchId: dispatch.id,
        reason: expect.stringContaining(action === 'pause' ? 'paused' : 'stopped'),
      }, { waitForCompletion: true });
      expect((await getPersonaWorkItem(task.personaId, task.id))?.status).toBe(expectedStatus);
    });
  });

  it('deduplicates a repeated retry but creates a new dispatch identity after failure', async () => {
    await inFreshWorkspace(async () => {
      const { personaId, task } = await createTask('retry');
      const blocked = await updatePersonaWorkItem(personaId, task.id, { status: 'blocked' });

      const first = await controlPersonaWorkItem(personaId, task.id, 'retry');
      expect(first).toMatchObject({ admission: 'queued', workItem: { status: 'open' } });
      const firstSubmission = submitPersonaFlowDispatchMock.mock.calls[0][0];

      listPersonaFlowDispatchesMock.mockResolvedValue([
        activeDispatch(personaId, task.id, 'dispatch_first_retry'),
      ]);
      const duplicate = await controlPersonaWorkItem(personaId, task.id, 'retry');
      expect(duplicate.admission).toBe('already_queued');
      expect(submitPersonaFlowDispatchMock).toHaveBeenCalledTimes(1);

      listPersonaFlowDispatchesMock.mockResolvedValue([]);
      await synchronizeAssignedWorkItemFromActivity(
        terminalAssignment(personaId, task.id, 'error'),
      );
      const failed = await getPersonaWorkItem(task.personaId, task.id);
      expect(failed).toMatchObject({ status: 'blocked' });
      expect(failed!.updatedAt).toBeGreaterThan(blocked.updatedAt);

      const second = await controlPersonaWorkItem(personaId, task.id, 'retry');
      expect(second).toMatchObject({ admission: 'queued', workItem: { status: 'open' } });
      const secondSubmission = submitPersonaFlowDispatchMock.mock.calls[1][0];
      expect(secondSubmission.idempotencyKey).not.toBe(firstSubmission.idempotencyKey);
      expect(secondSubmission.source).toEqual({ kind: 'assignment', sourceId: task.id });
      expect(secondSubmission.relationKey).toBe(`persona-task:${task.id}`);
    });
  });

  it('does not restart blocked work while one of its blockers is unfinished', async () => {
    await inFreshWorkspace(async () => {
      const { personaId, task: blocker } = await createTask('blocker');
      const dependent = await createPersonaWorkItem({
        personaId,
        title: 'Wait for blocker',
        dependencyIds: [blocker.id],
      });
      await updatePersonaWorkItem(personaId, dependent.id, { status: 'blocked' });

      await expect(controlPersonaWorkItem(personaId, dependent.id, 'retry'))
        .rejects.toThrow('Finish this Task’s blockers');
      expect(submitPersonaFlowDispatchMock).not.toHaveBeenCalled();
      expect((await getPersonaWorkItem(dependent.personaId, dependent.id))?.status).toBe('blocked');
    });
  });

  it('propagates a changed importance bucket to queued runtime work', async () => {
    await inFreshWorkspace(async () => {
      const { personaId, task } = await createTask('priority');
      listPersonaFlowDispatchesMock.mockResolvedValue([
        { ...activeDispatch(personaId, task.id), state: 'queued' },
      ]);

      const updated = await updatePersonaWorkItem(personaId, task.id, {
        priority: 'urgent',
        expectedUpdatedAt: task.updatedAt,
      });

      expect(updated.priority).toBe('urgent');
      expect(reprioritizePersonaWorkItemDispatchesMock).toHaveBeenCalledWith({
        personaId,
        workItemId: task.id,
        priority: 'urgent',
      });
    });
  });

  it.each([
    ['move_earlier', 'earlier'],
    ['move_later', 'later'],
  ] as const)('maps %s to a real queued mailbox move %s', async (action, direction) => {
    await inFreshWorkspace(async () => {
      const { personaId, task } = await createTask(action);
      listPersonaFlowDispatchesMock.mockResolvedValue([
        { ...activeDispatch(personaId, task.id), state: 'queued' },
      ]);

      const result = await controlPersonaWorkItem(personaId, task.id, action);

      expect(result).toMatchObject({ action, moved: true, workItem: { id: task.id } });
      expect(movePersonaWorkItemDispatchMock).toHaveBeenCalledWith({
        personaId,
        workItemId: task.id,
        direction,
      });
    });
  });

  it('rejects ordinary complete, cancel, and delete mutations while work is active', async () => {
    await inFreshWorkspace(async () => {
      const { personaId, task } = await createTask('active-guards');
      listPersonaFlowDispatchesMock.mockResolvedValue([
        activeDispatch(personaId, task.id),
      ]);

      await expect(updatePersonaWorkItem(personaId, task.id, { status: 'completed' }))
        .rejects.toThrow('still active');
      await expect(updatePersonaWorkItem(personaId, task.id, { status: 'cancelled' }))
        .rejects.toThrow('Use Stop');
      await expect(deletePersonaWorkItem(personaId, task.id))
        .rejects.toThrow('Stop it before deleting');
      expect(await getPersonaWorkItem(task.personaId, task.id)).toMatchObject({ status: 'open' });
    });
  });
});
