import OpenAI from 'openai';
import {
  registerPendingApproval,
  resolvePendingApproval,
  listPendingToolCalls,
  clearPendingApprovals,
} from '@/backend/execution/flow/toolApprovalRegistry';

const mkCall = (id: string): OpenAI.ChatCompletionMessageToolCall => ({
  id,
  type: 'function',
  function: { name: 'do_thing', arguments: '{}' },
});

describe('toolApprovalRegistry', () => {
  it('resolves a registered approval with the decision and clears it', async () => {
    const decision = new Promise<boolean>(resolve =>
      registerPendingApproval('conv-A', mkCall('call-1'), resolve)
    );
    expect(listPendingToolCalls('conv-A').map(c => c.id)).toEqual(['call-1']);

    expect(resolvePendingApproval('conv-A', 'call-1', true)).toBe(true);
    await expect(decision).resolves.toBe(true);
    expect(listPendingToolCalls('conv-A')).toEqual([]);
  });

  it('returns false when resolving an unknown approval', () => {
    expect(resolvePendingApproval('conv-missing', 'nope', true)).toBe(false);
  });

  it('tracks multiple pending calls and resolves them independently', async () => {
    const p1 = new Promise<boolean>(resolve => registerPendingApproval('conv-B', mkCall('a'), resolve));
    const p2 = new Promise<boolean>(resolve => registerPendingApproval('conv-B', mkCall('b'), resolve));
    expect(listPendingToolCalls('conv-B').length).toBe(2);

    resolvePendingApproval('conv-B', 'a', false);
    await expect(p1).resolves.toBe(false);
    expect(listPendingToolCalls('conv-B').map(c => c.id)).toEqual(['b']);

    resolvePendingApproval('conv-B', 'b', true);
    await expect(p2).resolves.toBe(true);
    expect(listPendingToolCalls('conv-B')).toEqual([]);
  });

  it('clearPendingApprovals rejects every pending call for the conversation', async () => {
    const decision = new Promise<boolean>(resolve =>
      registerPendingApproval('conv-C', mkCall('x'), resolve)
    );
    clearPendingApprovals('conv-C');
    await expect(decision).resolves.toBe(false);
    expect(listPendingToolCalls('conv-C')).toEqual([]);
  });
});
