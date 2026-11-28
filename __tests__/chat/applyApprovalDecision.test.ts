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
  const withAssistantTurn = (state: SharedState, ids: string[]) => {
    state.messages.push({ role: 'assistant', content: null, id: 'a1', timestamp: 1,
      tool_calls: ids.map((id) => ({ id, type: 'function', function: { name: 'send_email', arguments: '{}' } })) } as never);
    return state;
  };

  it('saves the decision before the tool starts, with the call no longer waiting', async () => {
    const state = makeState([{ id: 'call_1', name: 'send_email' }, { id: 'call_2', name: 'post_message' }]);
    processToolCallsMock.mockImplementation(async () => {
      // What a restart at this moment would read back.
      const saved = persistConversationStateMock.mock.calls.at(-1)?.[1] as SharedState | undefined;
      expect(saved?.recovery?.currentCheckpoint).toMatchObject({
        phase: 'tool:before',
        tools: [expect.objectContaining({ toolCallId: 'call_1' })],
      });
      expect(pendingIds(saved!)).toEqual(['call_2']);
      expect(saved?.status).toBe('awaiting_tool_approval');
      return { success: true, value: { toolCallMessages: [{ role: 'tool', tool_call_id: 'call_1', content: 'ok' }] } };
    });

    await applyApprovalDecision(state, 'call_1', 'approve');

    expect(processToolCallsMock).toHaveBeenCalledTimes(1);
    expect(persistConversationStateMock.mock.invocationCallOrder[0]).toBeLessThan(processToolCallsMock.mock.invocationCallOrder[0]);
    expect(state.recovery?.currentCheckpoint?.phase).toBe('tool:after');
    expect(pendingIds(state)).toEqual(['call_2']);
  });

  it('saves the last call of a batch as a going run, so a crash ends as an interrupted run', async () => {
    const state = makeState([{ id: 'call_1', name: 'send_email' }]);
    processToolCallsMock.mockImplementation(async () => {
      const saved = persistConversationStateMock.mock.calls.at(-1)?.[1] as SharedState;
      expect(saved.status).toBe('running');
      expect(saved.pendingToolCalls).toBeUndefined();
      return { success: true, value: { toolCallMessages: [{ role: 'tool', tool_call_id: 'call_1', content: 'ok' }] } };
    });

    expect((await applyApprovalDecision(state, 'call_1', 'approve')).outcome).toBe('ready');
  });

  it('never offers a call again when the app stopped while it ran, also to a version that ignores checkpoints', async () => {
    const state = withAssistantTurn(makeState([{ id: 'call_1', name: 'send_email' }, { id: 'call_2', name: 'post_message' }]), ['call_1', 'call_2']);
    await applyApprovalDecision(state, 'call_1', 'approve');
    const afterCrash = structuredClone(persistConversationStateMock.mock.calls[0][1]) as SharedState;
    // A FLUJO rolled back to a version from before #1284 reads the same file but not the checkpoint.
    const rolledBack = structuredClone(afterCrash);
    delete rolledBack.recovery;
    processToolCallsMock.mockClear();

    for (const saved of [afterCrash, rolledBack]) {
      expect(pendingIds(saved)).toEqual(['call_2']);
      expect((await applyApprovalDecision(saved, 'call_1', 'approve')).outcome).toBe('tool_not_found');
    }
    expect(processToolCallsMock).not.toHaveBeenCalled();
  });

  it('settles an attempt that failed half way as interrupted and ends the run on its error line', async () => {
    const state = makeState([{ id: 'call_1', name: 'send_email' }]);
    processToolCallsMock.mockRejectedValueOnce(new Error('connection reset'));
    await expect(applyApprovalDecision(state, 'call_1', 'approve')).rejects.toThrow('connection reset');
    const saved = structuredClone(persistConversationStateMock.mock.calls.at(-1)![1]) as SharedState;
    processToolCallsMock.mockClear();

    for (const current of [state, saved]) {
      expect(current.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: INTERRUPTED_APPROVED_TOOL_RESULT });
      expect(current.status).toBe('error');
      expect(current.lastResponse).toMatchObject({ success: false, error: INTERRUPTED_APPROVED_TOOL_RESULT });
      expect(current.recovery).toMatchObject({ manualActionRequired: true });
    }
    expect((await applyApprovalDecision(saved, 'call_1', 'approve')).outcome).toBe('tool_not_found');
    expect(processToolCallsMock).not.toHaveBeenCalled();
  });

  it('puts the call back on the card when the decision cannot be saved, and runs nothing', async () => {
    const state = makeState([{ id: 'call_1', name: 'send_email' }]);
    persistConversationStateMock.mockRejectedValueOnce(new Error('disk full'));

    await expect(applyApprovalDecision(state, 'call_1', 'approve')).rejects.toThrow('disk full');

    expect(processToolCallsMock).not.toHaveBeenCalled();
    expect(pendingIds(state)).toEqual(['call_1']);
    expect(state.status).toBe('awaiting_tool_approval');
  });

  describe('states saved before the claim kept the call waiting (upgrade)', () => {
    const legacyCrash = () => {
      const state = makeState([{ id: 'call_1', name: 'send_email' }]);
      state.recovery = { currentCheckpoint: { phase: 'tool:before', tools: [{ toolCallId: 'call_1', name: 'send_email', readOnly: false, idempotent: false }] } } as never;
      return state;
    };

    it('settles such a call without running it again', async () => {
      const state = legacyCrash();

      const res = await applyApprovalDecision(state, 'call_1', 'approve');

      expect(processToolCallsMock).not.toHaveBeenCalled();
      expect(res.outcome).toBe('ready');
      expect(state.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: INTERRUPTED_APPROVED_TOOL_RESULT });
      expect(state.recovery).toMatchObject({ manualActionRequired: true });
    });

    it('can still reject such a call', async () => {
      const state = legacyCrash();

      await applyApprovalDecision(state, 'call_1', 'reject');

      expect(processToolCallsMock).not.toHaveBeenCalled();
      expect(state.messages.at(-1)?.content).toBe('tool denied');
    });
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
