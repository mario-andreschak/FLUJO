import type { SharedState } from '@/backend/execution/flow/types';
import { makeLocalRequest } from '../utils/localRequest';

const assertUnlockedMock = jest.fn(async () => undefined);
jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...args: unknown[]) => assertUnlockedMock(...(args as [])),
}));

jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { conversationStates: new Map() },
}));

const persistMock = jest.fn(async () => {});
jest.mock('@/backend/execution/flow/persistConversationState', () => ({
  persistConversationState: (...args: unknown[]) => persistMock(...(args as [])),
}));

jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async () => undefined),
  assertSafeCollectionId: (id: string) => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      throw new Error(`Unsafe collection item id: ${JSON.stringify(id)}`);
    }
  },
}));

jest.mock('@/backend/services/flow/index', () => ({
  flowService: { getFlow: jest.fn(async () => ({ id: 'flow-1', name: 'Test Flow' })) },
}));

jest.mock('@/app/v1/chat/completions/chatCompletionService', () => ({
  processChatCompletion: jest.fn(),
}));

import { POST } from '@/app/v1/chat/conversations/[conversationId]/debug/continue/route';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { processChatCompletion } from '@/app/v1/chat/completions/chatCompletionService';

const CONV_ID = 'conv-debug-continue-1';
const conversationStates = FlowExecutor.conversationStates as Map<string, SharedState>;
const processChatCompletionMock = processChatCompletion as jest.Mock;
let observedStateAtResume: Partial<SharedState> | undefined;

const seedState = (overrides: Partial<SharedState> = {}): SharedState => {
  const state = {
    trackingInfo: { executionId: 'e1', startTime: 1, nodeExecutionTracker: [] },
    messages: [],
    flowId: 'flow-1',
    conversationId: CONV_ID,
    currentNodeId: 'process-1',
    status: 'paused_debug',
    debugMode: true,
    debugPauseRequested: true,
    breakpoints: ['process-1', 'tool:*'],
    lastBreakNodeId: 'process-1',
    debugPendingAction: {
      action: 'FINAL_RESPONSE',
      nodeId: 'process-1',
      phase: 'after-model',
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as unknown as SharedState;
  conversationStates.set(CONV_ID, state);
  return state;
};

const continueRun = () => POST(
  makeLocalRequest(),
  { params: Promise.resolve({ conversationId: CONV_ID }) },
);

beforeEach(() => {
  conversationStates.clear();
  persistMock.mockClear();
  observedStateAtResume = undefined;
  processChatCompletionMock.mockReset().mockImplementation(async () => {
    const state = conversationStates.get(CONV_ID)!;
    observedStateAtResume = {
      status: state.status,
      debugMode: state.debugMode,
      debugPauseRequested: state.debugPauseRequested,
      debugResumeAfterDetach: state.debugResumeAfterDetach,
      breakpoints: state.breakpoints,
      lastBreakNodeId: state.lastBreakNodeId,
      debugPendingAction: state.debugPendingAction,
    };
    return Response.json({ status: 'completed' });
  });
});

describe('debug continue route', () => {
  it('detaches debugging before resuming the pending action', async () => {
    seedState();

    const response = await continueRun();

    expect(response.status).toBe(200);
    expect(observedStateAtResume).toEqual({
      status: 'running',
      debugMode: false,
      debugPauseRequested: false,
      debugResumeAfterDetach: true,
      breakpoints: [],
      lastBreakNodeId: undefined,
      debugPendingAction: {
        action: 'FINAL_RESPONSE',
        nodeId: 'process-1',
        phase: 'after-model',
      },
    });
    expect(persistMock).toHaveBeenCalledTimes(1);
    expect(processChatCompletionMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'flow-Test Flow' }),
      true,
      false,
      false,
      CONV_ID,
      true,
    );
  });

  it('rejects continue when the conversation is not parked in the debugger', async () => {
    seedState({ status: 'completed' });

    const response = await continueRun();

    expect(response.status).toBe(409);
    expect(processChatCompletionMock).not.toHaveBeenCalled();
    expect(persistMock).not.toHaveBeenCalled();
  });
});
