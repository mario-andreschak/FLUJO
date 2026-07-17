/**
 * Tests for applyApprovalDecision (issue #115) — the shared tool-approval
 * decision helper extracted from the chat /respond route and reused by the
 * headless approval inbox (POST /api/approvals/:id).
 *
 * ModelHandler.processToolCalls is stubbed so no real tool runs. The helper's
 * own logic — execute (approve) or reject one pending tool call, append the
 * resulting message(s), drain the batch, and flip back to 'running' when done —
 * runs for real.
 */
import type { SharedState } from '@/backend/execution/flow/types';

const processToolCallsMock = jest.fn();
jest.mock('@/backend/execution/flow/handlers/ModelHandler', () => ({
  ModelHandler: { processToolCalls: (...a: unknown[]) => processToolCallsMock(...(a as [])) },
}));

import { applyApprovalDecision } from '@/backend/execution/flow/resumeAfterApproval';

const makeState = (pending: Array<{ id: string; name: string }>): SharedState =>
  ({
    conversationId: 'conv-1',
    flowId: 'flow-1',
    status: 'awaiting_tool_approval',
    messages: [],
    title: 't',
    createdAt: 1,
    updatedAt: 1,
    pendingToolCalls: pending.map(p => ({
      id: p.id,
      type: 'function',
      function: { name: p.name, arguments: '{}' },
    })),
  } as unknown as SharedState);

beforeEach(() => {
  processToolCallsMock.mockReset();
  processToolCallsMock.mockResolvedValue({
    success: true,
    value: { toolCallMessages: [{ role: 'tool', tool_call_id: 'call_1', content: 'ok' }] },
  });
});

describe('applyApprovalDecision (#115)', () => {
  it('approve drains a single-call batch → ready + running', async () => {
    const state = makeState([{ id: 'call_1', name: 'send_email' }]);
    const res = await applyApprovalDecision(state, 'call_1', 'approve');

    expect(res.outcome).toBe('ready');
    expect(processToolCallsMock).toHaveBeenCalledTimes(1);
    expect(state.status).toBe('running');
    expect(state.pendingToolCalls).toBeUndefined();
    // The tool result was appended (and stamped with an id/timestamp).
    const toolMsg = state.messages.find(m => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect((toolMsg as { id?: string }).id).toBeTruthy();
  });

  it('reject appends a rejection message and never executes the tool', async () => {
    const state = makeState([{ id: 'call_1', name: 'delete_everything' }]);
    const res = await applyApprovalDecision(state, 'call_1', 'reject');

    expect(res.outcome).toBe('ready');
    expect(processToolCallsMock).not.toHaveBeenCalled();
    const toolMsg = state.messages.find(m => m.role === 'tool');
    expect(toolMsg?.content).toMatch(/rejected/i);
    expect(state.status).toBe('running');
  });

  it('returns tool_not_found for an unknown tool call id', async () => {
    const state = makeState([{ id: 'call_1', name: 'send_email' }]);
    const res = await applyApprovalDecision(state, 'nope', 'approve');
    expect(res.outcome).toBe('tool_not_found');
    // State untouched.
    expect(state.status).toBe('awaiting_tool_approval');
    expect(state.pendingToolCalls).toHaveLength(1);
  });

  it('stays awaiting when only one of several pending calls is resolved', async () => {
    const state = makeState([
      { id: 'call_1', name: 'send_email' },
      { id: 'call_2', name: 'post_message' },
    ]);
    const res = await applyApprovalDecision(state, 'call_1', 'approve');

    expect(res.outcome).toBe('awaiting');
    expect(state.status).toBe('awaiting_tool_approval');
    expect(state.pendingToolCalls?.map(tc => tc.id)).toEqual(['call_2']);
  });
});
