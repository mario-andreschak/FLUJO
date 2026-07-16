/**
 * Regression tests for issue #109: cancelling a conversation did not stop
 * in-flight subflow runs.
 *
 * Root cause: cancellation is a per-conversation flag (SharedState.isCancelled)
 * checked by runFlow's loop guard, but a subflow child runs with its OWN
 * ephemeral SharedState — `parentRunId` was accepted by runFlow and never read,
 * so the parent's flag never reached the child and it kept calling models to
 * completion after Cancel.
 *
 * The fix records `parentRunId` on the child's SharedState and makes the loop
 * guard walk the ancestor chain through FlowExecutor.conversationStates
 * (isCancelledByAncestry). These tests drive a child runFlow directly with a
 * stubbed engine: a cancelled ancestor must stop the child before (or between)
 * steps.
 */
import type { SharedState } from '@/backend/execution/flow/types';
import { isCancelledByAncestry } from '@/backend/execution/flow/cancellation';

const PARENT_ID = 'conv-parent-109';
const CHILD_FLOW_ID = 'flow-child-109';
const NODE = 'node-child-1';

jest.mock('@/backend/execution/flow/FlowExecutor', () => {
  const conversationStates = new Map();
  return {
    FlowExecutor: {
      conversationStates,
      clearFlowCache: jest.fn(),
      executeStep: jest.fn(),
      resolveHandoff: jest.fn(async () => ({ isSuccessorEdge: false, targetNodeId: null })),
      peekNextNodeId: jest.fn(async () => null),
    },
  };
});

// No durable persistence / disk in tests.
jest.mock('@/backend/execution/flow/persistConversationState', () => ({
  persistConversationState: jest.fn(async () => {}),
}));
jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async () => undefined),
}));
jest.mock('@/backend/execution/flow/conversationLog', () => ({
  reconcileConversationLog: jest.fn(async () => {}),
  recoverMessagesFromLog: jest.fn(async () => {}),
}));
// Pre-run validation always passes; the tests exercise the loop guard, not
// flow validation.
jest.mock('@/backend/execution/flow/validateFlowForRun', () => ({
  validateFlowForRun: jest.fn(async () => ({ isRunnable: true, issues: [] })),
  validateFlowObjectForRun: jest.fn(async () => ({ isRunnable: true, issues: [] })),
}));

import { runFlow } from '@/backend/execution/flow/runFlow';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';

const conversationStates = FlowExecutor.conversationStates as Map<string, SharedState>;
const noopEmit = jest.fn();

function seedParent(overrides: Partial<SharedState> = {}): SharedState {
  const state = {
    trackingInfo: { executionId: 'e-parent', startTime: 1, nodeExecutionTracker: [] },
    messages: [],
    flowId: 'flow-parent',
    conversationId: PARENT_ID,
    status: 'running',
    title: 'Parent',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as unknown as SharedState;
  conversationStates.set(PARENT_ID, state);
  return state;
}

beforeEach(() => {
  conversationStates.clear();
  (FlowExecutor.executeStep as jest.Mock).mockReset();
  noopEmit.mockClear();
});

describe('isCancelledByAncestry (unit)', () => {
  const stateFor = (id: string, parentRunId?: string, isCancelled?: boolean): SharedState =>
    ({ conversationId: id, parentRunId, isCancelled } as unknown as SharedState);

  it('finds a cancelled direct parent and grandparent', () => {
    const states = new Map<string, SharedState>([
      ['top', stateFor('top', undefined, true)],
      ['mid', stateFor('mid', 'top')],
    ]);
    expect(isCancelledByAncestry('mid', states)).toBe(true); // via grandparent walk
    expect(isCancelledByAncestry('top', states)).toBe(true); // the start state itself
  });

  it('returns false when nothing in the chain is cancelled or states are missing', () => {
    const states = new Map<string, SharedState>([
      ['top', stateFor('top')],
      ['mid', stateFor('mid', 'top')],
    ]);
    expect(isCancelledByAncestry('mid', states)).toBe(false);
    expect(isCancelledByAncestry('unknown', states)).toBe(false);
    expect(isCancelledByAncestry(undefined, states)).toBe(false);
  });

  it('terminates on a parentRunId cycle instead of looping forever', () => {
    const states = new Map<string, SharedState>([
      ['a', stateFor('a', 'b')],
      ['b', stateFor('b', 'a')],
    ]);
    expect(isCancelledByAncestry('a', states)).toBe(false);
  });
});

describe('runFlow child cancellation via parentRunId (issue #109)', () => {
  it('an already-cancelled parent stops the child before its first step', async () => {
    seedParent({ isCancelled: true });

    const result = await runFlow({
      flowId: CHILD_FLOW_ID,
      prompt: 'child task',
      mode: 'ephemeral',
      flujo: true,
      depth: 1,
      parentRunId: PARENT_ID,
      emit: noopEmit,
    });

    expect(result.status).toBe('error');
    expect(result.error?.message).toContain('cancelled');
    // The whole point: the child never executes a node (= never calls a model).
    expect(FlowExecutor.executeStep).not.toHaveBeenCalled();
  });

  it('cancelling the parent mid-run stops the child at its next loop iteration', async () => {
    const parent = seedParent();

    // The stubbed node hands off to itself forever; after the FIRST step we
    // cancel the PARENT (as the cancel endpoint would). Without the ancestor
    // walk the child would loop to the iteration cap.
    (FlowExecutor.executeStep as jest.Mock).mockImplementation(async (sharedState: SharedState) => {
      sharedState.currentNodeId = NODE;
      parent.isCancelled = true;
      return { sharedState, action: 'edge-self' };
    });
    (FlowExecutor.resolveHandoff as jest.Mock).mockResolvedValue({
      isSuccessorEdge: true,
      targetNodeId: NODE,
    });

    const result = await runFlow({
      flowId: CHILD_FLOW_ID,
      prompt: 'child task',
      mode: 'ephemeral',
      flujo: true,
      depth: 1,
      parentRunId: PARENT_ID,
      emit: noopEmit,
    });

    expect(result.status).toBe('error');
    expect(result.error?.message).toContain('cancelled');
    expect(FlowExecutor.executeStep).toHaveBeenCalledTimes(1);
    // The child copies the flag onto itself once detected (short-circuits
    // deeper descendants walking through it).
    expect(result.sharedState.isCancelled).toBe(true);
  });

  it('records parentRunId on the child state so descendants can walk the chain', async () => {
    seedParent();
    (FlowExecutor.executeStep as jest.Mock).mockImplementation(async (sharedState: SharedState) => {
      sharedState.lastResponse = 'done';
      return { sharedState, action: 'FINAL_RESPONSE' };
    });

    const result = await runFlow({
      flowId: CHILD_FLOW_ID,
      prompt: 'child task',
      mode: 'ephemeral',
      flujo: true,
      depth: 1,
      parentRunId: PARENT_ID,
      emit: noopEmit,
    });

    expect(result.status).toBe('completed');
    expect(result.sharedState.parentRunId).toBe(PARENT_ID);
  });
});
