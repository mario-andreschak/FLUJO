import type { SharedState } from '@/backend/execution/flow/types';
import { makeLocalRequest } from '../utils/localRequest';

const mockAssertUnlocked = jest.fn(async () => undefined);
jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...args: unknown[]) => mockAssertUnlocked(...(args as [])),
}));

jest.mock('@/app/api/_workspace', () => ({
  withWorkspaceRoute: <T,>(handler: T) => handler,
}));

jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { conversationStates: new Map() },
}));

const mockEnqueueSteeringMessage = jest.fn();
jest.mock('@/backend/execution/flow/steeringInbox', () => ({
  enqueueSteeringMessage: (...args: unknown[]) => mockEnqueueSteeringMessage(...args),
}));

const mockSubmitPersonaFlowDispatch = jest.fn();
jest.mock('@/backend/services/enduringAgents/personaDispatcher', () => ({
  submitPersonaFlowDispatch: (...args: unknown[]) => mockSubmitPersonaFlowDispatch(...args),
}));

const mockLoadItem = jest.fn();
jest.mock('@/utils/storage/backend', () => ({
  assertSafeCollectionId: (id: string) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('unsafe id');
  },
  loadItem: (...args: unknown[]) => mockLoadItem(...args),
}));

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { POST } from '@/app/v1/chat/conversations/[conversationId]/inject/route';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';

const CONVERSATION_ID = 'conversation-persona-1';
const conversationStates = FlowExecutor.conversationStates as Map<string, SharedState>;

function state(overrides: Partial<SharedState> = {}): SharedState {
  return {
    conversationId: CONVERSATION_ID,
    status: 'running',
    messages: [],
    ...overrides,
  } as unknown as SharedState;
}

function inject(body: unknown = { id: 'message-1', content: 'Please change course.' }) {
  return POST(
    makeLocalRequest({ body }),
    { params: Promise.resolve({ conversationId: CONVERSATION_ID }) },
  );
}

function submission(decision: string = 'steered', dispatchState: string = 'waiting') {
  return {
    decision,
    dispatch: { id: 'dispatch-inject-1', state: dispatchState },
  };
}

beforeEach(() => {
  conversationStates.clear();
  mockAssertUnlocked.mockClear();
  mockEnqueueSteeringMessage.mockReset();
  mockSubmitPersonaFlowDispatch.mockReset().mockResolvedValue(submission());
  mockLoadItem.mockReset().mockResolvedValue(undefined);
});

describe('Persona conversation injection route', () => {
  it('durably steers an attributed running conversation without double-delivering in memory', async () => {
    conversationStates.set(CONVERSATION_ID, state({
      personaAttribution: {
        personaId: 'persona-trusted',
        activityId: 'activity-1',
        behaviorRevisionId: 'revision-1',
      },
    }));

    const response = await inject({
      id: 'message-stable',
      content: 'Please change course.',
      personaId: 'persona-attacker',
      relatedAction: 'coalesce',
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      status: 'waiting',
      accepted: true,
      conversation_id: CONVERSATION_ID,
      message_id: 'message-stable',
      dispatch_id: 'dispatch-inject-1',
      routing_decision: 'steered',
    });
    expect(mockSubmitPersonaFlowDispatch).toHaveBeenCalledWith({
      personaId: 'persona-trusted',
      idempotencyKey: expect.stringMatching(/^chat-inject:[a-f0-9]{64}$/),
      kind: 'assignment',
      source: { kind: 'chat', sourceId: CONVERSATION_ID },
      relationKey: CONVERSATION_ID,
      relatedAction: 'steer',
      summary: 'Mid-run conversation steering',
      flowInput: {
        messages: [{
          id: 'message-stable',
          role: 'user',
          content: 'Please change course.',
          timestamp: 0,
          injected: true,
        }],
        mode: 'conversation',
        conversationId: CONVERSATION_ID,
        userTurn: true,
        source: 'chat',
      },
    }, { waitForCompletion: false });
    expect(mockEnqueueSteeringMessage).not.toHaveBeenCalled();
    expect(mockLoadItem).not.toHaveBeenCalled();
  });

  it('uses byte-identical durable input for an identical injection retry', async () => {
    conversationStates.set(CONVERSATION_ID, state({
      personaAttribution: { personaId: 'persona-trusted' },
    }));

    await inject({ id: 'message-retry', content: 'Same correction' });
    await inject({ id: 'message-retry', content: 'Same correction' });

    expect(mockSubmitPersonaFlowDispatch).toHaveBeenCalledTimes(2);
    expect(mockSubmitPersonaFlowDispatch.mock.calls[1]).toEqual(
      mockSubmitPersonaFlowDispatch.mock.calls[0],
    );
    expect(mockEnqueueSteeringMessage).not.toHaveBeenCalled();
  });

  it('binds idempotency to both the message identity and content', async () => {
    conversationStates.set(CONVERSATION_ID, state({
      personaAttribution: { personaId: 'persona-trusted' },
    }));

    await inject({ id: 'message-reused', content: 'First correction' });
    await inject({ id: 'message-reused', content: 'Different correction' });

    const firstKey = mockSubmitPersonaFlowDispatch.mock.calls[0][0].idempotencyKey;
    const secondKey = mockSubmitPersonaFlowDispatch.mock.calls[1][0].idempotencyKey;
    expect(firstKey).not.toBe(secondKey);
  });

  it.each(['awaiting_tool_approval', 'paused_debug'] as const)(
    'coalesces trusted persisted Persona input while the conversation is %s',
    async (status) => {
      mockLoadItem.mockResolvedValue(state({
        status,
        personaAttribution: { personaId: 'persona-persisted' },
      }));
      mockSubmitPersonaFlowDispatch.mockResolvedValue(submission('coalesced'));

      const response = await inject({ id: 'message-waiting', content: 'One more detail' });

      expect(response.status).toBe(202);
      expect(mockLoadItem).toHaveBeenCalledWith(
        `conversations/${CONVERSATION_ID}`,
        undefined,
      );
      expect(mockSubmitPersonaFlowDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          personaId: 'persona-persisted',
          relationKey: CONVERSATION_ID,
          relatedAction: 'coalesce',
        }),
        { waitForCompletion: false },
      );
      expect(mockEnqueueSteeringMessage).not.toHaveBeenCalled();
    },
  );

  it('keeps the live Persona-less route response and inbox delivery unchanged', async () => {
    conversationStates.set(CONVERSATION_ID, state());

    const response = await inject({ id: 'legacy-message', content: 'Legacy correction' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'queued',
      conversation_id: CONVERSATION_ID,
      message_id: 'legacy-message',
    });
    expect(mockEnqueueSteeringMessage).toHaveBeenCalledTimes(1);
    expect(mockEnqueueSteeringMessage).toHaveBeenCalledWith(
      CONVERSATION_ID,
      expect.objectContaining({
        id: 'legacy-message',
        role: 'user',
        content: 'Legacy correction',
        injected: true,
      }),
    );
    expect(mockSubmitPersonaFlowDispatch).not.toHaveBeenCalled();
    expect(mockLoadItem).not.toHaveBeenCalled();
  });

  it('does not mistake a persisted Persona-less running snapshot for a live legacy run', async () => {
    mockLoadItem.mockResolvedValue(state());

    const response = await inject();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ reason: 'not_running' });
    expect(mockEnqueueSteeringMessage).not.toHaveBeenCalled();
    expect(mockSubmitPersonaFlowDispatch).not.toHaveBeenCalled();
    expect(conversationStates.size).toBe(0);
  });

  it('retains the not-running boundary for a terminal attributed conversation', async () => {
    mockLoadItem.mockResolvedValue(state({
      status: 'completed',
      personaAttribution: { personaId: 'persona-persisted' },
    }));

    const response = await inject();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      reason: 'not_running',
      status: 'completed',
    });
    expect(mockSubmitPersonaFlowDispatch).not.toHaveBeenCalled();
    expect(mockEnqueueSteeringMessage).not.toHaveBeenCalled();
  });

  it('retains the local-request authorization guard before durable admission', async () => {
    conversationStates.set(CONVERSATION_ID, state({
      personaAttribution: { personaId: 'persona-trusted' },
    }));

    const response = await POST(
      makeLocalRequest({
        body: { id: 'message-remote', content: 'Untrusted input' },
        host: 'example.com',
      }),
      { params: Promise.resolve({ conversationId: CONVERSATION_ID }) },
    );

    expect(response.status).toBe(403);
    expect(mockSubmitPersonaFlowDispatch).not.toHaveBeenCalled();
    expect(mockEnqueueSteeringMessage).not.toHaveBeenCalled();
  });
});
