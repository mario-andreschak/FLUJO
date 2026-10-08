import type { Flow, FlowNode } from '@/shared/types/flow';
import { getCurrentWorkspace } from '@/utils/workspace';
import {
  hashBehaviorFlow, resolveBehaviorSubflowSnapshot, snapshotBehaviorFlowDependencies,
  verifyBehaviorDependencies,
} from '@/backend/services/enduringAgents/behaviorRevisions';
import { subflowExecutionAuthority } from '@/backend/execution/flow/executionAuthority';
import { buildHandoffDescription } from '@/backend/execution/flow/buildHandoffDescription';

const children = new Map<string, Flow>();
const capture = jest.fn(async (id: string) => children.has(id)
  ? { workspaceId: getCurrentWorkspace(), flow: children.get(id)!, versionId: 'bounded-history-unused' }
  : null);
const getMutableFlow = jest.fn(async (id: string) => children.get(id) ?? null);
jest.mock('@/backend/services/flow', () => ({ flowService: { readFlowExecutionSnapshot: (...args: [string]) => capture(...args), getFlow: (...args: [string]) => getMutableFlow(...args) } }));

function call(id: string, properties: Record<string, unknown>): FlowNode {
  return { id, type: 'subflow', position: { x: 0, y: 0 }, data: { type: 'subflow', label: id, properties } };
}
function graph(id: string, nodes: FlowNode[] = []): Flow {
  const executable = nodes.filter(node => node.type === 'subflow');
  const chain = ['start', ...executable.map(node => node.id), 'finish'];
  return { id, name: id, nodes: [
    { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { type: 'start', label: 'Start' } }, ...nodes,
    { id: 'finish', type: 'finish', position: { x: 1, y: 0 }, data: { type: 'finish', label: 'Finish' } },
  ], edges: chain.slice(1).map((target, index) => ({ id: `edge-${index}`, source: chain[index], target })) };
}

describe('immutable executable Behavior dependency closure', () => {
  beforeEach(() => { children.clear(); capture.mockClear(); getMutableFlow.mockClear(); });

  it('pins nested, shared and static fan-out children, preserving their authored tools', async () => {
    const leaf = graph('leaf', [{ id: 'own-tools', type: 'mcp', position: { x: 0, y: 0 }, data: { type: 'mcp', label: 'Own', properties: { boundServer: 'worker-only', enabledTools: ['write_artifact'] } } }]);
    children.set('leaf', leaf);
    children.set('worker-a', graph('worker-a', [call('nested', { subflowId: 'leaf' })]));
    children.set('worker-b', graph('worker-b', [call('nested', { subflowId: 'leaf' })]));
    const original = graph('supervisor', [call('workers', { parallelSubflowIds: ['worker-a', 'worker-b'] })]);
    const pinned = await snapshotBehaviorFlowDependencies(original);
    expect(pinned.executionDependencies).toMatchObject({ schemaVersion: 1, workspaceId: getCurrentWorkspace() });
    expect(pinned.executionDependencies!.flows.map(entry => entry.flowId)).toEqual(['leaf', 'worker-a', 'worker-b']);
    expect(capture.mock.calls.filter(([id]) => id === 'leaf')).toHaveLength(1);
    expect(original.executionDependencies).toBeUndefined();
    const worker = resolveBehaviorSubflowSnapshot(pinned, 'workers', 'worker-a', getCurrentWorkspace());
    expect(worker.executionDependencies!.flows.map(entry => entry.flowId)).toEqual(['leaf']);
    const resolvedLeaf = resolveBehaviorSubflowSnapshot(worker, 'nested', 'leaf', getCurrentWorkspace());
    expect(resolvedLeaf).toEqual(leaf);
    expect(resolvedLeaf.executionDependencies).toBeUndefined();
    children.clear(); // deletion/edit-history pruning cannot change pinned execution
    expect(resolveBehaviorSubflowSnapshot(worker, 'nested', 'leaf', getCurrentWorkspace())).toEqual(leaf);
  });

  it('changes the parent content address when only a child changes; old closures remain valid', async () => {
    children.set('worker', graph('worker', [call('grandchild', { subflowId: 'leaf' })]));
    children.set('leaf', graph('leaf'));
    const parent = graph('core', [call('delegate', { subflowId: 'worker', inputMode: 'isolated' })]);
    const first = await snapshotBehaviorFlowDependencies(parent);
    children.set('leaf', { ...graph('leaf'), description: 'updated execution contract' });
    const next = await snapshotBehaviorFlowDependencies(parent);
    expect(hashBehaviorFlow(next)).not.toBe(hashBehaviorFlow(first));
    expect(() => verifyBehaviorDependencies(JSON.parse(JSON.stringify(first)) as Flow)).not.toThrow();
    expect(first.executionDependencies!.flows.find(entry => entry.flowId === 'leaf')!.flowSnapshot.description).toBeUndefined();
  });

  it('keeps model-facing handoff descriptions pinned after child edits, without consulting mutable Flows', async () => {
    const worker = graph('worker', [{ id: 'agent', type: 'process', position: { x: 0, y: 0 }, data: { type: 'process', label: 'Verify', properties: { boundModel: 'model-test', promptTemplate: 'Use the pinned verification contract.' } } }]);
    children.set('worker', worker);
    const parent = await snapshotBehaviorFlowDependencies(graph('core', [call('delegate', { subflowId: 'worker' })]));
    const target = parent.nodes.find(node => node.id === 'delegate')!;
    const original = await buildHandoffDescription(target, parent);
    worker.nodes.find(node => node.id === 'agent')!.data.properties!.promptTemplate = 'Mutable replacement instructions.';
    expect(await buildHandoffDescription(target, parent)).toBe(original);
    expect(original).toContain('pinned verification contract');
    expect(getMutableFlow).not.toHaveBeenCalled();
  });

  it('bounds dynamic selection to each node’s authored immutable allow-list', async () => {
    children.set('worker', graph('worker'));
    children.set('other', graph('other'));
    const parent = graph('core', [call('dynamic', { parallelSubflowIdsVar: 'workers', parallelSubflowIds: ['worker'] }), call('other-node', { subflowId: 'other' })]);
    const pinned = await snapshotBehaviorFlowDependencies(parent);
    expect(resolveBehaviorSubflowSnapshot(pinned, 'dynamic', 'worker', getCurrentWorkspace()).id).toBe('worker');
    expect(() => resolveBehaviorSubflowSnapshot(pinned, 'dynamic', 'other', getCurrentWorkspace())).toThrow('unpinned target other');
    await expect(snapshotBehaviorFlowDependencies(graph('core', [call('dynamic', { parallelSubflowIdsVar: 'workers' })]))).rejects.toThrow('1–32');
    await expect(snapshotBehaviorFlowDependencies(graph('core', [call('dynamic', { parallelSubflowIdsVar: 'workers', parallelSubflowIds: Array.from({ length: 33 }, (_, index) => `worker-${index}`) })]))).rejects.toThrow('1–32');
  });

  it('fails closed for missing/deleted targets, cross-workspace captures, unconfigured children and cycles', async () => {
    const parent = graph('core', [call('delegate', { subflowId: 'missing' })]);
    await expect(snapshotBehaviorFlowDependencies(parent)).rejects.toThrow('missing or deleted');
    capture.mockResolvedValueOnce({ workspaceId: 'other-workspace', flow: graph('missing'), versionId: 'ignored' });
    await expect(snapshotBehaviorFlowDependencies(parent)).rejects.toThrow('another workspace');
    await expect(snapshotBehaviorFlowDependencies(graph('core', [call('unconfigured', {})]))).rejects.toThrow('no configured');
    children.set('worker', graph('worker', [call('back', { subflowId: 'core' })]));
    await expect(snapshotBehaviorFlowDependencies(graph('core', [call('delegate', { subflowId: 'worker' })]))).rejects.toThrow('cycle');
    children.set('invalid', { id: 'invalid', name: 'Corrupt child graph', nodes: [], edges: [] });
    await expect(snapshotBehaviorFlowDependencies(graph('core', [call('delegate', { subflowId: 'invalid' })]))).rejects.toThrow('not runnable');
  });

  it('verifies content hashes and completeness before selecting any worker', async () => {
    children.set('worker', graph('worker'));
    const pinned = await snapshotBehaviorFlowDependencies(graph('core', [call('delegate', { subflowId: 'worker' })]));
    const corrupt = structuredClone(pinned);
    corrupt.executionDependencies!.flows[0].flowSnapshot.name = 'tampered';
    expect(() => verifyBehaviorDependencies(corrupt)).toThrow('corrupt');
    const incomplete = structuredClone(pinned);
    incomplete.executionDependencies!.flows = [];
    expect(() => verifyBehaviorDependencies(incomplete)).toThrow('missing from');
    expect(() => resolveBehaviorSubflowSnapshot(pinned, 'delegate', 'worker', 'different-workspace')).toThrow('another workspace');
  });

  it('rejects excessive dependency depth and closure size before publication', async () => {
    for (let index = 0; index < 18; index += 1) {
      children.set(`deep-${index}`, graph(`deep-${index}`, index < 17 ? [call('next', { subflowId: `deep-${index + 1}` })] : []));
    }
    await expect(snapshotBehaviorFlowDependencies(graph('core', [call('delegate', { subflowId: 'deep-0' })]))).rejects.toThrow('depth exceeds 8');
    const targets = Array.from({ length: 129 }, (_, index) => `wide-${index}`);
    for (const id of targets) children.set(id, graph(id));
    await expect(snapshotBehaviorFlowDependencies(graph('core', [call('delegate', { parallelSubflowIds: targets })]))).rejects.toThrow('exceeds 128');
  });

  it('propagates the fence while withholding Persona mutation, memory, App and mailbox capabilities', async () => {
    const mutation = jest.fn();
    const authority = { signal: new AbortController().signal, assertCurrent: jest.fn(async () => undefined), commitWhileCurrent: async <T>(task: () => Promise<T>) => { mutation(); return task(); },
      authorizePersonaCoreMcp: jest.fn(), commitPersonaMutation: jest.fn(), commitPersonaMemoryMaintenance: jest.fn(), pollRelatedInputs: jest.fn() };
    const child = subflowExecutionAuthority(authority)!;
    await child.assertCurrent();
    expect(authority.assertCurrent).toHaveBeenCalledTimes(1);
    await expect(child.commitWhileCurrent!(async () => 'fenced')).resolves.toBe('fenced');
    expect(child.signal).toBe(authority.signal);
    expect(Object.keys(child).sort()).toEqual(['assertCurrent', 'commitWhileCurrent', 'signal']);
  });
});
