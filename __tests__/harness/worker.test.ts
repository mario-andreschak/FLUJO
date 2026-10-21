import { drainHarnessProfile, observeHarnessConversation } from '@/backend/services/harness/worker';
import { advanceHarnessRun, createHarnessRun, promoteHarnessRun, getHarnessRun, cancelHarnessRun } from '@/backend/services/harness/service';
import { withHarnessExecution, type HarnessExecutionScope } from '@/backend/services/harness/executionScope';
import { HarnessPolicySchema, type HarnessProfile } from '@/shared/types/harnessIntegration';
import type { HarnessRun } from '@/shared/types/harness';
import type { SharedState } from '@/backend/execution/flow/types';

const mockData = new Map<string, unknown>();
let mockProfile: HarnessProfile;
let mockRun: HarnessRun | undefined;
jest.mock('@/utils/storage/backend', () => ({
  loadCollectionItem: jest.fn(async (collection, id, fallback) => structuredClone(mockData.get(`${collection}/${id}`) ?? fallback)),
  saveCollectionItem: jest.fn(async (collection, id, value) => { mockData.set(`${collection}/${id}`, structuredClone(value)); }),
}));
jest.mock('@/utils/workspace', () => ({ getCurrentWorkspace: () => 'test', runWithWorkspace: async (_workspace: string, task: () => unknown) => task() }));
jest.mock('@/backend/services/workspace/workerMode', () => ({ isWorkerMode: () => false }));
jest.mock('@/backend/services/enduringAgents/runtimeLock', () => ({ withWorkspaceRuntimeLock: jest.fn(async (name, task) => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error('Invalid runtime lock id');
  return task({ assertOwned: async () => {} });
}) }));
jest.mock('@/backend/services/harness/profiles', () => ({
  listHarnessProfiles: async () => [], // Tests explicitly drive a drain; background discovery stays idle.
  harnessProfilesForTarget: async () => [structuredClone(mockProfile)],
  getHarnessProfile: async () => structuredClone(mockProfile),
  saveHarnessProfile: async (profile: HarnessProfile) => { mockProfile = structuredClone(profile); },
}));
jest.mock('@/backend/services/harness/history', () => ({ hasSeenHarnessTask: async () => false }));
jest.mock('@/backend/services/harness/targets', () => ({
  captureHarnessTarget: async () => ({ flow: { name: 'Agent' } }), harnessTargetPrompt: () => 'Instructions',
}));
jest.mock('@/backend/services/harness/service', () => ({
  assertHarnessEnabled: async () => {}, listHarnessRunSummaries: async () => [],
  createHarnessRun: jest.fn(async ({ id, input }) => (mockRun = { id, input, status: 'pending' } as HarnessRun)),
  getHarnessRun: jest.fn(async () => { if (!mockRun) throw Object.assign(new Error('not found'), { status: 404 }); return structuredClone(mockRun); }),
  advanceHarnessRun: jest.fn(async () => (mockRun = { ...mockRun!, status: 'completed', decision: { eligible: true, reasons: [] } })),
  promoteHarnessRun: jest.fn(async () => ({ ...mockRun!, activatedVersionId: 'version-2' })),
  cancelHarnessRun: jest.fn(async () => (mockRun = { ...mockRun!, status: 'cancelled' })),
}));

beforeEach(() => {
  jest.useFakeTimers(); jest.clearAllMocks(); mockData.clear(); mockRun = undefined;
  mockProfile = { id: 'profile', target: { kind: 'flow', flowId: 'flow', nodeId: 'agent' },
    policy: HarnessPolicySchema.parse({ automatic: true, modelId: 'luna', cooldownMinutes: 1 }),
    updatedAt: 1, activeVersionId: 'version-1', versions: [], events: [] };
});
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });
function turn(task: string, ephemeral = false) {
  return { status: 'completed', flowId: 'flow', ephemeral, conversationId: 'conversation', logicalRunId: `run-${task}`,
    messages: [{ id: task, role: 'user', content: task }, { role: 'assistant', content: 'Result' }] } as SharedState;
}
async function evidence() {
  for (const task of ['one', 'two', 'three', 'four']) await observeHarnessConversation(turn(task), { source: 'chat' });
  const queue = mockData.get('harness-queues/profile') as { nextRunAt: number };
  queue.nextRunAt = 0;
}

it('automatically splits fresh tasks before proposing, evaluates and activates without a UI advance', async () => {
  await evidence();
  await drainHarnessProfile(mockProfile);
  expect(createHarnessRun).toHaveBeenCalledTimes(1);
  const [request, automatic] = jest.mocked(createHarnessRun).mock.calls[0];
  expect((request as { input: HarnessRun['input'] }).input.cases.map(item => item.split)).toEqual(['train', 'train', 'holdout', 'holdout']);
  expect(automatic?.profileId).toBe(mockProfile.id);
  expect((request as { input: HarnessRun['input'] }).input.cases.map(item => item.source)).toEqual(['chat', 'chat', 'chat', 'chat']);
  expect(advanceHarnessRun).toHaveBeenCalledTimes(1);
  expect(promoteHarnessRun).toHaveBeenCalledTimes(1);
  expect(mockProfile.events.at(-1)?.action).toBe('generation_accepted');
  expect(mockData.get('harness-queues/profile')).toMatchObject({ pending: [], job: undefined });
});

it('does not count repeated tasks or evaluation runs as new conversation evidence', async () => {
  await observeHarnessConversation(turn('same'), { source: 'chat' });
  await observeHarnessConversation(turn('same'), { source: 'chat' });
  await observeHarnessConversation(turn('ephemeral', true), { source: 'chat' });
  await withHarnessExecution({} as HarnessExecutionScope, () => observeHarnessConversation(turn('evaluation'), { source: 'chat' }));
  const queue = mockData.get('harness-queues/profile') as { pending: string[] };
  expect(queue.pending).toHaveLength(1);
  await drainHarnessProfile(mockProfile);
  expect(createHarnessRun).not.toHaveBeenCalled();
});

it('records this turn source instead of a scheduled conversation origin and rejects unknown legacy sources', async () => {
  await observeHarnessConversation({ ...turn('resumed'), source: 'schedule' }, { source: 'chat' });
  await observeHarnessConversation(turn('unknown'));
  const observations = [...mockData.entries()].filter(([key]) => key.startsWith('harness-observations/'));
  expect(observations).toHaveLength(1);
  expect(observations[0][1]).toMatchObject({ source: 'chat' });
});

it('resumes a durable job identity and does not mint another experiment after a restart', async () => {
  await evidence();
  const queue = mockData.get('harness-queues/profile') as { pending: string[]; job?: unknown };
  queue.job = { id: 'persisted-job', observations: queue.pending.splice(0, 4) };
  mockRun = { id: 'persisted-job', status: 'pending' } as HarnessRun;
  await drainHarnessProfile(mockProfile);
  expect(getHarnessRun).toHaveBeenCalledWith('persisted-job');
  expect(createHarnessRun).not.toHaveBeenCalled();
  expect(advanceHarnessRun).toHaveBeenCalledWith('persisted-job', expect.any(AbortSignal));
});

it('honors disablement and retains a stopped-job event when a dispatch cannot continue', async () => {
  await evidence();
  mockProfile.policy.automatic = false;
  await drainHarnessProfile(mockProfile);
  expect(createHarnessRun).not.toHaveBeenCalled();
  mockProfile.policy.automatic = true;
  jest.mocked(advanceHarnessRun).mockRejectedValueOnce(new Error('unavailable provider'));
  await drainHarnessProfile(mockProfile);
  expect(cancelHarnessRun).toHaveBeenCalledTimes(1);
  expect(promoteHarnessRun).not.toHaveBeenCalled();
  expect(mockProfile.events.at(-1)?.action).toBe('generation_stopped');
});
