import type { Flow as ReactFlow } from '@/shared/types/flow';

// The engine resolves nodes by loading the flow via flowService.getFlow. Stub it
// to return our in-memory fixture so these tests need no storage or network.
jest.mock('@/backend/services/flow', () => ({
  flowService: { getFlow: jest.fn() },
}));

import { PocketflowEngine } from '@/backend/execution/flow/engine/PocketflowEngine';
import { flowService } from '@/backend/services/flow';

const getFlow = flowService.getFlow as jest.Mock;

const START = '077cfac0-0e4a-4641-8885-05b053929aad';
const PROCESS = 'ef2a3c01-427b-44d0-ad7b-f7f4f9f8e2d6';
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
});
