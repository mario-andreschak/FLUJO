/**
 * Regression test for stale compiled flows across a conversation.
 *
 * The engine caches the compiled (FlowConverter) graph per flowId and only
 * invalidates it on saveFlow/deleteFlow. Edits made elsewhere (e.g. a model's
 * settings on the Models page) never touch that cache, and within a turn the
 * many executeStep/resolveHandoff calls all reuse the cached graph. To
 * guarantee each turn runs against the current flow definition,
 * processChatCompletion drops the compiled-flow cache once per genuine user
 * turn (userTurn=true) — but NOT on internal resumes (debug step/continue,
 * tool-approval respond), which must keep the within-turn compiled graph.
 *
 * Like the other chat tests, this stubs the engine (FlowExecutor) so there is
 * no network/model call.
 */
import type { SharedState } from '@/backend/execution/flow/types';

const CONV_ID = 'conv-cache-1';
const FLOW_ID = 'flow-1';
const START = '077cfac0-start';

jest.mock('@/backend/execution/flow/FlowExecutor', () => {
  const conversationStates = new Map();
  return {
    FlowExecutor: {
      conversationStates,
      clearFlowCache: jest.fn(),
      // A single step that ends the run immediately so the loop exits cleanly;
      // the cache refresh happens before the loop, so the action is irrelevant.
      executeStep: jest.fn(async (sharedState: any) => {
        sharedState.lastResponse = { success: true, content: 'ok' };
        return { sharedState, action: 'complete' };
      }),
      resolveHandoff: jest.fn(async () => ({ isSuccessorEdge: false, targetNodeId: null })),
      peekNextNodeId: jest.fn(async (sharedState: any) => sharedState.currentNodeId ?? START),
    },
  };
});

jest.mock('@/backend/execution/flow/persistConversationState', () => ({
  persistConversationState: jest.fn(async () => {}),
}));

// Drive everything from the in-memory map; never load from disk.
jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async () => undefined),
}));

import { processChatCompletion } from '@/app/v1/chat/completions/chatCompletionService';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';

const conversationStates = FlowExecutor.conversationStates as Map<string, SharedState>;
const clearFlowCache = FlowExecutor.clearFlowCache as jest.Mock;

function seedRunning() {
  const state: SharedState = {
    trackingInfo: { executionId: 'e1', startTime: 1, nodeExecutionTracker: [] },
    messages: [
      { role: 'user', content: 'hi', id: 'user-1', timestamp: 1, processNodeId: START } as any,
    ],
    flowId: FLOW_ID,
    conversationId: CONV_ID,
    currentNodeId: START,
    status: 'running',
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
  conversationStates.clear();
  clearFlowCache.mockClear();
  (FlowExecutor.executeStep as jest.Mock).mockClear();
});

describe('per-turn compiled-flow cache refresh', () => {
  it('drops the compiled-flow cache for the flow at the start of a user turn', async () => {
    seedRunning();

    await processChatCompletion(
      simulatedRequest,
      true,  // flujo
      false, // requireApproval
      false, // flujodebug
      CONV_ID,
      false, // continueDebug
      true,  // userTurn
    );

    expect(clearFlowCache).toHaveBeenCalledWith(FLOW_ID);
  });

  it('does NOT drop the cache on an internal resume (userTurn=false)', async () => {
    seedRunning();

    await processChatCompletion(
      simulatedRequest,
      true,  // flujo
      false, // requireApproval
      false, // flujodebug
      CONV_ID,
      false, // continueDebug
      false, // userTurn
    );

    expect(clearFlowCache).not.toHaveBeenCalled();
  });
});
