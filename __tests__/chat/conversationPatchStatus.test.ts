/**
 * Regression test for the "Conversation completed badge on a fresh
 * conversation" bug.
 *
 * Root cause: the PATCH /v1/chat/conversations/:id handler built its response
 * summary with `status: updatedState.status || 'completed'`. A newly created
 * conversation has status undefined (it has never run), so the moment the user
 * selected a flow the PATCH response reported 'completed', the frontend list
 * adopted it, and the chat view showed a "Conversation completed" banner for a
 * conversation that never executed anything.
 *
 * The fix passes the stored status through unchanged.
 */
import type { SharedState } from '@/backend/execution/flow/types';
import { makeLocalRequest } from '../utils/localRequest';

// The route module imports the flow engine and services at top level; none of
// them are exercised by PATCH, so stub them to keep the test hermetic.
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { conversationStates: new Map() },
}));
jest.mock('@/backend/services/flow', () => ({ flowService: {} }));
jest.mock('@/backend/services/model', () => ({ modelService: {} }));
jest.mock('@/backend/execution/flow/conversationLog', () => ({
  readConversationLog: jest.fn(),
  projectMessages: jest.fn(() => []),
  flushConversationLog: jest.fn(),
  deleteConversationLog: jest.fn(),
}));

// In-memory storage backing the route's loadItem/saveItem.
const stored: Record<string, SharedState> = {};
jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async (key: string) => stored[key]),
  saveItem: jest.fn(async (key: string, value: SharedState) => {
    stored[key] = value;
  }),
}));

import { PATCH } from '@/app/v1/chat/conversations/[conversationId]/route';

function seedConversation(id: string, status: SharedState['status']) {
  stored[`conversations/${id}`] = {
    conversationId: id,
    title: 'Test',
    flowId: 'flow-1',
    trackingInfo: { executionId: 'e1', startTime: 1, nodeExecutionTracker: [] },
    messages: [],
    status,
    createdAt: 1,
    updatedAt: 1,
  } as SharedState;
}

function patchRequest(body: unknown) {
  return makeLocalRequest({ body });
}

async function patchFlow(conversationId: string) {
  const res = await PATCH(patchRequest({ flowId: 'flow-2' }), {
    params: Promise.resolve({ conversationId }),
  });
  expect(res.status).toBe(200);
  return res.json();
}

describe('PATCH /v1/chat/conversations/:id status pass-through', () => {
  beforeEach(() => {
    for (const key of Object.keys(stored)) delete stored[key];
  });

  it('does not report a never-run conversation as completed when its flow changes', async () => {
    seedConversation('conv-fresh', undefined);
    const summary = await patchFlow('conv-fresh');
    expect(summary.flowId).toBe('flow-2');
    expect(summary.status).toBeUndefined();
  });

  it('preserves a real terminal status', async () => {
    seedConversation('conv-done', 'completed');
    expect((await patchFlow('conv-done')).status).toBe('completed');

    seedConversation('conv-err', 'error');
    expect((await patchFlow('conv-err')).status).toBe('error');
  });
});
