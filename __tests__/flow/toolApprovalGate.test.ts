/**
 * FLUJO's one tool-approval gate for runs that ask live (#1284): agent SDKs that
 * own their tool loop, and sub-flows. The registry, the event bus and the timer
 * are real; only time is moved forward by hand.
 */
import type OpenAI from 'openai';
import {
  createLiveToolApproval,
  LIVE_APPROVAL_WAIT_MS,
  requireApprovalOf,
  ToolApprovalUnavailableError,
  ToolApprovalWaitExpiredError,
  waitForLiveToolDecision,
} from '@/backend/execution/flow/toolApprovalGate';
import { listPendingToolCalls, resolvePendingApproval } from '@/backend/execution/flow/toolApprovalRegistry';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';

const call = (id: string, name = 'send_email'): OpenAI.ChatCompletionMessageFunctionToolCall => ({
  id, type: 'function', function: { name, arguments: '{"to":"a@b.c"}' },
});

describe('requireApprovalOf', () => {
  it.each([
    [undefined, false],
    [null, false],
    [false, false],
    [true, true],
  ])('reads %p as %p: only true turns approval on', (value, expected) => {
    expect(requireApprovalOf(value)).toBe(expected);
  });
});

describe('waitForLiveToolDecision', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows the call on the card and resolves with the person’s answer', async () => {
    const events: unknown[] = [];
    const unsubscribe = executionEventBus.subscribe('live-approve', (event) => events.push(event));
    const decision = waitForLiveToolDecision('live-approve', call('c1'));

    expect(listPendingToolCalls('live-approve').map((pending) => pending.id)).toEqual(['c1']);
    expect(events).toContainEqual(expect.objectContaining({ type: 'run:awaiting_approval' }));
    expect(resolvePendingApproval('live-approve', 'c1', true)).toBe(true);
    await expect(decision).resolves.toBe(true);
    unsubscribe();
  });

  it('ends a wait nobody answers without running the tool, and takes the card back', async () => {
    jest.useFakeTimers();
    const decision = waitForLiveToolDecision('live-expire', call('c1'), { waitMs: 60_000 });
    const outcome = decision.catch((error: unknown) => error);

    jest.advanceTimersByTime(60_000);

    const error = await outcome;
    expect(error).toBeInstanceOf(ToolApprovalWaitExpiredError);
    expect((error as Error).message).toContain('did not run');
    expect((error as Error).message).not.toContain('a@b.c');
    expect(listPendingToolCalls('live-expire')).toEqual([]);
    // A late click finds nothing to approve.
    expect(resolvePendingApproval('live-expire', 'c1', true)).toBe(false);
  });

  it('uses a bounded default wait', () => {
    expect(LIVE_APPROVAL_WAIT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(LIVE_APPROVAL_WAIT_MS)).toBe(true);
  });

  it('takes the card back when the run stops', async () => {
    const controller = new AbortController();
    const decision = waitForLiveToolDecision('live-abort', call('c1'), { signal: controller.signal });

    controller.abort(new Error('stopped'));

    await expect(decision).rejects.toThrow('stopped');
    expect(listPendingToolCalls('live-abort')).toEqual([]);
  });
});

describe('createLiveToolApproval', () => {
  it('adds no gate when nothing can need approval', () => {
    expect(createLiveToolApproval({ conversationId: 'c', requireApproval: false })).toBeUndefined();
  });

  it('never says yes on its own when there is nobody to ask', async () => {
    const gate = createLiveToolApproval({ conversationId: undefined, requireApproval: true });

    await expect(gate!({ id: 'c1', name: 'send_email', args: {} })).rejects.toBeInstanceOf(ToolApprovalUnavailableError);
  });

  it('fails a headless run that asked to fail rather than wait', async () => {
    const gate = createLiveToolApproval({ conversationId: 'c', requireApproval: true, onApprovalRequired: 'fail' });

    await expect(gate!({ id: 'c1', name: 'send_email', args: {} })).rejects.toThrow('approvalPolicy: fail');
    expect(listPendingToolCalls('c')).toEqual([]);
  });

  it('lets a call through that only a step rule could stop, when the rule does not cover it', async () => {
    const gate = createLiveToolApproval({
      conversationId: 'c',
      requireApproval: false,
      stepRequiresApproval: (name) => name === 'write_it',
    });

    await expect(gate!({ id: 'r1', name: 'read_it', args: {} })).resolves.toBe(true);
    const asked = gate!({ id: 'w1', name: 'write_it', args: {} });
    expect(listPendingToolCalls('c').map((pending) => pending.id)).toEqual(['w1']);
    resolvePendingApproval('c', 'w1', false);
    await expect(asked).resolves.toBe(false);
  });
});
