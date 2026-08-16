/**
 * Regression test for finer debugger step granularity (roadmap #7b).
 *
 * Before: while single-stepping, one "Step" ran a Process node's model call AND
 * executed the resulting tool calls in the same step, so the user could not
 * inspect the tool calls before they ran, nor the tool results before the model
 * was re-invoked.
 *
 * After: when the model returns tool calls during a debug single-step, execution
 * pauses *before* running them (the calls are stored in
 * sharedState.debugPendingToolCalls). The NEXT step executes them at the top of
 * the loop and pauses again *before* the model is re-invoked.
 *
 * These tests stub the engine (FlowExecutor) so a process step returns
 * TOOL_CALL_ACTION with an assistant tool call, and stub ModelHandler so tool
 * execution is observable without any network/model call.
 */
import type { SharedState } from '@/backend/execution/flow/types';

const PROCESS = 'ef2a3c01-process';
const CONV_ID = 'conv-debug-grain-1';
const FLOW_ID = 'flow-1';

jest.mock('@/backend/execution/flow/FlowExecutor', () => {
  const P = 'ef2a3c01-process';
  const TOOL_CALL = 'TOOL_CALL';
  const conversationStates = new Map();
  const executeStep = jest.fn(async (sharedState: any) => {
    // Simulate a Process node whose model produced a (non-handoff) tool call.
    sharedState.currentNodeId = P;
    const toolCalls = [
      { id: 'tc1', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
      ...(sharedState.__debugTestTwoTools
        ? [{ id: 'tc2', type: 'function', function: { name: 'echo', arguments: '{"text":"again"}' } }]
        : []),
    ];
    sharedState.messages.push({
      role: 'assistant',
      content: '',
      id: `assistant-${sharedState.messages.length}`,
      timestamp: 1,
      processNodeId: P,
      tool_calls: toolCalls,
    });
    return { sharedState, action: TOOL_CALL };
  });
  return {
    FlowExecutor: {
      conversationStates,
      clearFlowCache: jest.fn(),
      executeStep,
      // TOOL_CALL is not a successor edge.
      resolveHandoff: jest.fn(async () => ({ isSuccessorEdge: false, targetNodeId: null })),
      peekNextNodeId: jest.fn(async (s: any) => s.currentNodeId ?? P),
    },
  };
});

// Observe tool execution without running anything real.
jest.mock('@/backend/execution/flow/handlers/ModelHandler', () => ({
  ModelHandler: {
    processToolCalls: jest.fn(async ({ toolCalls }: any) => ({
      success: true,
      value: {
        toolCallMessages: toolCalls.map((call: any) => ({
          role: 'tool',
          tool_call_id: call.id,
          content: call.id === 'tc1' ? 'sunny' : 'again',
        })),
      },
    })),
  },
}));

jest.mock('@/backend/execution/flow/persistConversationState', () => ({
  persistConversationState: jest.fn(async () => {}),
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

import { processChatCompletion } from '@/app/v1/chat/completions/chatCompletionService';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';

const conversationStates = FlowExecutor.conversationStates as Map<string, SharedState>;
const processToolCalls = ModelHandler.processToolCalls as jest.Mock;

function seedPausedAtProcess() {
  const state = {
    trackingInfo: { executionId: 'e1', startTime: 1, nodeExecutionTracker: [] },
    messages: [{ role: 'user', content: 'weather?', id: 'user-1', timestamp: 1, processNodeId: PROCESS }],
    flowId: FLOW_ID,
    conversationId: CONV_ID,
    currentNodeId: PROCESS,
    status: 'paused_debug',
    debugMode: true,
    originalRequireApproval: false,
    createdAt: 1,
    updatedAt: 1,
  } as unknown as SharedState;
  conversationStates.set(CONV_ID, state);
  return state;
}

const request = { model: 'flow-TestFlow', messages: [{ role: 'user', content: 'weather?' }] } as any;

// A debug single-step: continueDebug=false, userTurn=false.
const step = () => processChatCompletion(request, true, false, false, CONV_ID, false, false);
const freshDebugTurn = () => processChatCompletion(request, true, false, true, CONV_ID, false, true);

beforeEach(() => {
  conversationStates.clear();
  (FlowExecutor.executeStep as jest.Mock).mockClear();
  processToolCalls.mockClear();
});

describe('debug step granularity (#7b): model call and tool execution are separate steps', () => {
  it('a fresh debugger turn pauses BEFORE the first node executes', async () => {
    seedPausedAtProcess();

    await freshDebugTurn();

    const state = conversationStates.get(CONV_ID)!;
    expect(FlowExecutor.executeStep).not.toHaveBeenCalled();
    expect(state.status).toBe('paused_debug');
    expect(state.debugBoundary).toMatchObject({
      operation: 'node',
      phase: 'before',
      nodeId: PROCESS,
      stateSnapshot: {
        currentNodeId: PROCESS,
        messageCount: 1,
      },
    });
  });

  it('first step pauses BEFORE executing the tools', async () => {
    seedPausedAtProcess();
    await step();

    const state = conversationStates.get(CONV_ID)!;
    // Tools captured as pending, NOT yet executed.
    expect(state.debugPendingToolCalls).toHaveLength(1);
    expect(processToolCalls).not.toHaveBeenCalled();
    expect(state.status).toBe('paused_debug');
    expect(state.debugBoundary).toMatchObject({
      operation: 'tool',
      phase: 'before',
      nodeId: PROCESS,
      previousOperation: 'model',
      toolCalls: [{ id: 'tc1' }],
    });
  });

  it('next step executes the pending tools and pauses again before re-invoking the model', async () => {
    seedPausedAtProcess();
    await step(); // step 1: model call -> pause before tools
    expect((FlowExecutor.executeStep as jest.Mock).mock.calls.length).toBe(1);

    await step(); // step 2: execute tools -> pause after

    const state = conversationStates.get(CONV_ID)!;
    expect(processToolCalls).toHaveBeenCalledTimes(1);
    expect(state.debugPendingToolCalls).toBeUndefined();
    // The model was NOT re-invoked on the tool-execution step (executeStep still
    // only ran once, during step 1).
    expect((FlowExecutor.executeStep as jest.Mock).mock.calls.length).toBe(1);
    // The tool result was appended.
    expect(state.messages.some(m => m.role === 'tool' && m.tool_call_id === 'tc1')).toBe(true);
    expect(state.status).toBe('paused_debug');
    expect(state.debugBoundary).toMatchObject({
      operation: 'tool',
      phase: 'after',
      nodeId: PROCESS,
      nextOperation: 'model',
      toolCalls: [{ id: 'tc1' }],
    });
  });

  it('stops before and after every call in a multi-tool model turn', async () => {
    const seeded = seedPausedAtProcess();
    (seeded as any).__debugTestTwoTools = true;

    await step(); // model -> before the batch
    expect(conversationStates.get(CONV_ID)?.debugPendingToolCalls).toHaveLength(2);

    await step(); // execute call 1 -> after call 1
    let state = conversationStates.get(CONV_ID)!;
    expect(processToolCalls).toHaveBeenCalledTimes(1);
    expect(processToolCalls.mock.calls[0][0].toolCalls).toMatchObject([{ id: 'tc1' }]);
    expect(state.debugPendingToolCalls).toMatchObject([{ id: 'tc2' }]);
    expect(state.debugBoundary).toMatchObject({
      operation: 'tool',
      phase: 'after',
      toolCalls: [{ id: 'tc1' }],
    });
    expect(state.debugBoundary?.nextOperation).toBeUndefined();

    await step(); // expose call 2 -> before call 2
    state = conversationStates.get(CONV_ID)!;
    expect(processToolCalls).toHaveBeenCalledTimes(1);
    expect(state.debugBoundary).toMatchObject({
      operation: 'tool',
      phase: 'before',
      toolCalls: [{ id: 'tc2' }],
    });

    await step(); // execute call 2 -> after call 2
    state = conversationStates.get(CONV_ID)!;
    expect(processToolCalls).toHaveBeenCalledTimes(2);
    expect(processToolCalls.mock.calls[1][0].toolCalls).toMatchObject([{ id: 'tc2' }]);
    expect(state.debugPendingToolCalls).toBeUndefined();
    expect(state.messages.some(m => m.role === 'tool' && m.tool_call_id === 'tc2')).toBe(true);
    expect(state.debugBoundary).toMatchObject({
      operation: 'tool',
      phase: 'after',
      nextOperation: 'model',
      toolCalls: [{ id: 'tc2' }],
    });
    expect((FlowExecutor.executeStep as jest.Mock)).toHaveBeenCalledTimes(1);
  });
});
