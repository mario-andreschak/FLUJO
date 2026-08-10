import type { SharedState } from '@/backend/execution/flow/types';
import { NextRequest } from 'next/server';
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

const appendRawForStateMock = jest.fn(async () => {});
jest.mock('@/backend/execution/flow/conversationLog', () => ({
  appendRawForState: (...args: unknown[]) => appendRawForStateMock(...(args as [])),
}));

const resolvePendingApprovalMock = jest.fn(() => false);
jest.mock('@/backend/execution/flow/toolApprovalRegistry', () => ({
  resolvePendingApproval: (...args: unknown[]) => resolvePendingApprovalMock(...(args as [])),
  listPendingToolCalls: jest.fn(() => []),
}));
const cancelToolCallMock = jest.fn(() => false);
jest.mock('@/backend/execution/flow/toolCancelRegistry', () => ({
  cancelToolCall: (...args: unknown[]) => cancelToolCallMock(...(args as [])),
}));
const resolveElicitationMock = jest.fn(() => false);
jest.mock('@/backend/services/mcp/elicitationRegistry', () => ({
  resolveElicitation: (...args: unknown[]) => resolveElicitationMock(...(args as [])),
}));
const resolvePendingQuestionMock = jest.fn(() => false);
const declinePendingQuestionMock = jest.fn(() => false);
jest.mock('@/backend/services/questionRegistry', () => ({
  resolvePendingQuestion: (...args: unknown[]) => resolvePendingQuestionMock(...(args as [])),
  declinePendingQuestion: (...args: unknown[]) => declinePendingQuestionMock(...(args as [])),
}));

const applyApprovalDecisionMock = jest.fn();
jest.mock('@/backend/execution/flow/resumeAfterApproval', () => ({
  applyApprovalDecision: (...args: unknown[]) => applyApprovalDecisionMock(...(args as [])),
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

import { POST } from '@/app/v1/chat/conversations/[conversationId]/respond/route';
import { withConversationExecutionLock } from '@/backend/execution/flow/conversationExecutionLock';

const CONVERSATION_ID = 'conv_persona_approval';
const originalExposureMode = process.env.FLUJO_EXPOSURE_MODE;

function approvalState(): SharedState {
  return {
    trackingInfo: { executionId: 'execution_1', startTime: 1, nodeExecutionTracker: [] },
    messages: [],
    flowId: 'flow_mutable_must_not_load',
    conversationId: CONVERSATION_ID,
    currentNodeId: 'process_1',
    status: 'awaiting_tool_approval',
    pendingToolCalls: [{
      id: 'tool_1',
      type: 'function',
      function: { name: 'send_report', arguments: '{}' },
    }],
    personaAttribution: {
      personaId: 'persona_test',
      activityId: 'activity_test',
      behaviorRevisionId: 'revision_test',
    },
    createdAt: 1,
    updatedAt: 1,
  } as unknown as SharedState;
}

beforeEach(() => {
  process.env.FLUJO_EXPOSURE_MODE = 'localhost';
  conversationStates.clear();
  loadConversationStateMock.mockReset();
  persistConversationStateMock.mockClear();
  appendRawForStateMock.mockClear();
  applyApprovalDecisionMock.mockReset();
  processChatCompletionMock.mockReset();
  getFlowMock.mockReset();
  resumePersonaFlowDispatchMock.mockReset();
  resolvePendingApprovalMock.mockClear();
  cancelToolCallMock.mockClear();
  resolveElicitationMock.mockClear();
  resolvePendingQuestionMock.mockClear();
  declinePendingQuestionMock.mockClear();
});

afterAll(() => {
  if (originalExposureMode === undefined) delete process.env.FLUJO_EXPOSURE_MODE;
  else process.env.FLUJO_EXPOSURE_MODE = originalExposureMode;
});

describe('Persona-attributed conversation lifecycle routes', () => {
  it('applies a chat approval only after dispatcher reacquisition', async () => {
    const state = approvalState();
    conversationStates.set(CONVERSATION_ID, state);
    loadConversationStateMock.mockImplementation(async () => state);
    applyApprovalDecisionMock.mockImplementation(async () => {
      state.status = 'running';
      state.pendingToolCalls = undefined;
      return { outcome: 'ready', appendedMessages: [] };
    });
    resumePersonaFlowDispatchMock.mockImplementation(async (input: any) => {
      await input.prepare({
        dispatch: { id: 'dispatch_test' },
        executionAuthority: { signal: new AbortController().signal, assertCurrent: jest.fn() },
        installExecutionAuthority(target: SharedState) {
          Object.defineProperty(target, 'executionAuthority', {
            value: { signal: new AbortController().signal, assertCurrent: jest.fn() },
            enumerable: false,
            configurable: true,
          });
        },
      });
      state.status = 'completed';
      return {
        id: 'dispatch_test',
        personaId: 'persona_test',
        state: 'completed',
        outcome: { status: 'completed' },
      };
    });

    const response = await POST(
      makeLocalRequest({ body: { action: 'approve', toolCallId: 'tool_1' } }),
      { params: Promise.resolve({ conversationId: CONVERSATION_ID }) },
    );

    expect(response.status).toBe(200);
    expect(resumePersonaFlowDispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      personaId: 'persona_test',
      activityId: 'activity_test',
      behaviorRevisionId: 'revision_test',
      conversationId: CONVERSATION_ID,
      reason: 'approval',
    }));
    expect(applyApprovalDecisionMock).toHaveBeenCalledTimes(1);
    expect(persistConversationStateMock).toHaveBeenCalledTimes(1);
    expect(processChatCompletionMock).not.toHaveBeenCalled();
    expect(getFlowMock).not.toHaveBeenCalled();
    expect(JSON.stringify(state)).not.toContain('executionAuthority');
  });

  it('fails closed on incomplete persisted Persona attribution', async () => {
    const state = approvalState();
    state.personaAttribution = { personaId: 'persona_test' };
    loadConversationStateMock.mockResolvedValue(state);

    const response = await POST(
      makeLocalRequest({ body: { action: 'approve', toolCallId: 'tool_1' } }),
      { params: Promise.resolve({ conversationId: CONVERSATION_ID }) },
    );

    expect(response.status).toBe(409);
    expect(resumePersonaFlowDispatchMock).not.toHaveBeenCalled();
    expect(processChatCompletionMock).not.toHaveBeenCalled();
    expect(getFlowMock).not.toHaveBeenCalled();
  });

  it('re-reads after a paused anonymization and never falls into legacy approval execution', async () => {
    const state = approvalState();
    loadConversationStateMock.mockImplementation(async () => state);

    let release!: () => void;
    let entered!: () => void;
    let interleaved!: () => void;
    const enteredLock = new Promise<void>((resolve) => { entered = resolve; });
    const interleavingReached = new Promise<void>((resolve) => { interleaved = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const anonymization = withConversationExecutionLock(CONVERSATION_ID, async () => {
      entered();
      await gate;
    });
    await enteredLock;

    resolvePendingApprovalMock.mockImplementationOnce(() => {
      delete state.personaAttribution;
      state.personaArchived = true;
      interleaved();
      return false;
    });
    const responsePromise = POST(
      makeLocalRequest({ body: { action: 'approve', toolCallId: 'tool_1' } }),
      { params: Promise.resolve({ conversationId: CONVERSATION_ID }) },
    );
    await interleavingReached;
    release();
    await anonymization;

    const response = await responsePromise;
    expect(response.status).toBe(409);
    expect(applyApprovalDecisionMock).not.toHaveBeenCalled();
    expect(resumePersonaFlowDispatchMock).not.toHaveBeenCalled();
    expect(processChatCompletionMock).not.toHaveBeenCalled();
    expect(getFlowMock).not.toHaveBeenCalled();
  });

  it('fails a paused Persona elicitation when its execution authority expires', async () => {
    const state = approvalState();
    let checked!: () => void;
    let expire!: () => void;
    const authorityChecked = new Promise<void>((resolve) => { checked = resolve; });
    const expiry = new Promise<void>((resolve) => { expire = resolve; });
    Object.defineProperty(state, 'executionAuthority', {
      value: {
        signal: new AbortController().signal,
        assertCurrent: jest.fn(async () => undefined),
        async commitWhileCurrent(_task: () => Promise<unknown>) {
          checked();
          await expiry;
          throw new Error('Persona lease expired');
        },
      },
      enumerable: false,
      configurable: true,
    });
    loadConversationStateMock.mockResolvedValue(state);
    const responsePromise = POST(
      makeLocalRequest({
        body: {
          action: 'elicitation-submit',
          elicitationId: 'elicitation_1',
          content: { confirmed: true },
        },
      }),
      { params: Promise.resolve({ conversationId: CONVERSATION_ID }) },
    );
    await authorityChecked;
    expire();

    const response = await responsePromise;
    expect(response.status).toBe(409);
    expect(resolveElicitationMock).not.toHaveBeenCalled();
    expect(applyApprovalDecisionMock).not.toHaveBeenCalled();
    expect(resumePersonaFlowDispatchMock).not.toHaveBeenCalled();
  });

  it.each([
    { action: 'cancelToolCall', toolCallId: 'tool_1' },
    { action: 'elicitation-cancel', elicitationId: 'elicitation_1' },
    { action: 'question-decline', questionId: 'question_1' },
    { action: 'approve', toolCallId: 'tool_1' },
  ])('checks Persona trust before resolving live control input %#', async (body) => {
    process.env.FLUJO_EXPOSURE_MODE = 'public';
    loadConversationStateMock.mockResolvedValue(approvalState());
    const request = new NextRequest(
      `https://flujo.example.com/v1/chat/conversations/${CONVERSATION_ID}/respond`,
      {
        method: 'POST',
        headers: { host: 'flujo.example.com', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );

    const response = await POST(request, {
      params: Promise.resolve({ conversationId: CONVERSATION_ID }),
    });

    expect(response.status).toBe(403);
    expect(cancelToolCallMock).not.toHaveBeenCalled();
    expect(resolveElicitationMock).not.toHaveBeenCalled();
    expect(resolvePendingQuestionMock).not.toHaveBeenCalled();
    expect(declinePendingQuestionMock).not.toHaveBeenCalled();
    expect(resolvePendingApprovalMock).not.toHaveBeenCalled();
    expect(resumePersonaFlowDispatchMock).not.toHaveBeenCalled();
  });
});
