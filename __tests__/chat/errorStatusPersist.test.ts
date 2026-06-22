/**
 * Regression test for the "failed run persists as 'running'" bug.
 *
 * Root cause: when a step returned ERROR_ACTION (e.g. a model 429/500), the
 * in-loop error path set `currentAction = ERROR_ACTION` and broke, but never
 * set `sharedState.status = 'error'`. The status stayed at its start-of-run
 * value ('running'), so:
 *   - the final persistState() wrote `status: 'running'` to disk, which showed
 *     a blue "running" dot in the sidebar and made the client auto-reattach to
 *     a dead run on reload, and
 *   - finalStatus resolved to 'running' (the `|| ERROR_ACTION` fallback never
 *     fires against a truthy status), so no run:done was emitted and the live
 *     SSE view hung on "Working…".
 *
 * The fix reconciles `sharedState.status = 'error'` when the loop exits with
 * ERROR_ACTION, BEFORE the final persist.
 *
 * Like the other chat tests, this stubs the engine (FlowExecutor) so there is
 * no network/model call: a single step returns ERROR_ACTION with an error
 * lastResponse, mimicking a failed model call.
 */
import type { SharedState } from '@/backend/execution/flow/types';

const CONV_ID = 'conv-error-1';
const FLOW_ID = 'flow-1';
const START = '077cfac0-start';

// Capture every state handed to persistConversationState so the test can assert
// what actually reached durable storage (not just the in-memory object).
const persistedStates: SharedState[] = [];

jest.mock('@/backend/execution/flow/FlowExecutor', () => {
  const conversationStates = new Map();
  return {
    FlowExecutor: {
      conversationStates,
      clearFlowCache: jest.fn(),
      // A single step that fails, exactly as a model 429/500 surfaces: set an
      // error lastResponse and return ERROR_ACTION without touching status.
      executeStep: jest.fn(async (sharedState: any) => {
        sharedState.lastResponse = {
          success: false,
          error: 'Rate limit exceeded',
          errorDetails: { message: 'Rate limit exceeded', status: 429, type: 'rate_limit_error' },
        };
        return { sharedState, action: 'ERROR' };
      }),
      resolveHandoff: jest.fn(async () => ({ isSuccessorEdge: false, targetNodeId: null })),
      peekNextNodeId: jest.fn(async (sharedState: any) => sharedState.currentNodeId ?? START),
    },
  };
});

// Record persisted snapshots (deep-cloned so later mutation of the live object
// doesn't retroactively change what we captured).
jest.mock('@/backend/execution/flow/persistConversationState', () => ({
  persistConversationState: jest.fn(async (_key: string, state: any) => {
    persistedStates.push(JSON.parse(JSON.stringify(state)));
  }),
}));

// Drive everything from the in-memory map; never load from disk.
jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async () => undefined),
}));

import { processChatCompletion } from '@/app/v1/chat/completions/chatCompletionService';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';

const conversationStates = FlowExecutor.conversationStates as Map<string, SharedState>;

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
  persistedStates.length = 0;
  conversationStates.clear();
  (FlowExecutor.executeStep as jest.Mock).mockClear();
});

describe('error status persistence (regression: failed run stays "running")', () => {
  it('persists status "error" (not "running") when a step fails', async () => {
    seedRunning();

    const response = await processChatCompletion(
      simulatedRequest,
      true, // flujo
      false, // requireApproval
      false, // flujodebug
      CONV_ID,
      false, // continueDebug
      false, // userTurn
    );

    // The response itself is the OpenAI-compatible error.
    const body: any = await (response as any).json();
    expect(body.error).toBeDefined();

    // The bug: the LAST state written to disk had status 'running' (the only
    // 'error' assignment happened after the final persist). Persistence is
    // last-write-wins to the same key, so the final snapshot is what the
    // sidebar reads and what reload behavior keys off. After the fix it must be
    // 'error'.
    expect(persistedStates.length).toBeGreaterThan(0);
    const lastPersisted = persistedStates[persistedStates.length - 1];
    expect(lastPersisted.status).toBe('error');

    // And the in-memory state agrees.
    expect(conversationStates.get(CONV_ID)?.status).toBe('error');
  });
});
