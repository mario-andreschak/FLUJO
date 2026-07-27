/**
 * Graceful landing at the agentic-turn cap (issue #253).
 *
 * On the request/response tool loop, `maxTurns` is enforced by runFlow itself
 * (the adapters ignore it). When a Process node exhausts its per-node turn
 * budget, runFlow must NOT keep executing tools and must NOT abort: it should
 * answer the pending tool calls synthetically, force one final text-only
 * summary turn, and finish with status `capped` (a success-like terminal state,
 * distinct from `error`). The summary becomes the run's output so downstream
 * capture/chaining keeps working.
 *
 * FlowExecutor is stubbed with a tiny start->process state machine:
 *   - start                     -> handoff edge to the process node
 *   - process (normal turn)      -> emits an assistant tool_calls message and
 *                                   records a turn budget of 1 (as ProcessNode
 *                                   .post would), so the very first tool turn
 *                                   trips the cap.
 *   - process (forceSummaryTurn) -> emits a plain-text summary (no tools).
 * ModelHandler.processToolCalls is mocked so we can assert it is NEVER called
 * (criterion: no tool runs on the capped turn).
 */
import type { SharedState } from '@/backend/execution/flow/types';

const START = 'start-node';
const PROCESS = 'process-node';
const FLOW_ID = 'flow-graceful-cap';
const SUMMARY_TEXT = 'SUMMARY: created the file; remaining: write tests; next: run the suite.';

const processToolCallsMock = jest.fn(async () => ({
  success: true,
  value: { toolCallMessages: [], processedToolCalls: [] },
}));

jest.mock('@/backend/execution/flow/handlers/ModelHandler', () => ({
  ModelHandler: {
    processToolCalls: (...args: unknown[]) => processToolCallsMock(...(args as [])),
  },
}));

jest.mock('@/backend/execution/flow/FlowExecutor', () => {
  const S = 'start-node';
  const P = 'process-node';
  const EDGE = `${S}->${P}`;
  const TOOL_CALL = 'TOOL_CALL';
  const FINAL = 'FINAL_RESPONSE';
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
        // Process node. On the forced summary turn, produce plain text only.
        if (sharedState.forceSummaryTurn) {
          sharedState.messages.push({
            role: 'assistant',
            content: 'SUMMARY: created the file; remaining: write tests; next: run the suite.',
            id: `summary-${sharedState.messages.length}`,
            timestamp: 1,
            processNodeId: nodeId,
          });
          sharedState.lastResponse = 'SUMMARY: created the file; remaining: write tests; next: run the suite.';
          return { sharedState, action: FINAL };
        }
        // Normal agentic turn: simulate ProcessNode.post recording a resolved
        // turn budget of 1, then emit an assistant message that wants a tool.
        sharedState.turnBudgets = { [nodeId]: 1 };
        sharedState.messages.push({
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'some_tool', arguments: '{}' } },
          ],
          id: `assistant-${sharedState.messages.length}`,
          timestamp: 1,
          processNodeId: nodeId,
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

jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async () => undefined),
  saveItem: jest.fn(async () => {}),
  assertSafeCollectionId: (id: string) => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      throw new Error(`Unsafe collection item id: ${JSON.stringify(id)}`);
    }
  },
}));

const flowGraph = {
  id: FLOW_ID,
  name: 'GracefulCapFlow',
  nodes: [
    { id: START, type: 'start' },
    { id: PROCESS, type: 'process' },
  ],
  edges: [
    { source: START, target: PROCESS, type: 'custom', data: { edgeType: 'standard' } },
  ],
};

const getFlowMock = jest.fn(async () => flowGraph);

jest.mock('@/backend/services/flow/index', () => ({
  flowService: {
    loadFlows: jest.fn(async () => [flowGraph]),
    getFlow: (...args: unknown[]) => getFlowMock(...(args as [])),
  },
}));

jest.mock('@/backend/execution/flow/validateFlowForRun', () => ({
  validateFlowForRun: jest.fn(async () => ({ issues: [], errorCount: 0, warningCount: 0, isRunnable: true })),
}));

import { runFlow } from '@/backend/execution/flow/runFlow';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { GRACEFUL_CAP_TOOL_RESULT } from '@/backend/execution/flow/handlers/gracefulCap';

const conversationStates = FlowExecutor.conversationStates as Map<string, SharedState>;

beforeEach(() => {
  conversationStates.clear();
  (FlowExecutor.executeStep as jest.Mock).mockClear();
  processToolCallsMock.mockClear();
  getFlowMock.mockClear();
  getFlowMock.mockResolvedValue(flowGraph);
});

describe('graceful landing at the turn cap (#253)', () => {
  it('lands with a forced summary turn instead of running more tools', async () => {
    const result = await runFlow({
      flowId: FLOW_ID,
      prompt: 'do the work',
      mode: 'ephemeral',
      source: 'api',
    });

    // Criterion 1 & 4: the run ends `capped` (success-like, not error) with the
    // summary as its output.
    expect(result.status).toBe('capped');
    expect(result.sharedState.capped).toBe(true);
    expect(result.sharedState.cappedReason).toBe('maxTurns');
    expect(result.outputText).toBe(SUMMARY_TEXT);

    // Criterion 2: no tool was executed on the capped turn.
    expect(processToolCallsMock).not.toHaveBeenCalled();

    // The pending tool call was answered synthetically so the transcript stays
    // well-formed, and the forced summary instruction was injected.
    const toolMsg = result.sharedState.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toBe(GRACEFUL_CAP_TOOL_RESULT);
    expect((toolMsg as { tool_call_id?: string })?.tool_call_id).toBe('call_1');

    // The one-shot summary directive was cleared once the plane landed.
    expect(result.sharedState.forceSummaryTurn).toBeFalsy();

    // Steps: start, process(tool-call -> lands), process(summary). Exactly 3.
    expect((FlowExecutor.executeStep as jest.Mock).mock.calls.length).toBe(3);
  });
});
