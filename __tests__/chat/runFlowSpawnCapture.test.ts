/**
 * Tests for the multi-call handoff capture in runFlow (issue #156,
 * spawn-with-brief).
 *
 * When the routing model calls the SAME handoff tool several times in one
 * assistant turn (each call carrying a `task` brief), the handoff transition
 * must:
 *   - capture EVERY matching call's brief into SharedState.handoffInput.tasks
 *     (in call order),
 *   - append one tool-result message PER matching call (each tool_call id
 *     answered — a dangling id corrupts the persisted transcript),
 *   - answer handoff calls that targeted a DIFFERENT node with an explicit
 *     "Not executed" result instead of leaving them dangling,
 *   - keep the single-call `prompt` capture (issue #96) byte-compatible, with a
 *     lone `task` doubling as the caller prompt.
 *
 * The engine (FlowExecutor) is stubbed with a start -> worker state machine; the
 * start step's "model turn" fabricates the assistant tool-call message.
 */
import type { SharedState } from '@/backend/execution/flow/types';

const START = 'aaaaaaaa-start';
const WORKER = 'bbbbbbbb-worker';
const OTHER = 'cccccccc-other';
const EDGE = `${START}->${WORKER}`;

// Configured per test: the tool_calls the start step's assistant turn carries.
let assistantToolCalls: any[] = [];

jest.mock('@/backend/execution/flow/FlowExecutor', () => {
  const S = 'aaaaaaaa-start';
  const W = 'bbbbbbbb-worker';
  const E = `${S}->${W}`;
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
          // The routing step: the model answered with handoff tool calls.
          sharedState.handoffNameMap = { handoff_to_worker: W, handoff_to_other: 'cccccccc-other' };
          sharedState.messages.push({
            role: 'assistant',
            content: 'Dispatching workers.',
            tool_calls: assistantToolCalls,
            id: 'assistant-router',
            timestamp: 1,
            processNodeId: S,
          });
          return { sharedState, action: E };
        }
        sharedState.lastResponse = 'joined results';
        sharedState.messages.push({
          role: 'assistant',
          content: 'joined results',
          id: 'assistant-final',
          timestamp: 2,
          processNodeId: W,
        });
        return { sharedState, action: FINAL };
      }),
      resolveHandoff: jest.fn(async (sharedState: any, action: string) => {
        if (sharedState.currentNodeId === S && action === E) {
          return { isSuccessorEdge: true, targetNodeId: W };
        }
        return { isSuccessorEdge: false, targetNodeId: null };
      }),
      peekNextNodeId: jest.fn(async (sharedState: any) => sharedState.currentNodeId ?? S),
    },
  };
});

jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async () => undefined),
  saveItem: jest.fn(async () => undefined),
  assertSafeCollectionId: () => undefined,
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

function spawnCall(id: string, task: string) {
  return { id, type: 'function', function: { name: 'handoff_to_worker', arguments: JSON.stringify({ task }) } };
}

beforeEach(() => {
  conversationStates.clear();
  assistantToolCalls = [];
});

describe('runFlow handoff capture — spawn-with-brief (issue #156)', () => {
  it('captures one brief per matching call, in call order, and answers every call', async () => {
    assistantToolCalls = [
      spawnCall('c1', 'audit security'),
      spawnCall('c2', 'check cleanliness'),
      spawnCall('c3', 'assess reuse'),
    ];
    const result = await runFlow({ flowId: 'flow-1', prompt: 'go', mode: 'conversation' });

    expect(result.status).toBe('completed');
    const state = result.sharedState;
    expect(state.handoffInput).toMatchObject({
      targetNodeId: WORKER,
      tasks: ['audit security', 'check cleanliness', 'assess reuse'],
    });

    // One tool result per call id, stamped with its lane position.
    const toolResults = result.messages.filter((m: any) => m.role === 'tool');
    expect(toolResults.map((m: any) => m.tool_call_id)).toEqual(['c1', 'c2', 'c3']);
    const parsed = toolResults.map((m: any) => JSON.parse(m.content));
    expect(parsed[0]).toMatchObject({ status: 'Handoff processed', lane: 1, laneCount: 3 });
    expect(parsed[2]).toMatchObject({ status: 'Handoff processed', lane: 3, laneCount: 3 });
  });

  it('answers a handoff call to a DIFFERENT target as not executed', async () => {
    assistantToolCalls = [
      spawnCall('c1', 'brief one'),
      { id: 'cx', type: 'function', function: { name: 'handoff_to_other', arguments: '{}' } },
    ];
    const result = await runFlow({ flowId: 'flow-1', prompt: 'go', mode: 'conversation' });

    const toolResults = result.messages.filter((m: any) => m.role === 'tool');
    const other = toolResults.find((m: any) => m.tool_call_id === 'cx');
    expect(other).toBeDefined();
    expect(JSON.parse(other!.content as string)).toMatchObject({ status: 'Not executed' });
  });

  it('a single `task` call also fills the legacy caller prompt (issue #96 compatibility)', async () => {
    assistantToolCalls = [spawnCall('c1', 'one brief')];
    const result = await runFlow({ flowId: 'flow-1', prompt: 'go', mode: 'conversation' });

    expect(result.sharedState.handoffInput).toMatchObject({
      targetNodeId: WORKER,
      prompt: 'one brief',
      tasks: ['one brief'],
    });
    // Single call: no lane stamping in its tool result.
    const toolResult = result.messages.find((m: any) => m.role === 'tool' && m.tool_call_id === 'c1');
    expect(JSON.parse(toolResult!.content as string)).toEqual({
      status: 'Handoff processed',
      targetNodeId: WORKER,
    });
  });

  it('multi-call `prompt` args are treated as per-instance briefs too', async () => {
    assistantToolCalls = [
      { id: 'c1', type: 'function', function: { name: 'handoff_to_worker', arguments: JSON.stringify({ prompt: 'p1' }) } },
      { id: 'c2', type: 'function', function: { name: 'handoff_to_worker', arguments: JSON.stringify({ prompt: 'p2' }) } },
    ];
    const result = await runFlow({ flowId: 'flow-1', prompt: 'go', mode: 'conversation' });

    expect(result.sharedState.handoffInput).toMatchObject({
      targetNodeId: WORKER,
      tasks: ['p1', 'p2'],
    });
  });

  it('a malformed args string on one call never breaks routing or the other briefs', async () => {
    assistantToolCalls = [
      { id: 'c1', type: 'function', function: { name: 'handoff_to_worker', arguments: 'NOT JSON' } },
      spawnCall('c2', 'good brief'),
    ];
    const result = await runFlow({ flowId: 'flow-1', prompt: 'go', mode: 'conversation' });

    expect(result.status).toBe('completed');
    expect(result.sharedState.handoffInput).toMatchObject({ tasks: ['good brief'] });
    // Both calls still answered.
    const toolResults = result.messages.filter((m: any) => m.role === 'tool');
    expect(toolResults.map((m: any) => m.tool_call_id)).toEqual(['c1', 'c2']);
  });

  it('a plain (no-args) single handoff captures nothing (unchanged behavior)', async () => {
    assistantToolCalls = [
      { id: 'c1', type: 'function', function: { name: 'handoff_to_worker', arguments: '{}' } },
    ];
    const result = await runFlow({ flowId: 'flow-1', prompt: 'go', mode: 'conversation' });

    expect(result.status).toBe('completed');
    expect(result.sharedState.handoffInput).toBeUndefined();
    const toolResult = result.messages.find((m: any) => m.role === 'tool');
    expect(JSON.parse(toolResult!.content as string)).toEqual({
      status: 'Handoff processed',
      targetNodeId: WORKER,
    });
  });
});
