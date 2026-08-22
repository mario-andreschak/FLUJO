import type { Flow as ReactFlow } from '@/shared/types/flow';

// Quick-Chats (issue #61): the engine must resolve the flow from a state's
// `flowSnapshot` WITHOUT ever calling flowService.getFlow, and the store path
// must stay unchanged for states that carry no snapshot. Stub getFlow so we can
// assert it is (not) called.
jest.mock('@/backend/services/flow', () => ({
  flowService: { getFlow: jest.fn() },
}));

import { PocketflowEngine } from '@/backend/execution/flow/engine/PocketflowEngine';
import { BaseNode } from '@/backend/execution/flow/pocketflow';
import { flowService } from '@/backend/services/flow';
import { personaCoreAppNodeId } from '@/backend/services/enduringAgents/personaCoreAppIdentity';

const getFlow = flowService.getFlow as jest.Mock;

const START = '077cfac0-0e4a-4641-8885-05b053929aad';
const PROCESS = 'ef2a3c01-427b-44d0-ad7b-f7f4f9f8e2d6';
const FINISH = '30b2db37-ba22-4bcf-b33e-1d643502694d';

function snapshotFlow(): ReactFlow {
  return {
    id: 'quickchat-c1',
    name: 'Quick Chat',
    nodes: [
      { id: START, type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start', type: 'start', properties: {} } },
      { id: PROCESS, type: 'process', position: { x: 0, y: 1 }, data: { label: 'Chat', type: 'process', properties: {} } },
      { id: FINISH, type: 'finish', position: { x: 0, y: 2 }, data: { label: 'Finish', type: 'finish', properties: {} } },
    ],
    edges: [
      { id: `${START}-${PROCESS}`, source: START, target: PROCESS, data: { edgeType: 'standard' } },
      { id: `${PROCESS}-${FINISH}`, source: PROCESS, target: FINISH, data: { edgeType: 'standard' } },
    ],
  } as unknown as ReactFlow;
}

function snapshotState(
  currentNodeId?: string,
  flowSnapshot = snapshotFlow(),
  conversationId = 'c1',
) {
  return {
    conversationId,
    flowId: flowSnapshot.id,
    flowSnapshot,
    currentNodeId,
    messages: [],
  } as any;
}

function snapshotWithPersonaApp(): ReactFlow {
  const flow = snapshotFlow();
  const process = flow.nodes.find(({ id }) => id === PROCESS)!;
  process.data.properties = {
    ...process.data.properties,
    mcpNodes: [{
      id: personaCoreAppNodeId('personal-computer'),
      properties: {
        boundServer: 'personal-computer',
        enabledTools: ['sandbox_exec'],
        enabledResources: 'all',
      },
    }],
  };
  return flow;
}

function trustedPersonaState(flowSnapshot: ReactFlow, conversationId: string) {
  const state = snapshotState(PROCESS, flowSnapshot, conversationId);
  state.personaAttribution = {
    personaId: 'jim',
    activityId: 'activity-1',
    behaviorRevisionId: 'revision-1',
  };
  state.personaInstructionContext = { kind: 'persona-core' };
  Object.defineProperty(state, 'executionAuthority', {
    value: {
      assertCurrent: jest.fn(),
      signal: new AbortController().signal,
      authorizePersonaCoreMcp: jest.fn(),
    },
    enumerable: false,
  });
  Object.defineProperty(state, 'personaCoreAppRefs', {
    value: ['personal-computer'],
    enumerable: false,
  });
  return state;
}

function resolvedMcpNodes(resolved: Awaited<ReturnType<PocketflowEngine['resolveNode']>>) {
  return ((resolved.handle as BaseNode).node_params.properties as { mcpNodes?: unknown }).mcpNodes;
}

describe('PocketflowEngine — quick-chat snapshot resolution (issue #61)', () => {
  let engine: PocketflowEngine;
  beforeEach(() => {
    getFlow.mockReset();
    // If the engine ever consults the store for a snapshot state, this rejection
    // surfaces the regression instead of masking it.
    getFlow.mockRejectedValue(new Error('flowService.getFlow must not be called for a snapshot'));
    engine = new PocketflowEngine();
  });

  it('resolves the start node from the snapshot without touching the store', async () => {
    const node = await engine.resolveNode(snapshotState(undefined));
    expect(node.id).toBe(START);
    expect(node.type).toBe('start');
    expect(getFlow).not.toHaveBeenCalled();
  });

  it('resolves a non-start node from the snapshot by id', async () => {
    const proc = await engine.resolveNode(snapshotState(PROCESS));
    expect(proc.id).toBe(PROCESS);
    expect(getFlow).not.toHaveBeenCalled();
  });

  it('resolves a handoff edge from the snapshot', async () => {
    const h = await engine.resolveHandoff(snapshotState(START), `${START}-${PROCESS}`);
    expect(h.isSuccessorEdge).toBe(true);
    expect(h.targetNodeId).toBe(PROCESS);
    expect(getFlow).not.toHaveBeenCalled();
  });

  it('isolates concurrent same-id snapshot revisions in the compiled graph cache', async () => {
    const v1 = snapshotFlow();
    const startV2 = '2d65336e-7d64-4fd6-b9a7-670e4e75e0b8';
    const processV2 = '65c1fb27-101a-432e-8086-9ef603c902df';
    const finishV2 = '5e21f4f2-1b73-44b0-a173-52c267377c5c';
    const v2 = {
      ...snapshotFlow(),
      name: 'Same root id, revision 2',
      nodes: [
        { id: startV2, type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start v2', type: 'start', properties: {} } },
        { id: processV2, type: 'process', position: { x: 0, y: 1 }, data: { label: 'Chat v2', type: 'process', properties: {} } },
        { id: finishV2, type: 'finish', position: { x: 0, y: 2 }, data: { label: 'Finish v2', type: 'finish', properties: {} } },
      ],
      edges: [
        { id: `${startV2}-${processV2}`, source: startV2, target: processV2, data: { edgeType: 'standard' } },
        { id: `${processV2}-${finishV2}`, source: processV2, target: finishV2, data: { edgeType: 'standard' } },
      ],
    } as unknown as ReactFlow;

    await expect(engine.resolveNode(snapshotState(PROCESS, v1, 'persona-v1')))
      .resolves.toMatchObject({ id: PROCESS, type: 'process' });
    await expect(engine.resolveNode(snapshotState(processV2, v2, 'persona-v2')))
      .resolves.toMatchObject({ id: processV2, type: 'process' });
    await expect(engine.resolveNode(snapshotState(PROCESS, v1, 'persona-v1')))
      .resolves.toMatchObject({ id: PROCESS, type: 'process' });
    expect(getFlow).not.toHaveBeenCalled();
  });

  it('isolates Persona App authority in both compiled-cache orderings', async () => {
    const flowSnapshot = snapshotWithPersonaApp();

    const trustedFirst = await engine.resolveNode(
      trustedPersonaState(flowSnapshot, 'trusted-first'),
    );
    const untrustedSecond = await engine.resolveNode(
      snapshotState(PROCESS, flowSnapshot, 'untrusted-second'),
    );

    expect(resolvedMcpNodes(trustedFirst)).toEqual([{
      id: personaCoreAppNodeId('personal-computer'),
      properties: {
        boundServer: 'personal-computer',
        enabledTools: ['sandbox_exec'],
        enabledResources: 'all',
      },
    }]);
    expect(resolvedMcpNodes(untrustedSecond)).toEqual([]);

    const inverseEngine = new PocketflowEngine();
    const untrustedFirst = await inverseEngine.resolveNode(
      snapshotState(PROCESS, flowSnapshot, 'untrusted-first'),
    );
    const trustedSecond = await inverseEngine.resolveNode(
      trustedPersonaState(flowSnapshot, 'trusted-second'),
    );

    expect(resolvedMcpNodes(untrustedFirst)).toEqual([]);
    expect(resolvedMcpNodes(trustedSecond)).toEqual([{
      id: personaCoreAppNodeId('personal-computer'),
      properties: {
        boundServer: 'personal-computer',
        enabledTools: ['sandbox_exec'],
        enabledResources: 'all',
      },
    }]);
    expect(getFlow).not.toHaveBeenCalled();
  });

  it('still uses the store when the state carries no snapshot', async () => {
    getFlow.mockReset();
    getFlow.mockResolvedValue(snapshotFlow());
    const node = await engine.resolveNode({
      conversationId: 'c2',
      flowId: 'a-real-flow-id',
      currentNodeId: undefined,
      messages: [],
    } as any);
    expect(node.id).toBe(START);
    expect(getFlow).toHaveBeenCalledWith('a-real-flow-id');
  });
});
