/**
 * Tests for renaming a conversation via PATCH /v1/chat/conversations/:id
 * (issue #134, item 2).
 *
 * The PATCH allow-list gained a `title` field. A rename is treated as a
 * settings-only change: it validates/trims/caps the title, persists it, and —
 * crucially — does NOT bump `updatedAt`, so editing the title never re-sorts the
 * conversation to the top of the sidebar.
 */
import type { SharedState } from '@/backend/execution/flow/types';

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

function seedConversation(id: string, title: string, updatedAt: number) {
  stored[`conversations/${id}`] = {
    conversationId: id,
    title,
    flowId: 'flow-1',
    trackingInfo: { executionId: 'e1', startTime: 1, nodeExecutionTracker: [] },
    messages: [],
    status: 'completed',
    createdAt: 1,
    updatedAt,
  } as SharedState;
}

function patchRequest(body: unknown) {
  return { json: async () => body } as any;
}

async function patch(conversationId: string, body: unknown) {
  return PATCH(patchRequest(body), {
    params: Promise.resolve({ conversationId }),
  });
}

describe('PATCH /v1/chat/conversations/:id title (rename)', () => {
  beforeEach(() => {
    for (const key of Object.keys(stored)) delete stored[key];
  });

  it('renames the conversation and returns the new title', async () => {
    seedConversation('conv-1', 'Old title', 1000);
    const res = await patch('conv-1', { title: 'A much better title' });
    expect(res.status).toBe(200);
    const summary = await res.json();
    expect(summary.title).toBe('A much better title');
    expect(stored['conversations/conv-1'].title).toBe('A much better title');
  });

  it('does NOT bump updatedAt on a rename (no re-sort)', async () => {
    seedConversation('conv-2', 'Old', 1000);
    const res = await patch('conv-2', { title: 'New name' });
    const summary = await res.json();
    expect(summary.updatedAt).toBe(1000);
    expect(stored['conversations/conv-2'].updatedAt).toBe(1000);
  });

  it('trims surrounding whitespace and caps length at 200 chars', async () => {
    seedConversation('conv-3', 'Old', 1000);
    const res = await patch('conv-3', { title: `  ${'x'.repeat(250)}  ` });
    const summary = await res.json();
    expect(summary.title).toBe('x'.repeat(200));
  });

  it('rejects a non-string title', async () => {
    seedConversation('conv-4', 'Old', 1000);
    const res = await patch('conv-4', { title: 123 });
    expect(res.status).toBe(400);
    expect(stored['conversations/conv-4'].title).toBe('Old');
  });

  it('rejects an empty / whitespace-only title', async () => {
    seedConversation('conv-5', 'Old', 1000);
    const res = await patch('conv-5', { title: '   ' });
    expect(res.status).toBe(400);
    expect(stored['conversations/conv-5'].title).toBe('Old');
  });

  it('still bumps updatedAt when a non-settings field (flowId) also changes', async () => {
    seedConversation('conv-6', 'Old', 1000);
    const res = await patch('conv-6', { title: 'Renamed', flowId: 'flow-2' });
    const summary = await res.json();
    expect(summary.title).toBe('Renamed');
    expect(summary.flowId).toBe('flow-2');
    expect(summary.updatedAt).not.toBe(1000);
  });
});
