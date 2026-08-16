import type { Flow as ReactFlow } from '@/shared/types/flow';

// The engine resolves nodes by loading the flow via flowService.getFlow. Stub it
// to return our in-memory fixture so these tests need no storage or network.
jest.mock('@/backend/services/flow', () => ({
  flowService: { getFlow: jest.fn() },
}));

import { PocketflowEngine } from '@/backend/execution/flow/engine/PocketflowEngine';
import { flowService } from '@/backend/services/flow';
import { IMPLICIT_SUBFLOW_RETURN_ACTION } from '@/backend/execution/flow/types';

const getFlow = flowService.getFlow as jest.Mock;

const START = '077cfac0-0e4a-4641-8885-05b053929aad';
const PROCESS = 'ef2a3c01-427b-44d0-ad7b-f7f4f9f8e2d6';
const PROCESS_2 = '7d59c170-4055-427d-b1ed-8eb7c14fe023';
const SUBFLOW = '688f4ad9-e60f-41b4-a459-91a4782359b0';
const FINISH = '30b2db37-ba22-4bcf-b33e-1d643502694d';
const EDGE_START_PROCESS = `${START}-${PROCESS}`;
const EDGE_PROCESS_FINISH = `${PROCESS}-${FINISH}`;
const FLOW_ID = 'test-flow';

// A minimal start -> process -> finish flow, mirroring the user's repro flow.
function fixtureFlow(): ReactFlow {
  return {
    id: FLOW_ID,
    name: 'TestFlow',
    nodes: [
      { id: START, type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start Node', type: 'start', properties: {} } },
      { id: PROCESS, type: 'process', position: { x: 0, y: 1 }, data: { label: 'Proc', type: 'process', properties: {} } },
      { id: FINISH, type: 'finish', position: { x: 0, y: 2 }, data: { label: 'Finish Node', type: 'finish', properties: {} } },
    ],
    edges: [
      { id: EDGE_START_PROCESS, source: START, target: PROCESS, data: { edgeType: 'standard' } },
      { id: EDGE_PROCESS_FINISH, source: PROCESS, target: FINISH, data: { edgeType: 'standard' } },
    ],
  } as unknown as ReactFlow;
}

function subflowFixture(options: {
  sequential?: boolean;
  bidirectional?: boolean;
  multipleCallers?: boolean;
} = {}): ReactFlow {
  const processToSubflow = `${PROCESS}-${SUBFLOW}`;
  const nodes: any[] = [
    { id: START, type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start Node', type: 'start', properties: {} } },
    { id: PROCESS, type: 'process', position: { x: 0, y: 1 }, data: { label: 'Caller A', type: 'process', properties: {} } },
    { id: SUBFLOW, type: 'subflow', position: { x: 0, y: 2 }, data: { label: 'Worker', type: 'subflow', properties: { subflowId: 'child' } } },
    { id: FINISH, type: 'finish', position: { x: 0, y: 3 }, data: { label: 'After worker', type: 'finish', properties: {} } },
  ];
  const edges: any[] = [
    { id: EDGE_START_PROCESS, source: START, target: PROCESS, data: { edgeType: 'standard' } },
    {
      id: processToSubflow,
      source: PROCESS,
      target: SUBFLOW,
      data: { edgeType: 'standard', ...(options.bidirectional ? { bidirectional: true } : {}) },
    },
  ];

  if (options.sequential) {
    edges.push({ id: `${SUBFLOW}-${FINISH}`, source: SUBFLOW, target: FINISH, data: { edgeType: 'standard' } });
  }
  if (options.multipleCallers) {
    nodes.push({ id: PROCESS_2, type: 'process', position: { x: 1, y: 1 }, data: { label: 'Caller B', type: 'process', properties: {} } });
    edges.push(
      { id: `${START}-${PROCESS_2}`, source: START, target: PROCESS_2, data: { edgeType: 'standard' } },
      { id: `${PROCESS_2}-${SUBFLOW}`, source: PROCESS_2, target: SUBFLOW, data: { edgeType: 'standard' } },
    );
  }

  return { id: FLOW_ID, name: 'SubflowTest', nodes, edges } as unknown as ReactFlow;
}

function state(currentNodeId: string | undefined) {
  return { conversationId: 'c1', flowId: FLOW_ID, currentNodeId, messages: [] } as any;
}

describe('PocketflowEngine graph traversal', () => {
  let engine: PocketflowEngine;
  beforeEach(() => {
    getFlow.mockReset();
    getFlow.mockResolvedValue(fixtureFlow());
    engine = new PocketflowEngine();
  });

  it('resolves the start node when there is no current node', async () => {
    const node = await engine.resolveNode(state(undefined));
    expect(node.id).toBe(START);
    expect(node.type).toBe('start');
  });

  it('filters a presentation-only Trigger at position 1 and still starts at Start', async () => {
    const flow = fixtureFlow();
    const triggerId = 'presentation-trigger';
    flow.nodes = [
      {
        id: triggerId,
        type: 'trigger',
        position: { x: 0, y: -1 },
        data: { label: 'Daily', type: 'trigger', properties: { executionId: 'planned-1' } },
      } as any,
      ...flow.nodes,
    ];
    flow.edges = [
      {
        id: `${triggerId}-${START}`,
        source: triggerId,
        target: START,
        sourceHandle: 'trigger-bottom',
        targetHandle: 'start-top',
        data: { edgeType: 'standard' },
      } as any,
      ...flow.edges,
    ];
    getFlow.mockResolvedValue(flow);
    engine = new PocketflowEngine();

    const node = await engine.resolveNode(state(undefined));

    expect(node.id).toBe(START);
    expect(node.type).toBe('start');
  });

  it('resolves a NON-start node by id (BFS must reach it through clones)', async () => {
    // This is the invariant that, if broken, makes resolveNode fall back to the
    // start node every step — the shape of the "stuck on start" bug.
    const proc = await engine.resolveNode(state(PROCESS));
    expect(proc.id).toBe(PROCESS);
    const fin = await engine.resolveNode(state(FINISH));
    expect(fin.id).toBe(FINISH);
  });

  it('falls back to the start node when the current node id is unknown', async () => {
    const node = await engine.resolveNode(state('does-not-exist'));
    expect(node.id).toBe(START);
  });

  it('resolves a handoff edge from start to the process node', async () => {
    const h = await engine.resolveHandoff(state(START), EDGE_START_PROCESS);
    expect(h.isSuccessorEdge).toBe(true);
    expect(h.targetNodeId).toBe(PROCESS);
    expect(h.targetNodeType).toBe('process');
  });

  it('reports the target node type for a handoff to a finish node', async () => {
    // The chat loop uses targetNodeType === 'finish' to suppress the
    // "The handoff was successful. Continue" message before a completed run.
    const h = await engine.resolveHandoff(state(PROCESS), EDGE_PROCESS_FINISH);
    expect(h.isSuccessorEdge).toBe(true);
    expect(h.targetNodeId).toBe(FINISH);
    expect(h.targetNodeType).toBe('finish');
  });

  it('reports a non-successor action as not a handoff edge', async () => {
    const h = await engine.resolveHandoff(state(START), 'not-an-edge');
    expect(h.isSuccessorEdge).toBe(false);
    expect(h.targetNodeId).toBeNull();
  });

  it('marks Process -> terminal one-way Subflow as an implicit caller return', async () => {
    getFlow.mockResolvedValue(subflowFixture());
    engine = new PocketflowEngine();

    const h = await engine.resolveHandoff(state(PROCESS), `${PROCESS}-${SUBFLOW}`);

    expect(h).toMatchObject({
      isSuccessorEdge: true,
      targetNodeId: SUBFLOW,
      targetNodeType: 'subflow',
      implicitSubflowReturn: {
        subflowNodeId: SUBFLOW,
        callerNodeId: PROCESS,
      },
    });
  });

  it('resolves a terminal Subflow implicit return to the actual Process caller', async () => {
    getFlow.mockResolvedValue(subflowFixture({ multipleCallers: true }));
    engine = new PocketflowEngine();
    const enter = await engine.resolveHandoff(state(PROCESS_2), `${PROCESS_2}-${SUBFLOW}`);
    const returnState = state(SUBFLOW);
    returnState.pendingSubflowReturn = enter.implicitSubflowReturn;

    const back = await engine.resolveHandoff(returnState, IMPLICIT_SUBFLOW_RETURN_ACTION);

    expect(back).toEqual({
      isSuccessorEdge: true,
      targetNodeId: PROCESS_2,
      targetNodeType: 'process',
    });
  });

  it('does not infer a caller return when the Subflow has an onward successor', async () => {
    getFlow.mockResolvedValue(subflowFixture({ sequential: true }));
    engine = new PocketflowEngine();

    const h = await engine.resolveHandoff(state(PROCESS), `${PROCESS}-${SUBFLOW}`);

    expect(h.isSuccessorEdge).toBe(true);
    expect(h.targetNodeId).toBe(SUBFLOW);
    expect(h.implicitSubflowReturn).toBeUndefined();
  });

  it('keeps an explicit bidirectional Process <-> Subflow on its graph reverse edge', async () => {
    getFlow.mockResolvedValue(subflowFixture({ bidirectional: true }));
    engine = new PocketflowEngine();

    const enter = await engine.resolveHandoff(state(PROCESS), `${PROCESS}-${SUBFLOW}`);
    const back = await engine.resolveHandoff(state(SUBFLOW), `${PROCESS}-${SUBFLOW}__reverse`);

    expect(enter.implicitSubflowReturn).toBeUndefined();
    expect(back).toMatchObject({
      isSuccessorEdge: true,
      targetNodeId: PROCESS,
      targetNodeType: 'process',
    });
  });
});
