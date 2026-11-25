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
// Saving is observed, not performed: a copy of each saved state is what a restart would read.
const persistConversationStateMock = jest.fn(async (_key: string, _state: unknown) => {});
jest.mock('@/backend/execution/flow/persistConversationState', () => ({
  persistConversationState: (key: string, state: unknown) => persistConversationStateMock(key, structuredClone(state)),
}));
jest.mock('@/backend/execution/flow/conversationLog', () => ({
  appendRawForState: jest.fn(async () => {}),
  flushConversationLog: jest.fn(async () => {}),
}));

import { applyApprovalDecision, INTERRUPTED_APPROVED_TOOL_RESULT } from '@/backend/execution/flow/resumeAfterApproval';

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
  persistConversationStateMock.mockClear();
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
    expect(toolMsg?.content).toBe('tool denied');
    expect(state.status).toBe('running');
  });

  it('reject returns only the fixed denial result', async () => {
    const state = makeState([{ id: 'call_1', name: 'delete_everything' }]);
    await applyApprovalDecision(state, 'call_1', 'reject');
    const toolMsg = state.messages.find(m => m.role === 'tool');
    expect(toolMsg?.content).toBe('tool denied');
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

describe('an approved call runs at most once (#1284)', () => {
  const pendingIds = (state: SharedState) => (state.pendingToolCalls ?? []).map((call) => call.id);

  it('saves the decision before the tool starts', async () => {
    const state = makeState([{ id: 'call_1', name: 'send_email' }]);
    processToolCallsMock.mockImplementation(async () => {
      // What a restart at this moment would read back.
      const saved = persistConversationStateMock.mock.calls.at(-1)?.[1] as SharedState | undefined;
      expect(saved?.recovery?.currentCheckpoint).toMatchObject({
        phase: 'tool:before',
        tools: [expect.objectContaining({ toolCallId: 'call_1' })],
      });
      expect(pendingIds(saved!)).toEqual(['call_1']);
      return { success: true, value: { toolCallMessages: [{ role: 'tool', tool_call_id: 'call_1', content: 'ok' }] } };
    });

    await applyApprovalDecision(state, 'call_1', 'approve');

    expect(processToolCallsMock).toHaveBeenCalledTimes(1);
    expect(persistConversationStateMock.mock.invocationCallOrder[0]).toBeLessThan(processToolCallsMock.mock.invocationCallOrder[0]);
    expect(state.recovery?.currentCheckpoint?.phase).toBe('tool:after');
  });

  it('does not run a call again when the app stopped while it ran', async () => {
    // The saved state after a crash: the call was claimed, its result never saved.
    const state = makeState([{ id: 'call_1', name: 'send_email' }]);
    await applyApprovalDecision(state, 'call_1', 'approve');
    const afterCrash = structuredClone(persistConversationStateMock.mock.calls[0][1]) as SharedState;
    processToolCallsMock.mockClear();

    const res = await applyApprovalDecision(afterCrash, 'call_1', 'approve');

    expect(processToolCallsMock).not.toHaveBeenCalled();
    expect(res.outcome).toBe('ready');
    expect(afterCrash.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: INTERRUPTED_APPROVED_TOOL_RESULT });
    expect(afterCrash.recovery).toMatchObject({ manualActionRequired: true });
  });

  it('does not run a call again after an attempt that failed half way', async () => {
    const state = makeState([{ id: 'call_1', name: 'send_email' }]);
    processToolCallsMock.mockRejectedValueOnce(new Error('connection reset'));
    await expect(applyApprovalDecision(state, 'call_1', 'approve')).rejects.toThrow('connection reset');
    const retried = structuredClone(persistConversationStateMock.mock.calls.at(-1)![1]) as SharedState;
    processToolCallsMock.mockClear();

    await applyApprovalDecision(retried, 'call_1', 'approve');

    expect(processToolCallsMock).not.toHaveBeenCalled();
    expect(retried.messages.at(-1)?.content).toBe(INTERRUPTED_APPROVED_TOOL_RESULT);
  });

  it('can still reject a call whose earlier approval was cut off', async () => {
    const state = makeState([{ id: 'call_1', name: 'send_email' }]);
    await applyApprovalDecision(state, 'call_1', 'approve');
    const afterCrash = structuredClone(persistConversationStateMock.mock.calls[0][1]) as SharedState;
    processToolCallsMock.mockClear();

    await applyApprovalDecision(afterCrash, 'call_1', 'reject');

    expect(processToolCallsMock).not.toHaveBeenCalled();
    expect(afterCrash.messages.at(-1)?.content).toBe('tool denied');
  });

  it('keeps the run fences for the approved call', async () => {
    const state = makeState([{ id: 'call_1', name: 'send_email' }]);
    const authority = { signal: new AbortController().signal, assertCurrent: jest.fn() };
    // Installed like the Persona dispatcher does: present at run time, never saved.
    Object.defineProperty(state, 'executionAuthority', { value: authority, enumerable: false, configurable: true });
    Object.assign(state, { personaAttribution: { personaId: 'persona_test' } });

    await applyApprovalDecision(state, 'call_1', 'approve');

    expect(processToolCallsMock).toHaveBeenCalledWith(expect.objectContaining({
      executionAuthority: authority,
      personaAttribution: { personaId: 'persona_test' },
    }));
  });
});
