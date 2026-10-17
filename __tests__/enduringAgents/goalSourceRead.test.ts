/** Retained release preflight; mocked lineage is not operational acceptance. */
import { GoalSourceUnavailableError, readPersonaGoalSource } from '@/backend/services/enduringAgents/goalSourceRead';
import { readPersonaGoalRuntime } from '@/backend/services/enduringAgents/goalRuntimeRead';
import { getBehaviorRevision, getPersonaActivity } from '@/backend/services/enduringAgents/store';

jest.mock('@/backend/services/enduringAgents/goalRuntimeRead', () => ({ readPersonaGoalRuntime: jest.fn() }));
jest.mock('@/backend/services/enduringAgents/store', () => ({ getBehaviorRevision: jest.fn(), getPersonaActivity: jest.fn() }));
const runtime = () => ({ goal: { id: 'goal_one', version: 7, rounds: 1 }, verified: true, state: 'terminal_observed',
  round: { taskId: 'task_one' }, dispatch: { id: 'dispatch_one' },
  activity: { id: 'activity_one', status: 'completed', runId: 'run_one', conversationId: 'conversation_one' } });
const activity = () => ({ id: 'activity_one', personaId: 'persona_one', status: 'completed',
  source: { kind: 'assignment', sourceId: 'task_one' }, entryPointPayloadRef: 'dispatch_one',
  runId: 'run_one', conversationId: 'conversation_one', behaviorId: 'behavior_one',
  behaviorRevisionId: 'revision_one', coreFlowRevisionId: 'revision_one', coreFlowId: 'flow_one',
  instructionContext: { original: 'frozen source' }, outcome: { summary: 'review' },
  context: { private: 'customer context' }, leaseId: 'private_lease', messages: ['private messages'] });
const revision = () => ({ id: 'revision_one', personaId: 'persona_one', behaviorId: 'behavior_one',
  flowSnapshot: { id: 'flow_one' } });

beforeEach(() => {
  jest.resetAllMocks();
  (readPersonaGoalRuntime as jest.Mock).mockImplementation(async () => runtime());
  (getPersonaActivity as jest.Mock).mockImplementation(async () => activity());
  (getBehaviorRevision as jest.Mock).mockImplementation(async () => revision());
});

it('reads only the joined original records and excludes unrelated private Activity fields', async () => {
  const result = await readPersonaGoalSource('persona_one', 'goal_one');
  expect(result).toMatchObject({ goalId: 'goal_one', goalVersion: 7, round: 1,
    activity: { id: 'activity_one', instructionContext: { original: 'frozen source' } }, behaviorRevision: revision() });
  expect(JSON.stringify(result)).not.toMatch(/private_lease|private messages|customer context/);
  expect(getPersonaActivity).toHaveBeenCalledTimes(2);
  expect(getPersonaActivity).toHaveBeenCalledWith('persona_one', 'activity_one');
  expect(getBehaviorRevision).toHaveBeenCalledWith('revision_one');
});

it.each([
  { personaId: 'foreign' }, { id: 'foreign' }, { entryPointPayloadRef: 'foreign' },
  { source: { kind: 'assignment', sourceId: 'foreign' } }, { runId: 'foreign' },
  { behaviorRevisionId: 'new_revision' }, { coreFlowRevisionId: undefined }, { status: 'running' },
])('holds changed original Activity lineage %p', async change => {
  (getPersonaActivity as jest.Mock).mockResolvedValue({ ...activity(), ...change });
  await expect(readPersonaGoalSource('persona_one', 'goal_one')).rejects.toBeInstanceOf(GoalSourceUnavailableError);
});

it.each([null, { ...revision(), personaId: 'foreign' }, { ...revision(), behaviorId: 'foreign' },
  { ...revision(), flowSnapshot: { id: 'foreign' } }])('holds missing or foreign frozen revisions %p', async value => {
  (getBehaviorRevision as jest.Mock).mockResolvedValue(value);
  await expect(readPersonaGoalSource('persona_one', 'goal_one')).rejects.toBeInstanceOf(GoalSourceUnavailableError);
});

it('holds source, outcome and Goal drift and never selects a current replacement Flow', async () => {
  (getPersonaActivity as jest.Mock).mockResolvedValueOnce(activity()).mockResolvedValueOnce({ ...activity(), outcome: { summary: 'changed' } });
  await expect(readPersonaGoalSource('persona_one', 'goal_one')).rejects.toBeInstanceOf(GoalSourceUnavailableError);
  (readPersonaGoalRuntime as jest.Mock).mockResolvedValueOnce(runtime()).mockResolvedValueOnce({ ...runtime(), goal: { ...runtime().goal, version: 8 } });
  await expect(readPersonaGoalSource('persona_one', 'goal_one')).rejects.toBeInstanceOf(GoalSourceUnavailableError);
});

it('holds nonexecuting or unverified Goals before reading an Activity', async () => {
  (readPersonaGoalRuntime as jest.Mock).mockResolvedValueOnce({ ...runtime(), verified: false });
  await expect(readPersonaGoalSource('persona_one', 'goal_one')).rejects.toBeInstanceOf(GoalSourceUnavailableError);
  expect(getPersonaActivity).not.toHaveBeenCalled();
});
