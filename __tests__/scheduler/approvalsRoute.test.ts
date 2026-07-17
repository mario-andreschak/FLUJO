/**
 * Tests for the approval inbox API (issue #115):
 *   - GET  /api/approvals            — list paused headless runs (metadata only)
 *   - POST /api/approvals/:id        — resolve one paused run (approve/deny)
 *
 * The durable inbox store, conversation state, resume (processChatCompletion)
 * and run-history reconciliation are mocked at their module boundaries; the
 * route logic — pruning stale entries, never leaking args, applying the
 * decision, resuming, reconciling, and idempotency — runs for real.
 */
const assertUnlockedMock = jest.fn(async () => null);
jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...a: unknown[]) => assertUnlockedMock(...(a as [])),
}));

const listPendingApprovalsMock = jest.fn();
const getPendingApprovalMock = jest.fn();
const putPendingApprovalMock = jest.fn(async () => {});
const removePendingApprovalMock = jest.fn(async () => {});
jest.mock('@/backend/services/scheduler/pendingApprovals', () => ({
  listPendingApprovals: (...a: unknown[]) => listPendingApprovalsMock(...(a as [])),
  getPendingApproval: (...a: unknown[]) => getPendingApprovalMock(...(a as [])),
  putPendingApproval: (...a: unknown[]) => putPendingApprovalMock(...(a as [])),
  removePendingApproval: (...a: unknown[]) => removePendingApprovalMock(...(a as [])),
}));

const loadConversationStateMock = jest.fn();
jest.mock('@/backend/execution/flow/loadConversationState', () => ({
  loadConversationState: (...a: unknown[]) => loadConversationStateMock(...(a as [])),
}));

const conversationStates = new Map<string, unknown>();
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: {
    get conversationStates() {
      return conversationStates;
    },
  },
}));

jest.mock('@/backend/execution/flow/persistConversationState', () => ({
  persistConversationState: jest.fn(async () => {}),
}));
jest.mock('@/backend/execution/flow/conversationLog', () => ({
  appendRawForState: jest.fn(async () => {}),
}));

const processToolCallsMock = jest.fn(async () => ({
  success: true,
  value: { toolCallMessages: [{ role: 'tool', tool_call_id: 'call_1', content: 'ok' }] },
}));
jest.mock('@/backend/execution/flow/handlers/ModelHandler', () => ({
  ModelHandler: { processToolCalls: (...a: unknown[]) => processToolCallsMock(...(a as [])) },
}));

const processChatCompletionMock = jest.fn(async () => new Response('{}'));
jest.mock('@/app/v1/chat/completions/chatCompletionService', () => ({
  processChatCompletion: (...a: unknown[]) => processChatCompletionMock(...(a as [])),
}));

const getFlowMock = jest.fn(async (id: string) => ({ id, name: 'TestFlow' }));
jest.mock('@/backend/services/flow/index', () => ({
  flowService: { getFlow: (...a: unknown[]) => getFlowMock(...(a as [string])) },
}));

const updateRunRecordMock = jest.fn(async () => null);
jest.mock('@/backend/services/scheduler/runHistory', () => ({
  updateRunRecord: (...a: unknown[]) => updateRunRecordMock(...(a as [])),
}));

import { GET } from '@/app/api/approvals/route';
import { POST } from '@/app/api/approvals/[id]/route';

const entry = () => ({
  approvalId: 'conv-1',
  conversationId: 'conv-1',
  plannedExecutionId: 'pe-1',
  flowId: 'flow-1',
  flowName: 'TestFlow',
  runId: 'run-1',
  triggerSummary: 'Schedule',
  pendingToolCalls: [{ id: 'call_1', name: 'send_email' }],
  createdAt: '2026-01-01T00:00:00.000Z',
});

const awaitingState = () => ({
  conversationId: 'conv-1',
  flowId: 'flow-1',
  status: 'awaiting_tool_approval',
  requireApproval: true,
  messages: [{ role: 'user', content: 'SECRET PROMPT' }],
  pendingToolCalls: [{ id: 'call_1', type: 'function', function: { name: 'send_email', arguments: '{"to":"a@b.c"}' } }],
});

const makePost = (id: string, body: unknown) =>
  POST({ json: async () => body } as never, { params: Promise.resolve({ id }) });

beforeEach(() => {
  assertUnlockedMock.mockReset().mockResolvedValue(null);
  listPendingApprovalsMock.mockReset();
  getPendingApprovalMock.mockReset();
  putPendingApprovalMock.mockReset().mockResolvedValue(undefined);
  removePendingApprovalMock.mockReset().mockResolvedValue(undefined);
  loadConversationStateMock.mockReset();
  processToolCallsMock.mockClear();
  processChatCompletionMock.mockClear();
  updateRunRecordMock.mockReset().mockResolvedValue(null);
  getFlowMock.mockReset().mockImplementation(async (id: string) => ({ id, name: 'TestFlow' }));
  conversationStates.clear();
});

describe('GET /api/approvals (#115)', () => {
  it('returns an empty list when the inbox is empty', async () => {
    listPendingApprovalsMock.mockResolvedValue([]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ approvals: [] });
  });

  it('lists a paused run with metadata only (no tool arguments / prompt)', async () => {
    listPendingApprovalsMock.mockResolvedValue([entry()]);
    loadConversationStateMock.mockResolvedValue(awaitingState());

    const res = await GET();
    const body = await res.json();

    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0]).toMatchObject({
      approvalId: 'conv-1',
      plannedExecutionId: 'pe-1',
      flowId: 'flow-1',
      pendingToolCalls: [{ id: 'call_1', name: 'send_email' }],
    });
    // No prompt text or tool arguments leaked into this surface.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('SECRET PROMPT');
    expect(serialized).not.toContain('a@b.c');
    expect(serialized).not.toContain('arguments');
  });

  it('prunes a stale entry whose run is no longer awaiting approval', async () => {
    listPendingApprovalsMock.mockResolvedValue([entry()]);
    loadConversationStateMock.mockResolvedValue({ status: 'completed' });

    const res = await GET();
    const body = await res.json();

    expect(body.approvals).toHaveLength(0);
    expect(removePendingApprovalMock).toHaveBeenCalledWith('conv-1');
  });

  it('returns 423 when the store is locked', async () => {
    const locked = new Response(JSON.stringify({ error: 'encryption_locked' }), { status: 423 });
    assertUnlockedMock.mockResolvedValueOnce(locked as never);
    const res = await GET();
    expect(res.status).toBe(423);
  });
});

describe('POST /api/approvals/:id (#115)', () => {
  it('rejects an invalid action with 400', async () => {
    const res = await makePost('conv-1', { action: 'maybe' });
    expect(res.status).toBe(400);
  });

  it('404s an unknown approval id', async () => {
    getPendingApprovalMock.mockResolvedValue(null);
    const res = await makePost('nope', { action: 'approve' });
    expect(res.status).toBe(404);
  });

  it('is idempotent: a no-longer-awaiting run 404s and clears the stale entry', async () => {
    getPendingApprovalMock.mockResolvedValue(entry());
    loadConversationStateMock.mockResolvedValue({ status: 'completed' });

    const res = await makePost('conv-1', { action: 'approve' });
    expect(res.status).toBe(404);
    expect(removePendingApprovalMock).toHaveBeenCalledWith('conv-1');
  });

  it('approve resumes the run and reconciles the run-history record on completion', async () => {
    getPendingApprovalMock.mockResolvedValue(entry());
    loadConversationStateMock
      .mockResolvedValueOnce(awaitingState()) // initial load
      .mockResolvedValueOnce({
        status: 'completed',
        messages: [{ role: 'assistant', content: 'Report sent.' }],
        usage: { totalTokens: 3 },
      }); // after resume

    const res = await makePost('conv-1', { action: 'approve' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ status: 'completed', approvalId: 'conv-1' });
    // The tool was executed and the run was resumed.
    expect(processToolCallsMock).toHaveBeenCalledTimes(1);
    expect(processChatCompletionMock).toHaveBeenCalledTimes(1);
    // The earlier needs_approval record was transitioned to completed.
    expect(updateRunRecordMock).toHaveBeenCalledWith(
      'pe-1',
      'run-1',
      expect.objectContaining({ status: 'completed', pendingApproval: undefined })
    );
    // Inbox entry cleared.
    expect(removePendingApprovalMock).toHaveBeenCalledWith('conv-1');
  });

  it('deny rejects the tool without executing it', async () => {
    getPendingApprovalMock.mockResolvedValue(entry());
    loadConversationStateMock
      .mockResolvedValueOnce(awaitingState())
      .mockResolvedValueOnce({
        status: 'completed',
        messages: [{ role: 'assistant', content: 'Skipped.' }],
      });

    const res = await makePost('conv-1', { action: 'deny' });
    expect(res.status).toBe(200);
    expect(processToolCallsMock).not.toHaveBeenCalled();
    expect(updateRunRecordMock).toHaveBeenCalled();
  });
});
