/**
 * Pre-run checks (runPreflight.ts) block a run before any step only when a
 * run starts: a person's new turn or a brand-new conversation. Internal
 * resumes (approval decision, debugger step/continue) carry on a run that
 * already passed them and must not be blocked half way.
 */
import type { SharedState } from '@/backend/execution/flow/types';
import type { FlowRunInput } from '@/backend/execution/flow/runFlowContract';

jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { conversationStates: new Map() },
}));

jest.mock('@/backend/execution/flow/validateFlowForRun', () => ({
  validateFlowForRun: jest.fn(),
  validateFlowObjectForRun: jest.fn(),
}));

jest.mock('@/backend/services/flow/index', () => ({
  flowService: { getFlow: jest.fn(async () => ({ id: 'flow-preflight', name: 'Preflight', nodes: [], edges: [] })) },
}));

import { runPreflightChecks } from '@/backend/execution/flow/runPreflight';
import { validateFlowForRun } from '@/backend/execution/flow/validateFlowForRun';

const notRunnable = {
  issues: [{ severity: 'error', code: 'model_missing', message: 'Node "agent" references a deleted model' }],
  errorCount: 1,
  warningCount: 0,
  isRunnable: false,
};

function state(): SharedState {
  return {
    trackingInfo: { executionId: 'preflight-run', startTime: 1, nodeExecutionTracker: [] },
    messages: [],
    flowId: 'flow-preflight',
    conversationId: 'conv-preflight',
    title: 'Preflight',
    currentNodeId: 'process-node',
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
  } as SharedState;
}

const input = { flowId: 'flow-preflight', mode: 'conversation', source: 'chat' } as FlowRunInput;

beforeEach(() => {
  (validateFlowForRun as jest.Mock).mockReset();
  (validateFlowForRun as jest.Mock).mockResolvedValue(notRunnable);
});

describe('pre-run checks', () => {
  it.each([
    ['a new turn on a saved conversation', true, 'storage'],
    ['a brand-new conversation', false, 'new'],
  ] as const)('block %s whose flow cannot run', async (_label, userTurn, stateSource) => {
    const sharedState = state();

    const failed = await runPreflightChecks({ sharedState, input, effectiveConvId: 'conv-preflight', userTurn, stateSource });

    expect(failed).toBe(true);
    expect(validateFlowForRun).toHaveBeenCalledWith('flow-preflight');
    expect(sharedState.lastResponse).toMatchObject({
      success: false,
      errorDetails: { code: 'flow_invalid', status: 400 },
    });
  });

  it.each(['memory', 'storage'] as const)(
    'let an internal resume of a %s conversation carry on without validating again',
    async (stateSource) => {
      const sharedState = state();

      const failed = await runPreflightChecks({ sharedState, input, effectiveConvId: 'conv-preflight', userTurn: false, stateSource });

      expect(failed).toBe(false);
      expect(validateFlowForRun).not.toHaveBeenCalled();
      expect(sharedState.lastResponse).toBeUndefined();
    },
  );
});
