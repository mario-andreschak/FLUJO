/** Ordinary execution must not retain debugger copies of live state (#520). */
import cloneDeep from 'lodash/cloneDeep';
import { FEATURES } from '@/config/features';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import type { FlowEngine, ResolvedNode } from '@/backend/execution/flow/engine/FlowEngine';
import { ERROR_ACTION, type SharedState } from '@/backend/execution/flow/types';
import type { EmitFn } from '@/shared/types/execution/events';
import {
  captureBefore, captureAfterAndEmit, type SnapshotContext,
} from '@/backend/services/snapshot/snapshotHook';

jest.mock('lodash/cloneDeep', () => ({
  __esModule: true,
  default: jest.fn(jest.requireActual<typeof import('lodash/cloneDeep')>('lodash/cloneDeep')),
}));
jest.mock('@/backend/services/snapshot/snapshotHook', () => ({
  captureBefore: jest.fn(),
  captureAfterAndEmit: jest.fn(),
}));

const executor = FlowExecutor as unknown as { engine: FlowEngine };
const originalEngine = executor.engine;
const originalTrackerFlag = FEATURES.ENABLE_EXECUTION_TRACKER;
const node: ResolvedNode = { id: 'process', type: 'process', name: 'Process', handle: {} };
const snapshot: SnapshotContext = {
  roots: ['fixture-root'], start: new Map([['fixture-root', 'before-sha']]),
  rootServers: new Map([['fixture-root', ['fixture-server']]]),
};

function state(debugMode: boolean): SharedState {
  return {
    conversationId: 'trace-allocation', flowId: 'fixture-flow', status: 'running', debugMode,
    title: 'Trace allocation', createdAt: 1, updatedAt: 1,
    trackingInfo: { executionId: 'trace-run', startTime: 1, nodeExecutionTracker: [] },
    messages: [{ id: 'user', role: 'user', content: 'original message', timestamp: 1 }],
    variables: { phase: 'before' },
    subflowInvocations: {
      folded: {
        version: 1, id: 'folded', parentConversationId: 'trace-allocation', parentNodeId: 'subflow',
        parentRunId: 'trace-allocation',
        status: 'folded', depth: 1, showSteps: false, concurrencyLimit: 1, joinSeparator: '\n',
        errorStrategy: 'collect-all', sharedInput: { prompt: 'original child input' }, lanes: [],
        createdAt: 1, updatedAt: 1, foldedAt: 1,
      },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  FEATURES.ENABLE_EXECUTION_TRACKER = false;
  jest.mocked(captureBefore).mockResolvedValue(snapshot);
  jest.mocked(captureAfterAndEmit).mockResolvedValue(undefined);
});
afterEach(() => {
  executor.engine = originalEngine;
  FEATURES.ENABLE_EXECUTION_TRACKER = originalTrackerFlag;
  FlowExecutor.conversationStates.delete('trace-allocation');
});

// Both opt-ins must preserve the debugger, including its exception path.
const modes = [
  { name: 'disabled', debug: false, tracker: false },
  { name: 'conversation debug', debug: true, tracker: false },
  { name: 'global tracker', debug: false, tracker: true },
];

it.each(modes)('allocates state snapshots only when tracing is $name', async ({ debug, tracker }) => {
  FEATURES.ENABLE_EXECUTION_TRACKER = tracker;
  const shared = state(debug);
  const emit: EmitFn = jest.fn();
  const tracing = debug || tracker;
  executor.engine = {
    resolveNode: async () => node,
    previewModelInput: async () => null,
    resolveHandoff: async () => ({ isSuccessorEdge: false, targetNodeId: null }),
    clearCache: () => undefined,
    runNode: async () => {
      // The before-state copy would stay alive throughout this awaited node.
      expect(cloneDeep).toHaveBeenCalledTimes(tracing ? 1 : 0);
      shared.variables!.phase = 'after';
      return { action: 'NEXT', prepResult: undefined, execResult: undefined };
    },
  };

  const result = await FlowExecutor.executeStep(shared, emit);
  expect(result).toEqual({ sharedState: shared, action: 'NEXT' });
  // Filesystem snapshots are independent of debugger snapshots and still run.
  expect(captureBefore).toHaveBeenCalledWith(node, shared, emit);
  expect(captureAfterAndEmit).toHaveBeenCalledWith(node, snapshot, shared, emit);
  expect(cloneDeep).toHaveBeenCalledTimes(tracing ? 2 : 0);
  if (!tracing) {
    expect(shared.executionTrace).toBeUndefined();
    return;
  }
  expect(shared.executionTrace).toHaveLength(1);
  const step = shared.executionTrace![0];
  expect(step).toMatchObject({ nodeId: 'process', actionTaken: 'NEXT',
    stateBefore: { variables: { phase: 'before' }, messageCount: 1 },
    stateAfter: { variables: { phase: 'after' }, messageCount: 1 } });
  expect(step.stateBefore.variables).not.toBe(shared.variables);
  expect(step.stateAfter.variables).not.toBe(shared.variables);
  expect(step.stateBefore.subflowInvocations).toEqual(shared.subflowInvocations);
  expect(step.stateBefore.subflowInvocations).not.toBe(shared.subflowInvocations);
  expect(step.stateBefore.messages).toBeUndefined();
  expect(step.stateAfter.messages).toBeUndefined();
});

it.each(modes)('preserves error details and requested error traces when tracing is $name', async ({ debug, tracker }) => {
  FEATURES.ENABLE_EXECUTION_TRACKER = tracker;
  const shared = state(debug);
  const emit: EmitFn = jest.fn();
  const tracing = debug || tracker;
  const error = Object.assign(new Error('provider rejected the request'), { details: { status: 400, code: 'bad_request' } });
  executor.engine = {
    resolveNode: async () => node,
    previewModelInput: async () => null,
    resolveHandoff: async () => ({ isSuccessorEdge: false, targetNodeId: null }),
    clearCache: () => undefined,
    runNode: async () => {
      expect(cloneDeep).toHaveBeenCalledTimes(tracing ? 1 : 0);
      shared.variables!.phase = 'failed';
      throw error;
    },
  };

  const result = await FlowExecutor.executeStep(shared, emit);
  expect(result.action).toBe(ERROR_ACTION);
  expect(shared.lastResponse).toMatchObject({ success: false, error: error.message,
    errorDetails: { message: error.message, status: 400, code: 'bad_request' } });
  expect(captureBefore).toHaveBeenCalledWith(node, shared, emit);
  // Node failure already skipped the after-filesystem hook before this change.
  expect(captureAfterAndEmit).not.toHaveBeenCalled();
  expect(cloneDeep).toHaveBeenCalledTimes(tracing ? 2 : 0);
  if (!tracing) {
    expect(shared.executionTrace).toBeUndefined();
    return;
  }
  expect(shared.executionTrace).toHaveLength(1);
  const step = shared.executionTrace![0];
  expect(step).toMatchObject({ nodeId: 'process', actionTaken: ERROR_ACTION,
    stateBefore: { variables: { phase: 'before' } },
    stateAfter: { variables: { phase: 'failed' }, lastResponse: shared.lastResponse } });
  expect(step.stateBefore.variables).not.toBe(shared.variables);
  expect(step.stateAfter.variables).not.toBe(shared.variables);
  expect(step.stateBefore.messages).toBeUndefined();
  expect(step.stateAfter.messages).toBeUndefined();
});
