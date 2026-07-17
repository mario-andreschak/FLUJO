/**
 * Tests for the headless approval handling inside the runFlow keystone
 * (issue #115).
 *
 * When a run reaches a tool that needs approval (requireApproval) but has no
 * interactive approver, `onApprovalRequired` decides what happens:
 *   - 'fail'  — end the run with a structured approval_required error WITHOUT
 *               executing the tool (no silent auto-approve, no hang).
 *   - 'pause' — park the run as awaiting_tool_approval with the pending tool
 *               calls (resumable later via the approval inbox).
 *
 * The engine (FlowExecutor) is stubbed with a start->process machine whose
 * process node asks for a tool call, so no network/model runs. ModelHandler is
 * stubbed so we can assert the tool is NEVER executed on the fail/pause paths.
 */
import type { SharedState } from '@/backend/execution/flow/types';

const START = '077cfac0-start';
const PROCESS = 'ef2a3c01-process';
const FLOW_ID = 'flow-1';

const persistedStates: SharedState[] = [];
const processToolCallsMock = jest.fn(async (): Promise<any> => ({ success: true, value: { toolCallMessages: [] } }));

jest.mock('@/backend/execution/flow/FlowExecutor', () => {
  const S = '077cfac0-start';
  const P = 'ef2a3c01-process';
  const EDGE = `${S}->${P}`;
  const TOOL_CALL = 'TOOL_CALL';
  const conversationStates = new Map();
  return {
    FlowExecutor: {
      conversationStates,
      clearFlowCache: jest.fn(),
      executeStep: jest.fn(async (sharedState: any) => {
        const nodeId = sharedState.currentNodeId ?? S;
        sharedState.currentNodeId = nodeId;
        if (nodeId === S) {
          return { sharedState, action: EDGE };
        }
        // Process node asks for a tool call.
        sharedState.messages.push({
          role: 'assistant',
          content: '',
          id: 'assistant-1',
          timestamp: 1,
          processNodeId: P,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'send_email', arguments: '{}' } },
          ],
        });
        return { sharedState, action: TOOL_CALL };
      }),
      resolveHandoff: jest.fn(async (sharedState: any, action: string) => {
        if (sharedState.currentNodeId === S && action === EDGE) {
          return { isSuccessorEdge: true, targetNodeId: P };
        }
        return { isSuccessorEdge: false, targetNodeId: null };
      }),
      peekNextNodeId: jest.fn(async (sharedState: any) => sharedState.currentNodeId ?? S),
    },
  };
});

jest.mock('@/backend/execution/flow/handlers/ModelHandler', () => ({
  ModelHandler: { processToolCalls: (...a: unknown[]) => processToolCallsMock(...(a as [])) },
}));

jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async () => undefined),
  saveItem: jest.fn(async (_key: string, value: any) => {
    persistedStates.push(JSON.parse(JSON.stringify(value)));
  }),
}));

jest.mock('@/backend/services/flow/index', () => ({
  flowService: {
    loadFlows: jest.fn(async () => [{ id: 'flow-1', name: 'TestFlow' }]),
    getFlow: jest.fn(async () => ({ id: 'flow-1', name: 'TestFlow' })),
  },
}));

jest.mock('@/backend/execution/flow/validateFlowForRun', () => ({
  validateFlowForRun: jest.fn(async () => ({ issues: [], errorCount: 0, warningCount: 0, isRunnable: true })),
}));

import { runFlow } from '@/backend/execution/flow/runFlow';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';

const conversationStates = FlowExecutor.conversationStates as Map<string, SharedState>;

beforeEach(() => {
  persistedStates.length = 0;
  conversationStates.clear();
  processToolCallsMock.mockClear();
  (FlowExecutor.executeStep as jest.Mock).mockClear();
});

describe('runFlow headless approval (#115)', () => {
  it("onApprovalRequired 'fail' ends with a structured approval_required error and runs NO tool", async () => {
    const result = await runFlow({
      flowId: FLOW_ID,
      prompt: 'send the report',
      mode: 'ephemeral',
      requireApproval: true,
      onApprovalRequired: 'fail',
    });

    expect(result.status).toBe('error');
    expect(result.error?.details?.type).toBe('approval_required');
    expect(result.error?.details?.name).toBe('send_email');
    expect(result.error?.message).toMatch(/send_email/);
    // Fail-fast: the tool was never executed.
    expect(processToolCallsMock).not.toHaveBeenCalled();
  });

  it("onApprovalRequired 'pause' parks the run as awaiting_tool_approval with pending calls", async () => {
    const result = await runFlow({
      flowId: FLOW_ID,
      prompt: 'send the report',
      mode: 'conversation',
      requireApproval: true,
      onApprovalRequired: 'pause',
    });

    expect(result.status).toBe('awaiting_tool_approval');
    expect(result.pendingToolCalls?.[0]?.id).toBe('call_1');
    // Paused, not executed.
    expect(processToolCallsMock).not.toHaveBeenCalled();
    // The paused state was persisted (so it can be resumed later).
    const last = persistedStates[persistedStates.length - 1];
    expect(last.status).toBe('awaiting_tool_approval');
    expect(last.onApprovalRequired).toBe('pause');
  });

  it("onApprovalRequired defaults to 'auto' when requireApproval is false (tool runs)", async () => {
    // With no gate, the internal tool path runs the tool. The stub returns no
    // follow-up messages, so the loop then re-asks and pauses at max iterations;
    // the only thing we assert here is that the tool WAS executed (no fail/park).
    processToolCallsMock.mockResolvedValueOnce({ success: false, value: { toolCallMessages: [] }, error: { message: 'stop' } });
    const result = await runFlow({
      flowId: FLOW_ID,
      prompt: 'send the report',
      mode: 'ephemeral',
      requireApproval: false,
    });

    expect(processToolCallsMock).toHaveBeenCalledTimes(1);
    // The auto path attempted the tool (here it errors out via the stub).
    expect(result.status).toBe('error');
  });
});
