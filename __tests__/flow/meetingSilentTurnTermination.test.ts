/**
 * A participant that calls meeting_control(silent) has ended its turn for the
 * current meeting round. The request/response tool loop must persist the paired
 * tool result and then stop before another model step or graph handoff can run.
 */
import type { SharedState } from '@/backend/execution/flow/types';

const START = 'start-node';
const PROCESS = 'process-node';
const FLOW_ID = 'flow-meeting-silence';
const CONVERSATION_ID = 'meeting-participant-conversation';

const processToolCallsMock = jest.fn(async (input: {
  conversationId?: string;
  toolCalls: Array<{ id: string }>;
}) => {
  const states = (jest.requireMock('@/backend/execution/flow/FlowExecutor') as {
    FlowExecutor: { conversationStates: Map<string, SharedState> };
  }).FlowExecutor.conversationStates;
  const state = input.conversationId
    ? states.get(input.conversationId)
    : undefined;
  if (!state?.meetingTurn) throw new Error('Expected a live meeting turn.');
  state.meetingTurn.actions.push({ type: 'control', action: 'silent' });
  return {
    success: true,
    value: {
      toolCallMessages: [{
        id: 'silent-result',
        role: 'tool',
        tool_call_id: input.toolCalls[0].id,
        content: JSON.stringify({ accepted: true, actionType: 'control', turnEnded: true }),
        timestamp: 2,
      }],
      processedToolCalls: [],
    },
  };
});

jest.mock('@/backend/execution/flow/handlers/ModelHandler', () => ({
  ModelHandler: {
    processToolCalls: (...args: unknown[]) => processToolCallsMock(...(args as [any])),
  },
}));

jest.mock('@/backend/execution/flow/FlowExecutor', () => {
  const S = 'start-node';
  const P = 'process-node';
  const EDGE = 'start-node->process-node';
  const conversationStates = new Map();
  return {
    FlowExecutor: {
      conversationStates,
      clearFlowCache: jest.fn(),
      executeStep: jest.fn(async (sharedState: SharedState) => {
        const nodeId = sharedState.currentNodeId ?? S;
        sharedState.currentNodeId = nodeId;
        if (nodeId === S) return { sharedState, action: EDGE };

        sharedState.messages.push({
          id: 'silent-call-message',
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call-silent',
            type: 'function',
            function: {
              name: 'meeting_control',
              arguments: JSON.stringify({ action: 'silent' }),
            },
          }],
          timestamp: 1,
          processNodeId: P,
        });
        return { sharedState, action: 'TOOL_CALL' };
      }),
      resolveHandoff: jest.fn(async (sharedState: SharedState, action: string) => (
        sharedState.currentNodeId === S && action === EDGE
          ? { isSuccessorEdge: true, targetNodeId: P }
          : { isSuccessorEdge: false, targetNodeId: null }
      )),
      peekNextNodeId: jest.fn(async (sharedState: SharedState) => sharedState.currentNodeId ?? S),
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
  name: 'MeetingSilenceFlow',
  nodes: [
    { id: START, type: 'start' },
    { id: PROCESS, type: 'process' },
  ],
  edges: [
    { source: START, target: PROCESS, type: 'custom', data: { edgeType: 'standard' } },
  ],
};

jest.mock('@/backend/services/flow/index', () => ({
  flowService: {
    loadFlows: jest.fn(async () => [flowGraph]),
    getFlow: jest.fn(async () => flowGraph),
  },
}));

jest.mock('@/backend/execution/flow/validateFlowForRun', () => ({
  validateFlowForRun: jest.fn(async () => ({ issues: [], errorCount: 0, warningCount: 0, isRunnable: true })),
}));

import { runFlow } from '@/backend/execution/flow/runFlow';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';

beforeEach(() => {
  FlowExecutor.conversationStates.clear();
  processToolCallsMock.mockClear();
  (FlowExecutor.executeStep as jest.Mock).mockClear();
});

describe('meeting silence turn termination', () => {
  it('ends the current round after the silent tool result without another model step', async () => {
    const result = await runFlow({
      flowId: FLOW_ID,
      conversationId: CONVERSATION_ID,
      title: 'Silent participant',
      prompt: 'Current meeting round.',
      mode: 'conversation',
      source: 'meeting',
      meetingParticipant: {
        protocolVersion: 1,
        meetingId: 'meeting-1',
        participantId: 'participant-1',
        participantName: 'Nemotron',
        role: 'participant',
      },
      meetingTurn: {
        turnId: 'turn-1',
        roundId: 'round-1',
        actions: [],
      },
    });

    expect(result.status).toBe('completed');
    expect(result.sharedState.meetingTurn?.actions).toEqual([
      { type: 'control', action: 'silent' },
    ]);
    expect(processToolCallsMock).toHaveBeenCalledTimes(1);
    expect(FlowExecutor.executeStep).toHaveBeenCalledTimes(2);
    expect(result.messages.some((message) =>
      message.role === 'tool' && message.tool_call_id === 'call-silent')).toBe(true);
  });
});
