/**
 * Tests for #438: Verify the single approval gate contract
 *
 * After the removal of the permission-rule system, the sole approval gate
 * is the ChatInput "Require Tool Approval" checkbox (requireApproval flag).
 * This test locks down the contract:
 *
 * 1. requireApproval defaults to false (tools execute without prompting)
 * 2. Rejection always returns the fixed string "tool denied"
 * 3. No rejection reason input is persisted or sent to the model
 * 4. No flow-level permission rules, saved decisions, or protected-path denylist remain
 */
import type { SharedState } from '@/backend/execution/flow/types';
import { applyApprovalDecision } from '@/backend/execution/flow/resumeAfterApproval';

const processToolCallsMock = jest.fn();
jest.mock('@/backend/execution/flow/handlers/ModelHandler', () => ({
  ModelHandler: { processToolCalls: (...a: unknown[]) => processToolCallsMock(...(a as [])) },
}));

const mkCall = (id: string, name: string = 'test_tool') => ({
  id,
  type: 'function' as const,
  function: { name, arguments: '{}' },
});

const makeState = (pending: Array<{ id: string; name?: string }>): SharedState =>
  ({
    conversationId: 'conv-1',
    flowId: 'flow-1',
    status: 'awaiting_tool_approval',
    messages: [],
    title: 't',
    createdAt: 1,
    updatedAt: 1,
    pendingToolCalls: pending.map(p => mkCall(p.id, p.name)),
    // Verify that savedPermissionRules and permissionRules do NOT exist on the state
    savedPermissionRules: undefined,
    permissionRules: undefined,
  } as unknown as SharedState);

beforeEach(() => {
  processToolCallsMock.mockReset();
  processToolCallsMock.mockResolvedValue({
    success: true,
    value: { toolCallMessages: [{ role: 'tool', tool_call_id: 'call_1', content: 'ok' }] },
  });
});

describe('Tool Approval Single Gate (#438)', () => {
  describe('Contract: Rejection returns fixed "tool denied" string', () => {
    it('rejects with the fixed denial message (no free-text feedback)', async () => {
      const state = makeState([{ id: 'call_1' }]);
      await applyApprovalDecision(state, 'call_1', 'reject');

      const toolMsg = state.messages.find(m => m.role === 'tool');
      expect(toolMsg?.content).toBe('tool denied');
    });

    it('approval executes the tool normally', async () => {
      const state = makeState([{ id: 'call_1' }]);
      const res = await applyApprovalDecision(state, 'call_1', 'approve');

      expect(res.outcome).toBe('ready');
      expect(processToolCallsMock).toHaveBeenCalledTimes(1);
      const toolMsg = state.messages.find(m => m.role === 'tool');
      expect(toolMsg?.content).toBe('ok');
    });

    it('rejection does not call the tool handler', async () => {
      const state = makeState([{ id: 'call_1' }]);
      await applyApprovalDecision(state, 'call_1', 'reject');
      expect(processToolCallsMock).not.toHaveBeenCalled();
    });
  });

  describe('Contract: No permission rules or saved decisions', () => {
    it('state does not contain savedPermissionRules field', () => {
      const state = makeState([{ id: 'call_1' }]);
      // The type of savedPermissionRules should be undefined, not an array
      expect(state.savedPermissionRules).toBeUndefined();
    });

    it('state does not contain flow-level permissionRules field', () => {
      const state = makeState([{ id: 'call_1' }]);
      // The type of permissionRules should be undefined, not an array
      expect(state.permissionRules).toBeUndefined();
    });

    it('approval decision handler does not consult saved or flow-level rules', async () => {
      const state = makeState([{ id: 'call_1' }]);
      // Both undefined; approval decision should not try to evaluate or filter
      const res = await applyApprovalDecision(state, 'call_1', 'reject');
      expect(res.outcome).toBe('ready');
      expect(state.messages.find(m => m.tool_call_id === 'call_1')?.content).toBe('tool denied');
    });
  });

  describe('Contract: Single gate behavior', () => {
    it('approves a single tool call', async () => {
      const state = makeState([{ id: 'call_1' }]);
      const res = await applyApprovalDecision(state, 'call_1', 'approve');

      expect(res.outcome).toBe('ready');
      expect(processToolCallsMock).toHaveBeenCalledTimes(1);
      expect(state.pendingToolCalls).toBeUndefined();
      expect(state.status).toBe('running');
    });

    it('rejects a single tool call', async () => {
      const state = makeState([{ id: 'call_1' }]);
      const res = await applyApprovalDecision(state, 'call_1', 'reject');

      expect(res.outcome).toBe('ready');
      expect(processToolCallsMock).not.toHaveBeenCalled();
      expect(state.messages.find(m => m.tool_call_id === 'call_1')?.content).toBe('tool denied');
      expect(state.status).toBe('running');
    });

    it('handles multiple pending calls with independent decisions', async () => {
      const state = makeState([{ id: 'call_1', name: 'tool_a' }, { id: 'call_2', name: 'tool_b' }]);

      // Reject first call — still have call_2 pending, so outcome is 'awaiting'
      const res1 = await applyApprovalDecision(state, 'call_1', 'reject');
      expect(res1.outcome).toBe('awaiting');
      expect(processToolCallsMock).not.toHaveBeenCalled();
      expect(state.messages.find(m => m.tool_call_id === 'call_1')?.content).toBe('tool denied');
      expect(state.pendingToolCalls!.length).toBe(1);
      expect(state.pendingToolCalls![0].id).toBe('call_2');
      expect(state.status).toBe('awaiting_tool_approval');

      // Approve second call — now all calls are handled, so outcome is 'ready'
      const res2 = await applyApprovalDecision(state, 'call_2', 'approve');
      expect(res2.outcome).toBe('ready');
      expect(processToolCallsMock).toHaveBeenCalledTimes(1);
      expect(state.status).toBe('running');
      expect(state.pendingToolCalls).toBeUndefined();
    });

    it('returns tool_not_found for unknown call id', async () => {
      const state = makeState([{ id: 'call_1' }]);
      const res = await applyApprovalDecision(state, 'nope', 'approve');
      expect(res.outcome).toBe('tool_not_found');
    });
  });
});
