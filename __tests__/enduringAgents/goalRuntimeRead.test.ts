import { readPersonaGoalRuntime } from '@/backend/services/enduringAgents/goalRuntimeRead';
import { personaFlowDispatchId } from '@/backend/services/enduringAgents/personaDispatcher';
import { getPersonaActivity, getPersonaLease, getPersonaMailboxItem, getPersonaWorkItem } from '@/backend/services/enduringAgents/store';
import { getPersonaFlowDispatch } from '@/backend/services/enduringAgents/personaDispatcher';
import { readPersonaRuntimeEvents } from '@/backend/services/enduringAgents/runtimeEvents';

jest.mock('@/utils/workspace', () => ({ getCurrentWorkspace: () => 'workspace_owner' }));
jest.mock('@/backend/services/enduringAgents/store', () => ({
  getPersonaActivity: jest.fn(), getPersonaLease: jest.fn(),
  getPersonaMailboxItem: jest.fn(), getPersonaWorkItem: jest.fn(),
}));
jest.mock('@/backend/services/enduringAgents/runtimeEvents', () => ({ readPersonaRuntimeEvents: jest.fn() }));
jest.mock('@/backend/services/enduringAgents/personaDispatcher', () => ({
  getPersonaFlowDispatch: jest.fn(),
  personaFlowDispatchId: jest.fn(() => 'dispatch_one'),
}));

const workItem = getPersonaWorkItem as jest.Mock;
const dispatchGet = getPersonaFlowDispatch as jest.Mock;
const mailboxGet = getPersonaMailboxItem as jest.Mock;
const activityGet = getPersonaActivity as jest.Mock;
const leaseGet = getPersonaLease as jest.Mock;
const eventRead = readPersonaRuntimeEvents as jest.Mock;
const dispatchId = personaFlowDispatchId('persona_owner', 'attempt_one');
const root = () => ({
  id: 'goal_one', personaId: 'persona_owner', status: 'in_progress', updatedAt: 7,
  nextAction: 'Review the synthetic case', goal: {
    state: 'active', rounds: 1, pendingTaskId: 'goal_one',
    pendingAttemptKey: 'attempt_one', pendingDispatchId: dispatchId,
  },
  description: 'private goal context',
});
const dispatch = () => ({
  id: dispatchId, personaId: 'persona_owner', workspaceId: 'workspace_owner',
  state: 'queued', admission: { kind: 'assignment', source: { kind: 'assignment', sourceId: 'goal_one' } },
  mailboxItemId: 'mailbox_one', activityId: 'activity_one',
  flowInput: { messages: [{ content: 'private prompt' }] },
});
const mailbox = () => ({
  id: 'mailbox_one', personaId: 'persona_owner', status: 'claimed', kind: 'assignment',
  source: { kind: 'assignment', sourceId: 'goal_one' }, routingDecision: 'queue',
  payloadRef: dispatchId, claimedActivityId: 'activity_one', summary: 'private summary',
});
const activity = () => ({
  id: 'activity_one', personaId: 'persona_owner', status: 'running',
  source: { kind: 'assignment', sourceId: 'goal_one' }, entryPointPayloadRef: dispatchId,
  leaseId: 'lease_one', runId: 'run_one', conversationId: 'conversation_one',
  instructionContext: { private: 'secret' },
});
const lease = () => ({
  id: 'lease_one', personaId: 'persona_owner', workspaceId: 'workspace_owner',
  activityId: 'activity_one', status: 'active', expiresAt: Date.now() + 60_000,
  holderId: 'private_holder', fencingToken: 99,
});

beforeEach(() => {
  jest.resetAllMocks();
  (personaFlowDispatchId as jest.Mock).mockReturnValue('dispatch_one');
  workItem.mockImplementation(async (_personaId: string, id: string) => id === 'goal_one' ? root() : null);
  dispatchGet.mockResolvedValue(dispatch());
  mailboxGet.mockResolvedValue(mailbox());
  activityGet.mockResolvedValue(activity());
  leaseGet.mockResolvedValue(lease());
  eventRead.mockResolvedValue([]);
});

it('denies absent, foreign and child Goal roots before reading runtime records', async () => {
  workItem.mockResolvedValueOnce(null);
  await expect(readPersonaGoalRuntime('persona_owner', 'goal_one')).rejects.toThrow('Goal not found');
  workItem.mockResolvedValueOnce({ ...root(), personaId: 'persona_other' });
  await expect(readPersonaGoalRuntime('persona_owner', 'goal_one')).rejects.toThrow('Goal not found');
  workItem.mockResolvedValueOnce({ ...root(), parentGoalId: 'another_goal' });
  await expect(readPersonaGoalRuntime('persona_owner', 'goal_one')).rejects.toThrow('Goal not found');
  expect(dispatchGet).not.toHaveBeenCalled();
});

it('distinguishes registered, reserved and mailbox queued from accepted execution', async () => {
  workItem.mockResolvedValueOnce({ ...root(), goal: { state: 'active', rounds: 0 } });
  workItem.mockResolvedValueOnce({ ...root(), goal: { state: 'active', rounds: 0 } });
  await expect(readPersonaGoalRuntime('persona_owner', 'goal_one')).resolves.toMatchObject({
    state: 'registered', verified: false, round: null,
  });
  dispatchGet.mockResolvedValueOnce(null);
  await expect(readPersonaGoalRuntime('persona_owner', 'goal_one')).resolves.toMatchObject({
    state: 'reserved', verified: true, activity: null,
  });
  dispatchGet.mockResolvedValueOnce({ ...dispatch(), activityId: undefined });
  mailboxGet.mockResolvedValueOnce({ ...mailbox(), status: 'queued', claimedActivityId: undefined });
  await expect(readPersonaGoalRuntime('persona_owner', 'goal_one')).resolves.toMatchObject({
    state: 'queued', verified: true, activity: null,
  });
});

it('reports joined running and terminal evidence, projecting no private fields', async () => {
  dispatchGet.mockResolvedValueOnce({ ...dispatch(), state: 'running' });
  dispatchGet.mockResolvedValueOnce({ ...dispatch(), state: 'running' });
  const running = await readPersonaGoalRuntime('persona_owner', 'goal_one');
  expect(running).toMatchObject({
    state: 'accepted_running', verified: true,
    round: { number: 1, taskId: 'goal_one', attemptId: 'attempt_one', dispatchId },
    activity: { id: 'activity_one', runId: 'run_one', conversationId: 'conversation_one' },
    lease: { id: 'lease_one', status: 'active' },
  });
  expect(JSON.stringify(running)).not.toMatch(/private|fencingToken|holderId|flowInput|instructionContext/);
  workItem.mockResolvedValueOnce({ ...root(), goal: { state: 'active', rounds: 1, lastActivityId: 'activity_one' } });
  eventRead.mockResolvedValueOnce([{
    type: 'goal:round', goalId: 'goal_one', round: 1, taskId: 'goal_one',
    attemptKey: 'attempt_one', dispatchId,
  }]);
  dispatchGet.mockResolvedValueOnce({ ...dispatch(), state: 'completed' });
  dispatchGet.mockResolvedValueOnce({ ...dispatch(), state: 'completed' });
  activityGet.mockResolvedValueOnce({ ...activity(), status: 'completed' });
  activityGet.mockResolvedValueOnce({ ...activity(), status: 'completed' });
  await expect(readPersonaGoalRuntime('persona_owner', 'goal_one')).resolves.toMatchObject({
    state: 'terminal_observed', verified: true, activity: { id: 'activity_one', status: 'completed' },
  });
});

it.each([
  ['partial pending', () => workItem.mockResolvedValueOnce({ ...root(), goal: { state: 'active', rounds: 1, pendingTaskId: 'goal_one' } }), 'incomplete_pending_round'],
  ['foreign workspace', () => dispatchGet.mockResolvedValueOnce({ ...dispatch(), workspaceId: 'workspace_other' }), 'dispatch_identity_mismatch'],
  ['wrong task', () => dispatchGet.mockResolvedValueOnce({ ...dispatch(), admission: { kind: 'assignment', source: { kind: 'assignment', sourceId: 'other' } } }), 'dispatch_identity_mismatch'],
  ['wrong mailbox', () => mailboxGet.mockResolvedValueOnce({ ...mailbox(), payloadRef: 'other' }), 'mailbox_identity_mismatch'],
  ['wrong Activity', () => activityGet.mockResolvedValueOnce({ ...activity(), entryPointPayloadRef: 'other' }), 'activity_identity_mismatch'],
  ['wrong lease', () => { dispatchGet.mockResolvedValueOnce({ ...dispatch(), state: 'running' }); leaseGet.mockResolvedValueOnce({ ...lease(), activityId: 'other' }); }, 'current_lease_mismatch'],
] as const)('keeps %s evidence unverified', async (_name, arrange, reason) => {
  arrange();
  await expect(readPersonaGoalRuntime('persona_owner', 'goal_one')).resolves.toMatchObject({
    state: 'unverified', verified: false, reason,
  });
});

it('does not treat a cleared pending round without its saved event as accepted', async () => {
  workItem.mockResolvedValueOnce({ ...root(), goal: { state: 'active', rounds: 1, lastActivityId: 'activity_one' } });
  await expect(readPersonaGoalRuntime('persona_owner', 'goal_one')).resolves.toMatchObject({
    state: 'unverified', reason: 'round_event_unavailable',
  });
  expect(dispatchGet).not.toHaveBeenCalled();
});
