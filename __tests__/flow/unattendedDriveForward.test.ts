/**
 * Unattended drive-forward (issue #218).
 *
 * When a Process node ends its turn on plain text (no tool call / handoff) it
 * returns FINAL_RESPONSE_ACTION, which normally completes the run. In an
 * UNATTENDED run that silent completion is the bug: a model that "narrates and
 * stops" instead of handing off dead-ends the flow halfway (labels not moved,
 * no commit) while the run reports success. In unattended mode the engine must
 * instead drive the conversation forward along the node's single non-returning
 * successor.
 *
 * The engine (FlowExecutor) is stubbed with a tiny start->process state machine
 * so there is no model/network call; flowService.getFlow returns the graph the
 * drive-forward logic inspects.
 */
import type { SharedState } from '@/backend/execution/flow/types';

const START = 'start-node';
const PROCESS = 'process-node';
const FOLLOWUP = 'followup-node';
const FINISH = 'finish-node';
const FLOW_ID = 'flow-unattended';

jest.mock('@/backend/execution/flow/FlowExecutor', () => {
  const S = 'start-node';
  const P = 'process-node';
  const EDGE = `${S}->${P}`;
  const FINAL = 'FINAL_RESPONSE';
  const conversationStates = new Map();
  return {
    FlowExecutor: {
      conversationStates,
      clearFlowCache: jest.fn(),
      // start -> process (handoff); every other node ends its turn on plain
      // text (FINAL) — exactly the stall the drive-forward must rescue.
      executeStep: jest.fn(async (sharedState: any) => {
        const nodeId = sharedState.currentNodeId ?? S;
        sharedState.currentNodeId = nodeId;
        if (nodeId === S) {
          return { sharedState, action: EDGE };
        }
        sharedState.lastResponse = `plain text from ${nodeId}`;
        sharedState.messages.push({
          role: 'assistant',
          content: `plain text from ${nodeId}`,
          id: `a-${nodeId}-${sharedState.messages.length}`,
          timestamp: 1,
          processNodeId: nodeId,
        });
        return { sharedState, action: FINAL };
      }),
      resolveHandoff: jest.fn(async (sharedState: any, action: string) => {
        if (sharedState.currentNodeId === S && action === EDGE) {
          return { isSuccessorEdge: true, targetNodeId: P };
        }
        return { isSuccessorEdge: false, targetNodeId: null };
      }),
      peekNextNodeId: jest.fn(async (sharedState: any) => sharedState.currentNodeId ?? S),
    },
  };
});

jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async () => undefined),
  saveItem: jest.fn(async () => {}),
  assertSafeCollectionId: (id: string) => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      throw new Error(`Unsafe collection item id: ${JSON.stringify(id)}`);
    }
  },
}));

// The graph the drive-forward inspects. Process node -> a single forward
// (standard, non-bidirectional) edge to a follow-up subflow, which then leads
// to a finish node. Two bidirectional back-edges (to test-runner/explorer
// nodes) must NOT count as forward successors.
const flowGraph = {
  id: FLOW_ID,
  name: 'UnattendedFlow',
  unattended: true,
  nodes: [
    { id: START, type: 'start' },
    { id: PROCESS, type: 'process' },
    { id: FOLLOWUP, type: 'subflow' },
    { id: FINISH, type: 'finish' },
    { id: 'runner', type: 'subflow' },
    { id: 'mcp-server', type: 'mcp' },
  ],
  edges: [
    { source: START, target: PROCESS, type: 'custom', data: { edgeType: 'standard' } },
    // bidirectional back-edge — returns to caller, NOT a forward continuation
    { source: PROCESS, target: 'runner', type: 'custom', data: { edgeType: 'standard', bidirectional: true } },
    // an MCP edge — never a control successor
    { source: PROCESS, target: 'mcp-server', type: 'mcpEdge', data: { edgeType: 'mcp' } },
    // the ONE genuine forward successor
    { source: PROCESS, target: FOLLOWUP, type: 'custom', data: { edgeType: 'standard' } },
    { source: FOLLOWUP, target: FINISH, type: 'custom', data: { edgeType: 'standard' } },
  ],
};

const getFlowMock = jest.fn(async () => flowGraph);

jest.mock('@/backend/services/flow/index', () => ({
  flowService: {
    loadFlows: jest.fn(async () => [flowGraph]),
    getFlow: (...args: unknown[]) => getFlowMock(...(args as [])),
  },
}));

jest.mock('@/backend/execution/flow/validateFlowForRun', () => ({
  validateFlowForRun: jest.fn(async () => ({ issues: [], errorCount: 0, warningCount: 0, isRunnable: true })),
}));

import { runFlow } from '@/backend/execution/flow/runFlow';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';

const conversationStates = FlowExecutor.conversationStates as Map<string, SharedState>;

beforeEach(() => {
  conversationStates.clear();
  (FlowExecutor.executeStep as jest.Mock).mockClear();
  getFlowMock.mockClear();
  getFlowMock.mockResolvedValue(flowGraph);
});

describe('unattended drive-forward (#218)', () => {
  it('auto-advances a stalled process node to its single forward successor', async () => {
    const result = await runFlow({
      flowId: FLOW_ID,
      prompt: 'do the work',
      mode: 'ephemeral',
      source: 'schedule',
    });

    // The run did not silently stop at the stalled process node: it was driven
    // forward to the node's single forward successor (the follow-up), where
    // normal execution takes over.
    expect(result.status).toBe('completed');
    expect(result.sharedState.currentNodeId).toBe(FOLLOWUP);
    expect(result.sharedState.currentNodeId).not.toBe(PROCESS);

    // executeStep ran three times — start, process, then the follow-up node the
    // stall was driven into (a non-unattended run stops after two: start,
    // process). Node identity can't be read off the call args because every
    // call shares the one mutated sharedState reference, so assert the count.
    expect((FlowExecutor.executeStep as jest.Mock).mock.calls.length).toBe(3);
  });

  it('does NOT drive forward for an interactive (non-unattended) run', async () => {
    // A flow with no explicit flag + a non-schedule source stays interactive:
    // a plain-text turn completes the run at the process node (today's behavior).
    getFlowMock.mockResolvedValue({ ...flowGraph, unattended: undefined } as any);

    const result = await runFlow({
      flowId: FLOW_ID,
      prompt: 'hello',
      mode: 'ephemeral',
      source: 'chat',
    });

    expect(result.status).toBe('completed');
    expect(result.sharedState.currentNodeId).toBe(PROCESS);
    // Stopped at the process node: only start + process ran, no drive-forward.
    expect((FlowExecutor.executeStep as jest.Mock).mock.calls.length).toBe(2);
  });

  it('honors an explicit unattended:false even for a scheduled run', async () => {
    getFlowMock.mockResolvedValue({ ...flowGraph, unattended: false } as any);

    const result = await runFlow({
      flowId: FLOW_ID,
      prompt: 'scheduled but pinned interactive',
      mode: 'ephemeral',
      source: 'schedule',
    });

    expect(result.status).toBe('completed');
    expect(result.sharedState.currentNodeId).toBe(PROCESS);
  });
});
