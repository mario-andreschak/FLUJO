/**
 * Tool breakpoints: the debugger can now break on TOOL CALLS, not only nodes.
 *
 * Node breakpoints answered "stop before this step runs"; there was no way to
 * stop right before a tool fires and inspect the arguments the model produced
 * (short of single-stepping the whole run). A `tool:` entry in the same
 * `SharedState.breakpoints` array does exactly that: the loop pauses before the
 * batch is executed, stores the calls in `debugPendingToolCalls` and flips the
 * conversation into debug mode, so the next Step executes them.
 *
 * The engine is stubbed the same way as debugStepGranularity.test.ts: a Process
 * node whose model returned one tool call, and an observable (never real) tool
 * executor.
 */
import type { SharedState } from '@/backend/execution/flow/types';
import {
  matchToolBreakpoint,
  nodeBreakpoints,
  toolBreakpointNames,
  toolNodeBreakpointIds,
  ANY_TOOL_BREAKPOINT,
  ATTACH_BREAKPOINT,
  TOOL_NODE_BREAKPOINT_PREFIX,
} from '@/utils/shared/debugBreakpoints';

const PROCESS = 'ef2a3c01-process';
const CONV_ID = 'conv-tool-breakpoint-1';
const FLOW_ID = 'flow-1';
// The model-facing (namespaced) name of the tool the stubbed model calls.
const WIRE_TOOL_NAME = 'mcp_filesystem_ab12cd';

jest.mock('@/backend/execution/flow/FlowExecutor', () => {
  const P = 'ef2a3c01-process';
  const TOOL_CALL = 'TOOL_CALL';
  const conversationStates = new Map();
  const executeStep = jest.fn(async (sharedState: any) => {
    if (sharedState.__debugTestControlNode) {
      sharedState.currentNodeId = 'start';
      return { sharedState, action: 'start->process' };
    }
    const handoff = !!sharedState.__debugTestHandoff;
    const final = !!sharedState.__debugTestFinal;
    sharedState.currentNodeId = P;
    sharedState.messages.push({
      role: 'assistant',
      content: final ? 'All done.' : '',
      id: `assistant-${sharedState.messages.length}`,
      timestamp: 1,
      processNodeId: P,
      tool_calls: final ? undefined : [
        { id: 'tc1', type: 'function', function: { name: handoff ? 'handoff_to_finish' : 'mcp_filesystem_ab12cd', arguments: '{}' } },
      ],
    });
    return { sharedState, action: final ? 'FINAL_RESPONSE' : handoff ? 'process->finish' : TOOL_CALL };
  });
  return {
    FlowExecutor: {
      conversationStates,
      clearFlowCache: jest.fn(),
      executeStep,
      resolveHandoff: jest.fn(async (_state: any, action: string) => {
        if (action === 'process->finish') return { isSuccessorEdge: true, targetNodeId: 'finish' };
        if (action === 'start->process') return { isSuccessorEdge: true, targetNodeId: P };
        return { isSuccessorEdge: false, targetNodeId: null };
      }),
      peekNextNodeId: jest.fn(async (s: any) => s.currentNodeId ?? P),
    },
  };
});

jest.mock('@/backend/execution/flow/handlers/ModelHandler', () => ({
  ModelHandler: {
    processToolCalls: jest.fn(async () => ({
      success: true,
      value: { toolCallMessages: [{ role: 'tool', tool_call_id: 'tc1', content: 'ok' }] },
    })),
  },
}));

jest.mock('@/backend/execution/flow/persistConversationState', () => ({
  persistConversationState: jest.fn(async () => {}),
}));
jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async () => undefined),
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

function seedRunningState(breakpoints: string[]) {
  const state = {
    trackingInfo: { executionId: 'e1', startTime: 1, nodeExecutionTracker: [] },
    messages: [{ role: 'user', content: 'read the file', id: 'user-1', timestamp: 1, processNodeId: PROCESS }],
    flowId: FLOW_ID,
    conversationId: CONV_ID,
    currentNodeId: PROCESS,
    status: 'running',
    // NOT in debug mode: a plain run that a tool breakpoint should be able to
    // catch and pull into the debugger.
    debugMode: false,
    breakpoints,
    toolNameMap: { [WIRE_TOOL_NAME]: { server: 'filesystem', tool: 'read_file' } },
    originalRequireApproval: false,
    createdAt: 1,
    updatedAt: 1,
  } as unknown as SharedState;
  conversationStates.set(CONV_ID, state);
  return state;
}

const request = { model: 'flow-TestFlow', messages: [{ role: 'user', content: 'read the file' }] } as any;
// Resume an existing conversation without arming debug mode.
const run = () => processChatCompletion(request, true, false, false, CONV_ID, false, false);

beforeEach(() => {
  conversationStates.clear();
  (FlowExecutor.executeStep as jest.Mock).mockClear();
  processToolCalls.mockClear();
});

describe('breakpoint vocabulary', () => {
  it('separates node, tool and attach entries', () => {
    const bps = ['node-1', ATTACH_BREAKPOINT, ANY_TOOL_BREAKPOINT, 'tool:read_file'];
    expect(nodeBreakpoints(bps)).toEqual(['node-1']);
    expect(toolBreakpointNames(bps)).toEqual(['*', 'read_file']);
  });

  it('matches namespaced MCP names through the decoder', () => {
    const calls = [{ function: { name: WIRE_TOOL_NAME } }];
    const decode = (name: string) =>
      name === WIRE_TOOL_NAME ? { server: 'filesystem', tool: 'read_file' } : null;

    expect(matchToolBreakpoint(['tool:read_file'], calls, decode)).toBe(WIRE_TOOL_NAME);
    expect(matchToolBreakpoint(['tool:filesystem:read_file'], calls, decode)).toBe(WIRE_TOOL_NAME);
    expect(matchToolBreakpoint([ANY_TOOL_BREAKPOINT], calls, decode)).toBe(WIRE_TOOL_NAME);
    expect(matchToolBreakpoint(['tool:write_file'], calls, decode)).toBeNull();
    // Node breakpoints never fire on tool calls.
    expect(matchToolBreakpoint(['node-1'], calls, decode)).toBeNull();
  });

  it('matches a passive MCP canvas node through its advertised tool origin', () => {
    const calls = [{ function: { name: WIRE_TOOL_NAME } }];
    const breakpoint = `${TOOL_NODE_BREAKPOINT_PREFIX}mcp-node-1`;
    const decode = () => ({ server: 'filesystem', tool: 'read_file', nodeId: 'mcp-node-1' });

    expect(toolNodeBreakpointIds([breakpoint])).toEqual(['mcp-node-1']);
    expect(nodeBreakpoints([breakpoint])).toEqual([]);
    expect(matchToolBreakpoint([breakpoint], calls, decode)).toBe(WIRE_TOOL_NAME);
  });
});

describe('tool breakpoints pause a normal (non-single-step) run', () => {
  it('steps through a control node directly to the BEFORE target-node boundary', async () => {
    const state = seedRunningState([]);
    state.status = 'paused_debug';
    state.debugMode = true;
    state.currentNodeId = 'start';
    (state as any).__debugTestControlNode = true;

    await run();

    expect(FlowExecutor.executeStep).toHaveBeenCalledTimes(1);
    expect(conversationStates.get(CONV_ID)).toMatchObject({
      status: 'paused_debug',
      currentNodeId: PROCESS,
      debugBoundary: {
        operation: 'node',
        phase: 'before',
        nodeId: PROCESS,
        edgeId: 'start->process',
      },
    });
  });

  it('pauses BEFORE the tools run when "any tool" is armed', async () => {
    seedRunningState([ANY_TOOL_BREAKPOINT]);
    await run();

    const state = conversationStates.get(CONV_ID)!;
    expect(processToolCalls).not.toHaveBeenCalled();
    expect(state.debugPendingToolCalls).toHaveLength(1);
    expect(state.status).toBe('paused_debug');
    // The run entered the debugger, so Step/Continue drive it from here.
    expect(state.debugMode).toBe(true);
  });

  it('pauses on a specific tool, matched through the namespaced name', async () => {
    seedRunningState(['tool:read_file']);
    await run();

    const state = conversationStates.get(CONV_ID)!;
    expect(processToolCalls).not.toHaveBeenCalled();
    expect(state.status).toBe('paused_debug');
  });

  it('does NOT pause when the armed tool is a different one', async () => {
    seedRunningState(['tool:write_file']);
    await run();

    const state = conversationStates.get(CONV_ID)!;
    // The tools ran (the stubbed model keeps calling them until the loop's
    // iteration cap, which is exactly "nothing stopped it").
    expect(processToolCalls).toHaveBeenCalled();
    expect(state.debugPendingToolCalls).toBeUndefined();
    expect(state.status).not.toBe('paused_debug');
  });

  it('pauses before the permission/approval gate when approvals are enabled', async () => {
    seedRunningState([ANY_TOOL_BREAKPOINT]);
    await processChatCompletion(request, true, true, false, CONV_ID, false, false);

    const state = conversationStates.get(CONV_ID)!;
    expect(processToolCalls).not.toHaveBeenCalled();
    expect(state.status).toBe('paused_debug');
    expect(state.debugPendingAction).toMatchObject({ action: 'TOOL_CALL' });

    await processChatCompletion(
      { ...request, messages: state.messages } as any,
      true,
      true,
      false,
      CONV_ID,
      true,
      false,
    );
    expect(conversationStates.get(CONV_ID)?.status).toBe('awaiting_tool_approval');
  });

  it('catches handoff tool calls before the graph transition is applied', async () => {
    const state = seedRunningState([ANY_TOOL_BREAKPOINT]);
    (state as any).__debugTestHandoff = true;

    await run();

    expect(conversationStates.get(CONV_ID)).toMatchObject({
      status: 'paused_debug',
      currentNodeId: PROCESS,
      debugPendingAction: { action: 'process->finish', phase: 'after-model' },
      debugBoundary: {
        operation: 'handoff',
        phase: 'before',
        nodeId: PROCESS,
        targetNodeId: 'finish',
        edgeId: 'process->finish',
        previousOperation: 'model',
      },
    });

    const parked = conversationStates.get(CONV_ID)!;
    await processChatCompletion(
      { ...request, messages: parked.messages } as any,
      true,
      false,
      false,
      CONV_ID,
      false,
      false,
    );

    expect(conversationStates.get(CONV_ID)).toMatchObject({
      status: 'paused_debug',
      currentNodeId: 'finish',
      debugBoundary: {
        operation: 'handoff',
        phase: 'after',
        nodeId: PROCESS,
        targetNodeId: 'finish',
        edgeId: 'process->finish',
        nextOperation: 'node',
      },
    });
  });

  it('attach pauses after the active model turn without replacing authored breakpoints', async () => {
    const state = seedRunningState(['node-kept']);
    state.debugPauseRequested = true;

    await run();

    expect(processToolCalls).not.toHaveBeenCalled();
    expect(conversationStates.get(CONV_ID)).toMatchObject({
      status: 'paused_debug',
      debugPauseRequested: false,
      breakpoints: ['node-kept'],
    });
  });

  it('does not re-trigger a tool breakpoint from an older assistant turn', async () => {
    const state = seedRunningState(['tool:read_file']);
    state.messages.push({
      role: 'assistant',
      content: '',
      id: 'assistant-old-tool-call',
      timestamp: 1,
      processNodeId: PROCESS,
      tool_calls: [
        { id: 'old-tc', type: 'function', function: { name: WIRE_TOOL_NAME, arguments: '{}' } },
      ],
    } as any);
    (state as any).__debugTestFinal = true;

    await run();

    expect(conversationStates.get(CONV_ID)?.status).toBe('completed');
    expect(conversationStates.get(CONV_ID)?.debugPendingAction).toBeUndefined();
  });
});
