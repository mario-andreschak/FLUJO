/**
 * Tests for mid-flight model-call cancellation.
 *
 * Historically Stop only took effect BETWEEN steps/tool calls: the run loop's
 * guard and processToolCalls' shouldAbort both poll the isCancelled flag, but a
 * single in-flight provider call ran to completion regardless — the largest
 * un-interruptible window (a long generation, or the Claude subscription
 * adapter's whole agentic loop).
 *
 * ModelHandler now wires a cancellation watch around every completion: it polls
 * the conversation's isCancelled flag (own or an ancestor's, via
 * isCancelledByAncestry — subflow children) and fires an AbortController whose
 * signal every adapter forwards to its SDK. An abort is reported as a clean
 * 'cancelled' model error, not a provider failure.
 */
import type { SharedState } from '@/backend/execution/flow/types';

jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { conversationStates: new Map() },
}));

const getModelMock = jest.fn();
const resolveKeyMock = jest.fn();
jest.mock('@/backend/services/model', () => ({
  modelService: {
    getModel: (...a: unknown[]) => getModelMock(...(a as [])),
    resolveAndDecryptApiKey: (...a: unknown[]) => resolveKeyMock(...(a as [])),
  },
}));

// The fake adapter's behavior is set per-test: 'complete' resolves promptly,
// 'hang-until-abort' never resolves until the passed signal aborts.
let adapterBehavior: 'complete' | 'hang-until-abort' = 'complete';
const createCompletionMock = jest.fn(
  (input: { signal?: AbortSignal }) =>
    new Promise((resolve, reject) => {
      if (adapterBehavior === 'hang-until-abort') {
        if (input.signal?.aborted) return reject(new Error('Request was aborted.'));
        input.signal?.addEventListener('abort', () => reject(new Error('Request was aborted.')), { once: true });
        return; // hang
      }
      resolve({
        completion: {
          id: 'cmpl-1',
          object: 'chat.completion',
          created: 1,
          model: 'test-model',
          choices: [
            { index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content: 'ok', refusal: null } },
          ],
        },
      });
    })
);
jest.mock('@/backend/services/model/adapters', () => ({
  getCompletionAdapter: () => ({ createCompletion: createCompletionMock }),
}));

import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';

const conversationStates = FlowExecutor.conversationStates as Map<string, SharedState>;

const seedState = (conversationId: string, overrides: Partial<SharedState> = {}): SharedState => {
  const state = {
    trackingInfo: { executionId: 'e1', startTime: 1, nodeExecutionTracker: [] },
    messages: [],
    flowId: 'flow-1',
    conversationId,
    status: 'running',
    title: 'T',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as unknown as SharedState;
  conversationStates.set(conversationId, state);
  return state;
};

const callModel = (conversationId?: string) =>
  ModelHandler.callModel({
    modelId: 'model-1',
    prompt: 'hi',
    messages: [{ role: 'user', content: 'hi', id: 'u1', timestamp: 1 }],
    iteration: 1,
    maxIterations: 1,
    nodeName: 'Node',
    nodeId: 'node-1',
    conversationId,
  } as Parameters<typeof ModelHandler.callModel>[0]);

beforeEach(() => {
  conversationStates.clear();
  createCompletionMock.mockClear();
  adapterBehavior = 'complete';
  getModelMock.mockReset().mockResolvedValue({ id: 'model-1', name: 'test-model', provider: 'openai' });
  resolveKeyMock.mockReset().mockResolvedValue('sk-test');
});

describe('mid-flight completion cancellation', () => {
  it('completes normally when the conversation is never cancelled', async () => {
    seedState('conv-ok');
    const result = await callModel('conv-ok');
    expect(result.success).toBe(true);
    if (result.success) expect(result.value.content).toBe('ok');
    // The adapter received a live (non-aborted) signal.
    const input = createCompletionMock.mock.calls[0][0];
    expect(input.signal).toBeInstanceOf(AbortSignal);
    expect(input.signal!.aborted).toBe(false);
  });

  it('returns a clean cancelled error without calling the provider when already cancelled', async () => {
    seedState('conv-pre', { isCancelled: true });
    const result = await callModel('conv-pre');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('cancelled');
      expect(result.error.message).toBe('Execution cancelled by user.');
    }
    expect(createCompletionMock).not.toHaveBeenCalled();
  });

  it('aborts an in-flight call when the flag flips mid-call (the Stop button path)', async () => {
    const state = seedState('conv-mid');
    adapterBehavior = 'hang-until-abort';

    const pending = callModel('conv-mid');
    // Flip the flag as the cancel route would, while the provider call hangs.
    setTimeout(() => { state.isCancelled = true; }, 100);

    const result = await pending;
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('cancelled');
      expect(result.error.message).toBe('Execution cancelled by user.');
    }
    // The adapter WAS called and its signal aborted (that's what killed the hang).
    const input = createCompletionMock.mock.calls[0][0];
    expect(input.signal!.aborted).toBe(true);
  }, 10000);

  it("aborts a subflow child's call when an ANCESTOR is cancelled (issue 109 ancestry)", async () => {
    seedState('conv-parent', { isCancelled: true });
    seedState('conv-child', { parentRunId: 'conv-parent', ephemeral: true } as Partial<SharedState>);

    const result = await callModel('conv-child');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('cancelled');
    expect(createCompletionMock).not.toHaveBeenCalled();
  });

  it('passes no signal-driven abort for calls without a conversation (no watch, normal completion)', async () => {
    const result = await callModel(undefined);
    expect(result.success).toBe(true);
  });
});
