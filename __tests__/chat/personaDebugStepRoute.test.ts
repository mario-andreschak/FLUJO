import type { SharedState } from '@/backend/execution/flow/types';
import { makeLocalRequest } from '../utils/localRequest';

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: jest.fn(async () => undefined),
}));

const conversationStates = new Map<string, SharedState>();
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: {
    get conversationStates() {
      return conversationStates;
    },
  },
}));

const loadConversationStateMock = jest.fn();
jest.mock('@/backend/execution/flow/loadConversationState', () => ({
  loadConversationState: (...args: unknown[]) => loadConversationStateMock(...(args as [])),
}));

const persistConversationStateMock = jest.fn(async () => {});
jest.mock('@/backend/execution/flow/persistConversationState', () => ({
  persistConversationState: (...args: unknown[]) => persistConversationStateMock(...(args as [])),
}));

const processChatCompletionMock = jest.fn();
jest.mock('@/app/v1/chat/completions/chatCompletionService', () => ({
  processChatCompletion: (...args: unknown[]) => processChatCompletionMock(...(args as [])),
}));

const getFlowMock = jest.fn();
jest.mock('@/backend/services/flow/index', () => ({
  flowService: { getFlow: (...args: unknown[]) => getFlowMock(...(args as [])) },
}));

const resumePersonaFlowDispatchMock = jest.fn();
jest.mock('@/backend/services/enduringAgents/personaDispatcher', () => ({
  resumePersonaFlowDispatch: (...args: unknown[]) => resumePersonaFlowDispatchMock(...(args as [])),
}));

import { POST } from '@/app/v1/chat/conversations/[conversationId]/debug/step/route';

const CONVERSATION_ID = 'conv_persona_debug_step';

beforeEach(() => {
  conversationStates.clear();
  loadConversationStateMock.mockReset();
  persistConversationStateMock.mockClear();
  processChatCompletionMock.mockReset();
  getFlowMock.mockReset();
  resumePersonaFlowDispatchMock.mockReset();
});

it('routes an attributed debug step through the exact Persona Activity', async () => {
  const state = {
    trackingInfo: { executionId: 'execution_1', startTime: 1, nodeExecutionTracker: [] },
    messages: [],
    flowId: 'mutable_flow_must_not_load',
    conversationId: CONVERSATION_ID,
    currentNodeId: 'process_1',
    status: 'paused_debug',
    debugMode: true,
    requireApproval: true,
    personaAttribution: {
      personaId: 'persona_test',
      activityId: 'activity_test',
      behaviorRevisionId: 'revision_test',
    },
    createdAt: 1,
    updatedAt: 1,
  } as unknown as SharedState;
  conversationStates.set(CONVERSATION_ID, state);
  loadConversationStateMock.mockResolvedValue(state);
  resumePersonaFlowDispatchMock.mockResolvedValue({
    id: 'dispatch_test',
    personaId: 'persona_test',
    state: 'waiting',
    waitingReason: 'debug',
    outcome: { status: 'paused_debug' },
  });

  const response = await POST(
    makeLocalRequest(),
    { params: Promise.resolve({ conversationId: CONVERSATION_ID }) },
  );

  expect(response.status).toBe(200);
  expect(resumePersonaFlowDispatchMock).toHaveBeenCalledWith(expect.objectContaining({
    personaId: 'persona_test',
    activityId: 'activity_test',
    behaviorRevisionId: 'revision_test',
    conversationId: CONVERSATION_ID,
    reason: 'debug',
    flowInputPatch: expect.objectContaining({
      debug: true,
      continueDebug: false,
      userTurn: false,
    }),
  }));
  expect(processChatCompletionMock).not.toHaveBeenCalled();
  expect(getFlowMock).not.toHaveBeenCalled();
  expect(persistConversationStateMock).not.toHaveBeenCalled();
});
