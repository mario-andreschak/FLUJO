import type { HarnessRun, HarnessInput } from '@/shared/types/harness';
import { createHarnessRun, advanceHarnessRun, promoteHarnessRun } from '@/backend/services/harness/service';
import { completeHarnessOperation, getHarnessModel } from '@/backend/services/harness/model';
import { flowService } from '@/backend/services/flow';
import { captureHarnessTarget, harnessTargetId, harnessTargetPrompt } from '@/backend/services/harness/targets';
import { getHarnessProfile } from '@/backend/services/harness/profiles';
import type { HarnessProfile, HarnessRuntimeSnapshot } from '@/shared/types/harnessIntegration';

const mockRecords = new Map<string, unknown>();
const mockFlows = new Map<string, unknown>();
let mockEnabled = true;
let mockWorkspace = 'one';
const mockModel = { id: 'luna', name: 'gpt-6-luna', ApiKey: '', provider: 'codex', adapter: 'codex-cli' };

jest.mock('@/utils/storage/backend', () => ({
  assertSafeCollectionId: jest.fn(),
  loadItem: jest.fn(async () => ({ experimental: { harnessLabEnabled: mockEnabled } })),
  loadCollectionItem: jest.fn(async (collection, id, fallback) => structuredClone(mockRecords.get(`${mockWorkspace}/${collection}/${id}`) ?? fallback)),
  saveCollectionItem: jest.fn(async (collection, id, value) => { mockRecords.set(`${mockWorkspace}/${collection}/${id}`, structuredClone(value)); }),
  listCollectionItemEntriesStrict: jest.fn(async collection => [...mockRecords.entries()].filter(([key]) => key.startsWith(`${mockWorkspace}/${collection}/`))
    .map(([key, value]) => ({ id: key.split('/').at(-1), item: structuredClone(value) }))),
}));
jest.mock('@/utils/encryption/secure', () => ({ isEncryptionLocked: jest.fn(async () => false) }));
jest.mock('@/backend/services/harness/profiles', () => ({ configureHarnessProfile: jest.fn(), getHarnessProfile: jest.fn(), publishHarnessVersion: jest.fn() }));
jest.mock('@/backend/services/harness/runtimeProbe', () => ({ probeHarnessRuntime: jest.fn() }));
jest.mock('@/backend/services/harness/targets', () => ({ captureHarnessTarget: jest.fn(), harnessTargetId: jest.fn(), harnessTargetPrompt: jest.fn() }));
jest.mock('@/backend/services/enduringAgents/runtimeLock', () => ({
  withWorkspaceRuntimeLock: jest.fn(async (_name, task) => task({ assertOwned: async () => {} })),
}));
jest.mock('@/backend/services/harness/model', () => ({
  getHarnessModel: jest.fn(async () => ({ model: mockModel, route: 'codex-subscription' })),
  modelFingerprint: jest.fn(() => 'fingerprint'),
  completeHarnessOperation: jest.fn(),
}));
jest.mock('@/backend/services/flow', () => ({ flowService: {
  readFlowExecutionSnapshot: jest.fn(async id => mockFlows.has(id) ? { flow: structuredClone(mockFlows.get(id)) } : null),
  saveFlow: jest.fn(async flow => { mockFlows.set(flow.id, structuredClone(flow)); return { success: true }; }),
} }));

const id = 'c643594a-0d10-4c38-a1d8-32af8e9726c9';
const input: HarnessInput = { name: 'Test', domain: 'Support', modelId: 'luna', basePrompt: 'Original prompt', rounds: 1, reuseLessons: true,
  cases: [
    { id: 't1', split: 'train', input: 'One', required: ['yes'], forbidden: ['no'] },
    { id: 't2', split: 'train', input: 'Two', required: ['yes'], forbidden: ['no'] },
    { id: 'h1', split: 'holdout', input: 'Three', required: ['yes'], forbidden: ['no'] },
    { id: 'h2', split: 'holdout', input: 'Four', required: ['yes'], forbidden: ['no'] },
  ] };

beforeEach(() => {
  mockRecords.clear(); mockFlows.clear(); mockEnabled = true; mockWorkspace = 'one'; jest.clearAllMocks();
  jest.mocked(completeHarnessOperation).mockResolvedValue({ output: 'yes', durationMs: 1, tokens: 3 });
  jest.mocked(getHarnessModel).mockResolvedValue({ model: mockModel as never, route: 'codex-subscription' });
});

it('defaults off at the server boundary and dispatches nothing', async () => {
  mockEnabled = false;
  await expect(createHarnessRun({ id, input })).rejects.toMatchObject({ status: 403 });
  expect(completeHarnessOperation).not.toHaveBeenCalled();
  expect(mockRecords.size).toBe(0);
});

it('reuses a creation ID but rejects known held-out inputs in a new experiment', async () => {
  await createHarnessRun({ id, input });
  await createHarnessRun({ id, input });
  expect([...mockRecords.keys()].filter(key => key.includes('/harness-experiments/'))).toHaveLength(1);
  await expect(createHarnessRun({ id: 'c643594a-0d10-4c38-a1d8-32af8e9726c8', input })).rejects.toThrow('fresh');
  mockWorkspace = 'two';
  await expect(createHarnessRun({ id, input })).resolves.toMatchObject({ id });
  expect([...mockRecords.keys()].filter(key => key.includes('/harness-experiments/'))).toHaveLength(2);
});

it('does not share strategy lessons between different saved targets with the same domain and model', async () => {
  jest.mocked(getHarnessProfile).mockResolvedValue({ policy: {} } as HarnessProfile);
  jest.mocked(harnessTargetId).mockImplementation(target => target.nodeId);
  jest.mocked(harnessTargetPrompt).mockReturnValue('Original prompt');
  jest.mocked(captureHarnessTarget).mockImplementation(async target => ({ target, flow: { id: 'flow', name: 'Flow', nodes: [], edges: [] },
    modelFingerprints: { luna: 'fixed' }, invocation: 'flow', baseRevision: 'revision', contextHash: 'context', maxModelCallsPerProbe: 4 } satisfies HarnessRuntimeSnapshot));
  const target = { kind: 'flow' as const, flowId: 'first-agent', nodeId: 'agent' };
  const first = await createHarnessRun({ id, input: { ...input, target } });
  const summaryKey = `one/harness-run-index/${id}`;
  mockRecords.set(summaryKey, { ...(mockRecords.get(summaryKey) as object), status: 'completed', eligible: true,
    promotedPromptHash: 'adopted', lesson: 'A strategy for the first target' });
  const second = await createHarnessRun({ id: 'c643594a-0d10-4c38-a1d8-32af8e9726c8', input: {
    ...input, target: { ...target, flowId: 'second-agent' }, cases: input.cases.map(item => ({ ...item, input: `New ${item.input}` })),
  } });
  expect(second.lessonScope).not.toBe(first.lessonScope);
  expect(second.lessons).toEqual([]);
});

it('never replays an uncertain persisted provider dispatch', async () => {
  const run = await createHarnessRun({ id, input });
  run.pendingOperation = 'probe:baseline:t1'; run.callsStarted = 1;
  mockRecords.set(`one/harness-experiments/${id}`, run);
  const recovered = await advanceHarnessRun(id, new AbortController().signal);
  expect(recovered.status).toBe('failed');
  expect(recovered.callsStarted).toBe(1);
  expect(completeHarnessOperation).not.toHaveBeenCalled();
});

it('retains completed evidence when a later call fails without retry', async () => {
  await createHarnessRun({ id, input });
  await advanceHarnessRun(id, new AbortController().signal);
  jest.mocked(completeHarnessOperation).mockRejectedValueOnce(new Error('secret upstream URL'));
  const failed = await advanceHarnessRun(id, new AbortController().signal);
  expect(failed.status).toBe('failed');
  expect(failed.candidates[0].probes).toHaveLength(1);
  expect(failed.callsStarted).toBe(2);
  expect(failed.callsCompleted).toBe(1);
  expect(JSON.stringify(failed)).not.toContain('secret upstream URL');
  await advanceHarnessRun(id, new AbortController().signal);
  expect(completeHarnessOperation).toHaveBeenCalledTimes(2);
});

it('stops if the pinned model changes and checks the opt-in on every advance', async () => {
  await createHarnessRun({ id, input });
  jest.mocked(getHarnessModel).mockRejectedValueOnce(new Error('Model changed'));
  await expect(advanceHarnessRun(id, new AbortController().signal)).rejects.toThrow('Model changed');
  expect(completeHarnessOperation).not.toHaveBeenCalled();
  mockEnabled = false;
  await expect(advanceHarnessRun(id, new AbortController().signal)).rejects.toMatchObject({ status: 403 });
});

it('creates one exact, tool-free agent copy and refuses to overwrite later edits', async () => {
  const run = await createHarnessRun({ id, input });
  const selected = { ...run.candidates[0], id: 'composed:1', prompt: 'Improved instructions', promptHash: 'hash' };
  run.candidates.push(selected); run.selectedId = selected.id; run.status = 'completed'; run.decision = { eligible: true, reasons: [] };
  mockRecords.set(`one/harness-experiments/${id}`, run);
  const promoted = await promoteHarnessRun(id);
  await promoteHarnessRun(id);
  expect(flowService.saveFlow).toHaveBeenCalledTimes(1);
  const saved = jest.mocked(flowService.saveFlow).mock.calls[0][0];
  expect(saved.nodes.map(node => node.type)).toEqual(['start', 'process', 'finish']);
  expect(saved.nodes[1].data.properties).toMatchObject({ boundModel: 'luna', promptTemplate: selected.prompt,
    harnessExperimentId: id, excludeSystemPrompt: true, inputMode: 'latest-message' });
  saved.nodes[1].data.properties!.promptTemplate = 'Human edit';
  mockFlows.set(promoted.promotedFlowId!, saved);
  await expect(promoteHarnessRun(id)).rejects.toMatchObject({ status: 409 });
  expect(flowService.saveFlow).toHaveBeenCalledTimes(1);
});
