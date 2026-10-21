import { probeHarnessRuntime } from '@/backend/services/harness/runtimeProbe';
import { runFlow } from '@/backend/execution/flow/runFlow';
import { getHarnessExecution } from '@/backend/services/harness/executionScope';
import type { HarnessRun, HarnessCase } from '@/shared/types/harness';
import type { HarnessRuntimeSnapshot } from '@/shared/types/harnessIntegration';
import { FLOW_INVOCATION_SOURCES, isUnattendedFlowInvocation } from '@/shared/types/execution/invocation';

jest.mock('@/backend/execution/flow/runFlow', () => ({ runFlow: jest.fn(async () => ({ status: 'completed', outputText: 'Result' })) }));
jest.mock('@/backend/services/harness/targets', () => ({ assertHarnessTargetCurrent: jest.fn(), harnessCandidateFlow: jest.fn(runtime => runtime.flow) }));
jest.mock('@/backend/services/harness/model', () => ({ getHarnessModel: jest.fn() }));
jest.mock('@/backend/services/enduringAgents/behaviorRevisions', () => ({ hashBehaviorFlow: () => 'candidate' }));
jest.mock('@/backend/services/enduringAgents/personaCoreApps', () => ({ authorizePersonaCoreAppAccess: jest.fn() }));

const example: HarnessCase = { id: 'task', split: 'train', input: 'Task', required: [], forbidden: [] };
const runtime: HarnessRuntimeSnapshot = { flow: { id: 'flow', name: 'Flow', nodes: [], edges: [] }, invocation: 'flow', modelFingerprints: {},
  target: { kind: 'flow', flowId: 'flow', nodeId: 'agent' }, baseRevision: 'revision', contextHash: 'context', maxModelCallsPerProbe: 4 };
const makeRun = () => ({ runtime, origin: 'manual' } as HarnessRun);
const probe = (run: HarnessRun, task = example) => probeHarnessRuntime(run, { kind: 'probe', key: 'probe', candidateId: 'baseline',
  system: 'Instructions', user: task.input, example: task }, new AbortController().signal, async () => {}, async () => {});
beforeEach(() => jest.clearAllMocks());

it.each(FLOW_INVOCATION_SOURCES)('retains %s invocation semantics independently from ephemeral storage', async source => {
  await probe({ ...makeRun(), origin: 'automatic' }, { ...example, source });
  const input = jest.mocked(runFlow).mock.calls[0][0];
  expect(input).toMatchObject({ source, mode: 'ephemeral' });
  expect(isUnattendedFlowInvocation(input.source)).toBe(isUnattendedFlowInvocation(source));
});

it('uses interactive chat for manual agent cases and refuses legacy automatic evidence without a turn source', async () => {
  await probe(makeRun());
  expect(jest.mocked(runFlow).mock.calls[0][0].source).toBe('chat');
  await expect(probe({ ...makeRun(), origin: 'automatic' })).rejects.toThrow('invocation semantics');
  expect(runFlow).toHaveBeenCalledTimes(1);
});

it('keeps recorded maintenance schema policy inside replay without granting a Persona mutator', async () => {
  const persona = { ...runtime, invocation: 'persona-behavior' as const,
    personaAttribution: { personaId: 'persona', activityId: 'harness-synthetic', behaviorRevisionId: 'revision' } };
  jest.mocked(runFlow).mockImplementationOnce(async input => {
    expect(input.source).toBe('subflow');
    expect(input.executionAuthority?.commitPersonaMutation).toBeUndefined();
    expect(getHarnessExecution()?.personaToolPolicy).toEqual({ maintenanceMemoryProposal: true });
    return { status: 'completed', outputText: 'Result' } as Awaited<ReturnType<typeof runFlow>>;
  });
  await probe({ ...makeRun(), runtime: persona, casePersonaToolPolicies: { task: { maintenanceMemoryProposal: true } } });
  expect(getHarnessExecution()).toBeUndefined();
});
