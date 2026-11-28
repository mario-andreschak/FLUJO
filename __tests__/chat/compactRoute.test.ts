/**
 * POST /v1/chat/conversations/[conversationId]/compact (#1225).
 * The route only records the person's request (with the usual unlock and
 * local-request checks) and previews what will stay word for word.
 */
import type { SharedState } from '@/backend/execution/flow/types';
import { makeLocalRequest } from '../utils/localRequest';

const assertUnlockedMock = jest.fn(async () => undefined as unknown);
jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...a: unknown[]) => assertUnlockedMock(...(a as [])),
}));
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { conversationStates: new Map() },
}));
const loadItemMock = jest.fn();
const saveItemMock = jest.fn(async () => undefined);
jest.mock('@/utils/storage/backend', () => ({
  loadItem: (...a: unknown[]) => loadItemMock(...a),
  saveItem: (...a: unknown[]) => saveItemMock(...(a as [])),
}));
jest.mock('@/backend/execution/flow/conversationContextInfo', () => ({
  buildContextInfo: jest.fn(async () => ({ contextWindow: 128_000 })),
}));

import { POST } from '@/app/v1/chat/conversations/[conversationId]/compact/route';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { withConversationExecutionLock } from '@/backend/execution/flow/conversationExecutionLock';

const conversationStates = FlowExecutor.conversationStates as Map<string, SharedState>;
const ID = 'conv-compact-1';

const messages: SharedState['messages'] = [
  { id: 'u1', role: 'user', content: 'Never publish drafts.', timestamp: 1 },
  { id: 'a1', role: 'assistant', content: 'old answer '.repeat(30_000), timestamp: 2 },
  { id: 'a2', role: 'assistant', content: 'recent answer '.repeat(10_000), timestamp: 3 },
  { id: 'u2', role: 'user', content: 'Continue.', timestamp: 4 },
];

const state = (overrides: Partial<SharedState> = {}): SharedState => ({
  trackingInfo: { executionId: 'e1', startTime: 1, nodeExecutionTracker: [] },
  messages, flowId: 'flow-1', conversationId: ID, status: 'completed', title: 'T', createdAt: 1, updatedAt: 1,
  ...overrides,
} as unknown as SharedState);

const settings = (experimental: Record<string, unknown>) => (key: string, fallback: unknown) =>
  Promise.resolve(key === 'speech_settings' ? { experimental } : key === `conversations/${ID}` ? state() : fallback);

const compact = (conversationId = ID) =>
  POST(makeLocalRequest() as never, { params: Promise.resolve({ conversationId }) });

beforeEach(() => {
  conversationStates.clear();
  assertUnlockedMock.mockReset().mockResolvedValue(undefined);
  loadItemMock.mockReset().mockImplementation(settings({}));
  saveItemMock.mockClear();
});

describe('POST /v1/chat/conversations/:id/compact', () => {
  it('records the request on an idle chat and previews what stays', async () => {
    const response = await compact();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      status: 'requested',
      running: false,
      preview: { summarizedMessages: 1, keptRecentMessages: 2, keptEarlierUserMessages: 1, standingInstructions: 1 },
    });
    expect(saveItemMock).toHaveBeenCalledWith(`conversations/${ID}`, expect.objectContaining({
      compactionRequest: { requestedAt: expect.any(Number) },
      messages,
    }));
  });

  it('updates the cached state that the next run will use', async () => {
    const cached = state();
    conversationStates.set(ID, cached);
    await compact();
    expect(cached.compactionRequest).toEqual({ requestedAt: expect.any(Number) });
  });

  it('hands the request to a running reply without waiting for it to finish', async () => {
    const live = state({ status: 'running' });
    conversationStates.set(ID, live);
    let release!: () => void;
    const running = withConversationExecutionLock(ID, () => new Promise<void>(resolve => { release = resolve; }));
    const response = await compact();
    expect(await response.json()).toMatchObject({ status: 'requested', running: true });
    expect(live.compactionRequest).toEqual({ requestedAt: expect.any(Number) });
    expect(saveItemMock).not.toHaveBeenCalled();
    release();
    await running;
  });

  it('ignores the summary switch an older FLUJO saved as off (#1449)', async () => {
    loadItemMock.mockImplementation(settings({ compactionEnabled: false }));
    const response = await compact();
    expect(await response.json()).toMatchObject({ status: 'requested' });
  });

  it('leaves Persona chats, archives and protected chats to their owners', async () => {
    for (const [overrides, reason] of [
      [{ personaTargetId: 'persona_1' }, 'persona_owned'],
      [{ personaArchived: true }, 'read_only'],
      [{ executionExtensionOwned: true }, 'protected'],
    ] as const) {
      conversationStates.set(ID, state(overrides as Partial<SharedState>));
      const response = await compact();
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ reason });
    }
    expect(saveItemMock).not.toHaveBeenCalled();
  });

  it('keeps the usual unlock check, rejects unsafe ids and unknown chats', async () => {
    assertUnlockedMock.mockResolvedValueOnce(new Response('locked', { status: 423 }));
    expect((await compact()).status).toBe(423);
    expect((await compact('../secrets')).status).toBe(400);
    loadItemMock.mockImplementation(settings({}));
    expect((await compact('missing-chat')).status).toBe(404);
  });
});
