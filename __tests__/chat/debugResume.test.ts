/**
 * Regression test for the "debugger stuck on the start node" bug.
 *
 * Root cause: the turn-init "direct a new user turn" block in
 * chatCompletionService re-ran on every /debug/step and /debug/continue and
 * reset currentNodeId back to the user message's processNodeId (the start node).
 * Because a start->process handoff appends no assistant message, the only
 * message stayed the original user message, so every debug step bounced back to
 * the start node forever.
 *
 * The fix gates that redirect on `userTurn` (true only for a genuine new turn
 * from the public completions route; debug/respond resumes pass false).
 *
 * These tests stub the engine (FlowExecutor) with a tiny start->process->finish
 * state machine, so there is no network/model call. The key assertion is that a
 * debug step resumes the node it was paused on (process) instead of re-running
 * the start node.
 */
import type { SharedState } from '@/backend/execution/flow/types';

const START = '077cfac0-start';
const PROCESS = 'ef2a3c01-process';
const EDGE_START_PROCESS = `${START}->${PROCESS}`;
const CONV_ID = 'conv-debug-1';
const FLOW_ID = 'flow-1';

// The factory is hoisted above all top-level declarations, so it must be fully
// self-contained. It exposes the shared map and the executed-node log on the
// mocked FlowExecutor object, which the test reads back after importing.
jest.mock('@/backend/execution/flow/FlowExecutor', () => {
  const S = '077cfac0-start';
  const P = 'ef2a3c01-process';
  const EDGE = `${S}->${P}`;
  const FINAL = 'FINAL_RESPONSE';
  const conversationStates = new Map();
  const ranNodes: string[] = [];
  return {
    FlowExecutor: {
      conversationStates,
      __ranNodes: ranNodes,
      clearFlowCache: jest.fn(),
      // Mimic engine.resolveNode + node.run(): resolve the node from
      // currentNodeId (falling back to start when unset, exactly like the real
      // engine), run it, and return an action. Start hands off; process
      // produces a final answer.
      executeStep: jest.fn(async (sharedState: any) => {
        const nodeId = sharedState.currentNodeId ?? S;
        sharedState.currentNodeId = nodeId;
        ranNodes.push(nodeId);
        if (nodeId === S) {
          return { sharedState, action: EDGE };
        }
        sharedState.lastResponse = 'Hello from the process node';
        sharedState.messages.push({
          role: 'assistant',
          content: 'Hello from the process node',
          id: 'assistant-1',
          timestamp: 1,
          processNodeId: P,
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

// No durable persistence in tests.
jest.mock('@/backend/execution/flow/persistConversationState', () => ({
  persistConversationState: jest.fn(async () => {}),
}));

// Never load state from disk; we drive everything from the in-memory map.
jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async () => undefined),
}));

import { processChatCompletion } from '@/app/v1/chat/completions/chatCompletionService';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';

// Shared state surfaced by the mocked FlowExecutor (see the factory above).
const conversationStates = FlowExecutor.conversationStates as Map<string, SharedState>;
const ranNodes = (FlowExecutor as any).__ranNodes as string[];

function seedPausedAtProcess() {
  const state: SharedState = {
    trackingInfo: { executionId: 'e1', startTime: 1, nodeExecutionTracker: [] },
    messages: [
      { role: 'user', content: 'hi', id: 'user-1', timestamp: 1, processNodeId: START } as any,
    ],
    flowId: FLOW_ID,
    conversationId: CONV_ID,
    currentNodeId: PROCESS, // paused here after the first step handed off start->process
    status: 'paused_debug',
    debugMode: true,
    originalRequireApproval: false,
    createdAt: 1,
    updatedAt: 1,
  } as unknown as SharedState;
  conversationStates.set(CONV_ID, state);
  return state;
}

const simulatedRequest = {
  model: `flow-TestFlow`,
  messages: [{ role: 'user', content: 'hi', processNodeId: START }],
} as any;

beforeEach(() => {
  ranNodes.length = 0;
  conversationStates.clear();
  (FlowExecutor.executeStep as jest.Mock).mockClear();
});

describe('debug step resume (regression: stuck on start node)', () => {
  it('resumes the paused node (process) instead of resetting to the start node', async () => {
    seedPausedAtProcess();

    // Simulate POST /debug/step: continueDebug=false, userTurn=false.
    const response = await processChatCompletion(
      simulatedRequest,
      true, // flujo
      false, // requireApproval
      false, // flujodebug (ignored on resume)
      CONV_ID,
      false, // continueDebug
      false, // userTurn  <-- the resume must NOT redirect to the start node
    );
    const body: any = await (response as any).json();

    // The very first node executed by this step must be the paused node, NOT a
    // restart from the start node. This is exactly what the bug got wrong.
    expect(ranNodes[0]).toBe(PROCESS);
    expect(ranNodes).not.toContain(START);

    // And the run should make progress to completion.
    expect(body.status).toBe('completed');
    expect(conversationStates.get(CONV_ID)?.currentNodeId).toBe(PROCESS);
  });

  it('a genuine new user turn (userTurn=true) still honors the message processNodeId', async () => {
    // Seed a state stranded on the process node after a previous completion, with
    // the user's new message tagged to resume at the start node.
    const state = seedPausedAtProcess();
    state.status = 'completed';

    await processChatCompletion(
      simulatedRequest,
      true,
      false,
      false,
      CONV_ID,
      false,
      true, // userTurn: a fresh turn SHOULD redirect to the tagged node (start)
    );

    // With userTurn=true the redirect fires, so execution restarts at the start
    // node (preserving the round-2 "stranded on finish node" fix).
    expect(ranNodes[0]).toBe(START);
  });
});
