import { activateHarnessVersion, configureHarnessProfile, getHarnessProfile, readHarnessVersionFlow, saveHarnessProfile, noteHarnessPersonaSelection } from '@/backend/services/harness/profiles';
import { captureHarnessTarget } from '@/backend/services/harness/targets';
import { hashBehaviorFlow } from '@/backend/services/enduringAgents/behaviorRevisions';
import { harnessDigest } from '@/backend/services/harness/executionScope';
import { flowService } from '@/backend/services/flow';
import type { Flow } from '@/shared/types/flow';
import type { HarnessRuntimeSnapshot } from '@/shared/types/harnessIntegration';

const mockData = new Map<string, unknown>();
let mockFlow: Flow;
jest.mock('@/utils/storage/backend', () => ({
  loadCollectionItem: jest.fn(async (collection, id, fallback) => structuredClone(mockData.get(`${collection}/${id}`) ?? fallback)),
  saveCollectionItem: jest.fn(async (collection, id, value) => { mockData.set(`${collection}/${id}`, structuredClone(value)); }),
  listCollectionItems: jest.fn(async collection => [...mockData.entries()].filter(([key]) => key.startsWith(`${collection}/`)).map(([, value]) => structuredClone(value))),
}));
jest.mock('@/backend/services/enduringAgents/runtimeLock', () => ({ withWorkspaceRuntimeLock: jest.fn(async (name, task) => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error('Invalid runtime lock id');
  return task({ assertOwned: async () => {} });
}) }));
jest.mock('@/backend/services/harness/service', () => ({ assertHarnessEnabled: jest.fn(async () => {}),
  HarnessError: class extends Error { constructor(message: string, public status = 400) { super(message); } } }));
jest.mock('@/backend/services/harness/model', () => ({ getHarnessModel: jest.fn(async () => ({})) }));
jest.mock('@/backend/services/enduringAgents/store', () => ({ activateBehaviorBindingRevision: jest.fn(), createBehaviorRevision: jest.fn(), getBehaviorBinding: jest.fn(), listBehaviorRevisions: jest.fn(async () => []) }));
jest.mock('@/backend/services/flow', () => ({ flowService: { getFlow: jest.fn(async () => structuredClone(mockFlow)),
  readFlowExecutionSnapshot: jest.fn(async () => ({ flow: structuredClone(mockFlow) })), saveFlow: jest.fn() } }));
jest.mock('@/backend/services/harness/targets', () => ({ captureHarnessTarget: jest.fn(),
  harnessTargetId: (target: unknown) => jest.requireActual('@/backend/services/harness/executionScope').harnessDigest(target),
  harnessTargetPrompt: (flow: Flow) => flow.nodes[1].data.properties!.promptTemplate,
  snapshotHarnessFlow: async (flow: Flow) => structuredClone(flow),
}));
const target = { kind: 'flow' as const, flowId: 'flow', nodeId: 'agent' };
beforeEach(() => {
  jest.clearAllMocks(); mockData.clear();
  mockFlow = { id: 'flow', name: 'Agent', updatedAt: 1, nodes: [
    { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { type: 'start', label: 'Start', properties: {} } },
    { id: 'agent', type: 'process', position: { x: 0, y: 1 }, data: { type: 'process', label: 'Agent', properties: { boundModel: 'luna', promptTemplate: 'baseline' } } },
    { id: 'finish', type: 'finish', position: { x: 0, y: 2 }, data: { type: 'finish', label: 'Finish', properties: {} } },
  ], edges: [{ id: 'a', source: 'start', target: 'agent' }, { id: 'b', source: 'agent', target: 'finish' }] };
  jest.mocked(captureHarnessTarget).mockImplementation(async actual => ({ target: actual, flow: structuredClone(mockFlow),
    baseRevision: hashBehaviorFlow(mockFlow), contextHash: 'context', modelFingerprints: {}, maxModelCallsPerProbe: 4, invocation: 'flow' } as HarnessRuntimeSnapshot));
  jest.mocked(flowService.saveFlow).mockImplementation(async flow => { mockFlow = structuredClone(flow); mockFlow.updatedAt = (mockFlow.updatedAt ?? 1) + 1; return { success: true }; });
});

async function versions() {
  const profile = await configureHarnessProfile(target, { modelId: 'luna', automatic: true });
  const candidate = structuredClone(mockFlow);
  candidate.nodes[1].data.properties!.promptTemplate = 'improved';
  profile.versions.push({ id: harnessDigest('second'), createdAt: Date.now(), parentId: profile.activeVersionId, label: 'Second',
    prompt: 'improved', flow: candidate, flowHash: hashBehaviorFlow(candidate) });
  await saveHarnessProfile(profile);
  return profile;
}

it('stores immutable snapshots separately and supports forward, rollback and forward again', async () => {
  let profile = await versions();
  expect(profile.versions.every(version => version.flow === undefined)).toBe(true);
  expect((await readHarnessVersionFlow(profile.id, profile.versions[0])).nodes[1].data.properties!.promptTemplate).toBe('baseline');
  for (const index of [1, 0, 1]) {
    profile = await activateHarnessVersion(profile.id, profile.versions[index].id, profile.updatedAt);
    expect(mockFlow.nodes[1].data.properties!.promptTemplate).toBe(index ? 'improved' : 'baseline');
    expect(profile.activeVersionId).toBe(profile.versions[index].id);
    expect(profile.policy.automatic).toBe(false);
  }
  expect(captureHarnessTarget).toHaveBeenLastCalledWith(target, 4, 'source');
});

it('rejects stale UI state and external edits instead of replacing them', async () => {
  const profile = await versions();
  await expect(activateHarnessVersion(profile.id, profile.versions[1].id, profile.updatedAt - 1)).rejects.toThrow('changed');
  mockFlow.nodes[1].data.properties!.promptTemplate = 'user edit';
  await expect(activateHarnessVersion(profile.id, profile.versions[1].id, profile.updatedAt)).rejects.toThrow('edited');
  expect(flowService.saveFlow).not.toHaveBeenCalled();
});

it('retains and resumes the activation journal after a source-write failure', async () => {
  const profile = await versions();
  jest.mocked(flowService.saveFlow).mockResolvedValueOnce({ success: false, error: 'failed' });
  await expect(activateHarnessVersion(profile.id, profile.versions[1].id, profile.updatedAt)).rejects.toThrow('retried');
  const interrupted = (await getHarnessProfile(profile.id))!;
  expect(interrupted.pendingActivation?.versionId).toBe(profile.versions[1].id);
  const recovered = await activateHarnessVersion(profile.id, profile.versions[1].id, interrupted.updatedAt);
  expect(recovered.pendingActivation).toBeUndefined();
  expect(recovered.activeVersionId).toBe(profile.versions[1].id);
});

it('pauses unattended improvement when the existing Persona version UI selects a retained revision', async () => {
  const profile = await versions();
  profile.target = { kind: 'persona', personaId: 'persona', behaviorId: 'behavior', nodeId: 'agent' };
  profile.policy.automatic = true;
  profile.versions[1].behaviorRevisionId = 'revision-two';
  await saveHarnessProfile(profile);
  await noteHarnessPersonaSelection('persona', 'behavior', 'revision-two');
  expect(await getHarnessProfile(profile.id)).toMatchObject({ activeVersionId: profile.versions[1].id, policy: { automatic: false } });
});
