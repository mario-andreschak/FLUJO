import type { Flow as ReactFlow } from '@/shared/types/flow';

// Quick-Chats (issue #61): the engine must resolve the flow from a state's
// `flowSnapshot` WITHOUT ever calling flowService.getFlow, and the store path
// must stay unchanged for states that carry no snapshot. Stub getFlow so we can
// assert it is (not) called.
jest.mock('@/backend/services/flow', () => ({
  flowService: { getFlow: jest.fn() },
}));

import { PocketflowEngine } from '@/backend/execution/flow/engine/PocketflowEngine';
import { flowService } from '@/backend/services/flow';

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

function snapshotState(currentNodeId?: string) {
  return {
    conversationId: 'c1',
    flowId: 'quickchat-c1',
    flowSnapshot: snapshotFlow(),
    currentNodeId,
    messages: [],
  } as any;
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
