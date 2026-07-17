/**
 * Tests for POST /v1/chat/conversations/[conversationId]/cancel.
 *
 * Historically the route only set SharedState.isCancelled — which a LIVE run
 * loop notices, but a PARKED run (awaiting tool approval, paused in the
 * debugger) has no loop: the conversation stayed parked forever and the
 * approval prompt resurrected on the next detail fetch, making the Stop
 * button a no-op exactly when "tool calls are still happening".
 *
 * The route now additionally:
 *  - rejects live in-request approvals (agentic adapters blocked in canUseTool)
 *    so the run unblocks and winds itself down via the flag, and
 *  - finalizes parked states inline (status 'error' + cancelled message) and
 *    broadcasts run:done so sidebars/live views flip immediately.
 */
import type { NextRequest } from 'next/server';
import type { SharedState } from '@/backend/execution/flow/types';
import type OpenAI from 'openai';

const assertUnlockedMock = jest.fn(async () => undefined);
jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...a: unknown[]) => assertUnlockedMock(...(a as [])),
}));

jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { conversationStates: new Map() },
}));

const persistMock = jest.fn(async () => {});
jest.mock('@/backend/execution/flow/persistConversationState', () => ({
  persistConversationState: (...a: unknown[]) => persistMock(...(a as [])),
}));

jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async () => undefined),
  // issue #126: persist/load choke points now validate the conversation id.
  assertSafeCollectionId: (id: string) => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      throw new Error(`Unsafe collection item id: ${JSON.stringify(id)}`);
    }
  },
}));

const emitMock = jest.fn();
jest.mock('@/backend/execution/flow/engine/ExecutionEventBus', () => ({
  executionEventBus: { emit: (...a: unknown[]) => emitMock(...(a as [])) },
}));

import { POST } from '@/app/v1/chat/conversations/[conversationId]/cancel/route';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import {
  registerPendingApproval,
  listPendingToolCalls,
} from '@/backend/execution/flow/toolApprovalRegistry';

const conversationStates = FlowExecutor.conversationStates as Map<string, SharedState>;
const CONV_ID = 'conv-cancel-route-1';

const seedState = (overrides: Partial<SharedState> = {}): SharedState => {
  const state = {
    trackingInfo: { executionId: 'e1', startTime: 1, nodeExecutionTracker: [] },
    messages: [],
    flowId: 'flow-1',
    conversationId: CONV_ID,
    status: 'running',
    title: 'T',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as unknown as SharedState;
  conversationStates.set(CONV_ID, state);
  return state;
};

const toolCall = (id: string): OpenAI.ChatCompletionMessageToolCall => ({
  id,
  type: 'function',
  function: { name: 'some_tool', arguments: '{}' },
});

const cancel = (conversationId = CONV_ID) =>
  POST({} as NextRequest, { params: Promise.resolve({ conversationId }) });

beforeEach(() => {
  conversationStates.clear();
  persistMock.mockClear();
  emitMock.mockClear();
});

describe('cancel route', () => {
  it('flags a live running conversation and leaves finalization to the run loop', async () => {
    const state = seedState({ status: 'running' });

    const res = await cancel();

    expect(res.status).toBe(200);
    expect(state.isCancelled).toBe(true);
    expect(state.status).toBe('running'); // the loop transitions + emits run:done itself
    expect(emitMock).not.toHaveBeenCalled();
    expect(persistMock).toHaveBeenCalledTimes(1);
  });

  it('finalizes a parked awaiting_tool_approval conversation and broadcasts run:done', async () => {
    const state = seedState({
      status: 'awaiting_tool_approval',
      pendingToolCalls: [toolCall('tc-1')],
    } as Partial<SharedState>);

    const res = await cancel();

    expect(res.status).toBe(200);
    expect(state.isCancelled).toBe(true);
    expect(state.status).toBe('error');
    expect(state.pendingToolCalls).toBeUndefined(); // the approval prompt must not resurrect
    expect((state.lastResponse as { error?: string })?.error).toContain('cancelled');
    expect(emitMock).toHaveBeenCalledWith(CONV_ID, { type: 'run:done', status: 'error' });
    expect(persistMock).toHaveBeenCalledTimes(1);
  });

  it('finalizes a parked paused_debug conversation', async () => {
    const state = seedState({ status: 'paused_debug' });

    await cancel();

    expect(state.status).toBe('error');
    expect(state.isCancelled).toBe(true);
    expect(emitMock).toHaveBeenCalledWith(CONV_ID, { type: 'run:done', status: 'error' });
  });

  it('rejects live in-request approvals instead of finalizing (the live run winds down itself)', async () => {
    const state = seedState({ status: 'awaiting_tool_approval' });
    const resolveMock = jest.fn();
    registerPendingApproval(CONV_ID, toolCall('tc-live-1'), resolveMock);

    const res = await cancel();

    expect(res.status).toBe(200);
    expect(resolveMock).toHaveBeenCalledWith(false); // canUseTool unblocked with a rejection
    expect(listPendingToolCalls(CONV_ID)).toHaveLength(0);
    expect(state.isCancelled).toBe(true);
    // The blocked request is still alive and owns the terminal transition.
    expect(state.status).toBe('awaiting_tool_approval');
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('treats an unknown conversation as already cancelled', async () => {
    const res = await cancel('conv-does-not-exist');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});
