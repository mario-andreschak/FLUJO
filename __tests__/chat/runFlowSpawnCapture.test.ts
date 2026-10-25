/**
 * Tests for queued Subflow handoff capture in runFlow.
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
let targetType: string | undefined;
let mixedBatch = false;

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
          sharedState.handoffTargetTypes = targetType ? { [W]: targetType } : {};
          sharedState.messages.push({
            role: 'assistant',
            content: 'Dispatching workers.',
            tool_calls: assistantToolCalls,
            id: 'assistant-router',
            timestamp: 1,
            processNodeId: S,
          });
          if (mixedBatch) {
            sharedState.handoffRequested = { edgeId: E, targetNodeId: W };
            return { sharedState, action: 'TOOL_CALL' };
          }
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
  validateFlowObjectForRun: jest.fn(async () => ({ issues: [], errorCount: 0, warningCount: 0, isRunnable: true })),
}));

jest.mock('@/backend/execution/flow/handlers/ModelHandler', () => ({
  ModelHandler: {
    processToolCalls: jest.fn(async ({ toolCalls }: any) => ({
      success: true,
      value: {
        toolCallMessages: toolCalls.map((call: any) => ({
          role: 'tool',
          tool_call_id: call.id,
          content: `result:${call.id}`,
        })),
      },
    })),
  },
}));

import { runFlow as runFlowWithContext, type FlowRunInput } from '@/backend/execution/flow/runFlow';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { getSubflowPreparationDiagnostics } from '@/backend/execution/flow/subflowPreparationBudget';
import { saveItem } from '@/utils/storage/backend';

const runFlow = (input: Omit<FlowRunInput, 'source'>) =>
  runFlowWithContext({ ...input, source: 'api' });

const conversationStates = FlowExecutor.conversationStates as Map<string, SharedState>;

function spawnCall(id: string, task: string) {
  return { id, type: 'function', function: { name: 'handoff_to_worker', arguments: JSON.stringify({ task }) } };
}

beforeEach(() => {
  conversationStates.clear();
  assistantToolCalls = [];
  targetType = undefined;
  mixedBatch = false;
  jest.clearAllMocks();
});

describe('runFlow handoff capture — queued Subflow jobs', () => {
  it('checkpoints the folded visit continuation with its next node before executing that node', async () => {
    const checkpoints: Array<{ node?: string; continued?: number; active?: string }> = [];
    jest.mocked(saveItem).mockImplementation(async (_key, value) => {
      const state = value as SharedState;
      if (state.subflowInvocations?.visit) checkpoints.push({ node: state.currentNodeId,
        continued: state.subflowInvocations.visit.foldReceipt?.continuedAt, active: state.activeSubflowInvocationByNode?.[START] });
    });
    const originalStep = (FlowExecutor.executeStep as jest.Mock).getMockImplementation()!;
    (FlowExecutor.executeStep as jest.Mock).mockImplementationOnce(async shared => {
      const result = await originalStep(shared);
      shared.subflowInvocations = { visit: { id: 'visit', parentNodeId: START, status: 'folded', foldedAt: 1,
        lanes: [], foldReceipt: { version: 1, id: 'visit:fold:v1', presentation: 'joined', action: EDGE, messageIds: [] } } };
      shared.activeSubflowInvocationByNode = { [START]: 'visit' };
      return result;
    }).mockImplementationOnce(async shared => {
      expect(shared.currentNodeId).toBe(WORKER);
      expect(checkpoints).toContainEqual({ node: WORKER, continued: expect.any(Number), active: undefined });
      return originalStep(shared);
    });
    try {
      expect((await runFlow({ flowId: 'flow-1', prompt: 'go', mode: 'conversation' })).status).toBe('completed');
    } finally { jest.mocked(saveItem).mockImplementation(async () => undefined); }
  });

  it.each(['source', 'depth', 'count', 'workers'] as const)('refuses excessive handoff %s before acknowledging or replacing pending work', async boundary => {
    targetType = 'subflow';
    const argumentsText = boundary === 'source' ? JSON.stringify({ task: 'x'.repeat(4 * 1024 * 1024) })
      : boundary === 'depth' ? '{"task":' + '['.repeat(65) + '0' + ']'.repeat(65) + '}'
        : boundary === 'workers' ? '{"task":"keep me","concurrencyLimit":17}' : '{"task":"keep me"}';
    assistantToolCalls = Array.from({ length: boundary === 'count' ? 4097 : 1 }, (_, index) => ({
      id: `pending-${index}`, type: 'function', function: { name: 'handoff_to_worker', arguments: argumentsText },
    }));
    const pending = { targetNodeId: WORKER, prompt: 'original pending input', tasks: ['original job'] };
    const originalStep = (FlowExecutor.executeStep as jest.Mock).getMockImplementation()!;
    (FlowExecutor.executeStep as jest.Mock).mockImplementationOnce(async (sharedState: SharedState) => {
      sharedState.handoffInput = pending;
      return originalStep(sharedState);
    });
    const parse = jest.spyOn(JSON, 'parse');
    try {
      const result = await runFlow({ flowId: 'flow-1', prompt: 'go', mode: 'conversation' });
      expect(result.status).toBe('error');
      expect(result.error).toMatchObject({ statusCode: 413, details: { code: 'SUBFLOW_PREPARATION_TOO_LARGE' } });
      expect(result.sharedState.handoffInput).toBe(pending);
      expect(result.sharedState.currentNodeId).toBe(START);
      expect(result.messages.filter(message => message.role === 'tool')).toHaveLength(0);
      const assistant = result.messages.find(message => message.id === 'assistant-router');
      expect(assistant?.tool_calls?.map(call => call.id)).toEqual(assistantToolCalls.map(call => call.id));
      if (boundary !== 'workers') expect(parse.mock.calls.some(([value]) => value === argumentsText)).toBe(false);
      expect(getSubflowPreparationDiagnostics()).toMatchObject({ active: 0, reservedBytes: 0 });
    } finally { parse.mockRestore(); }
  });

  it('captures every one of forty authored handoff jobs within admission limits', async () => {
    targetType = 'subflow';
    assistantToolCalls = Array.from({ length: 40 }, (_, index) => spawnCall(`job-${index}`, `task-${index}`));
    const result = await runFlow({ flowId: 'flow-1', prompt: 'go', mode: 'conversation' });
    expect(result.status).toBe('completed');
    expect(result.sharedState.handoffInput?.tasks).toHaveLength(40);
    expect(result.messages.filter(message => message.role === 'tool')).toHaveLength(40);
  });

  it.each(['count', 'bytes'] as const)('admits losing handoff targets too and refuses excessive batch %s before any acknowledgement', async boundary => {
    targetType = 'subflow';
    const losingArguments = boundary === 'bytes' ? JSON.stringify({ task: 'L'.repeat(4 * 1024 * 1024) }) : '{"task":"losing job"}';
    assistantToolCalls = [spawnCall('chosen', 'small winning task'),
      ...Array.from({ length: boundary === 'count' ? 4096 : 1 }, (_, index) => ({
        id: `losing-${index}`, type: 'function', function: { name: 'handoff_to_other', arguments: losingArguments },
      })),
    ];
    const pending = { targetNodeId: WORKER, prompt: 'keep pending', tasks: ['keep original task'] };
    const originalStep = (FlowExecutor.executeStep as jest.Mock).getMockImplementation()!;
    (FlowExecutor.executeStep as jest.Mock).mockImplementationOnce(async (sharedState: SharedState) => {
      sharedState.handoffInput = pending;
      return originalStep(sharedState);
    });
    const result = await runFlow({ flowId: 'flow-1', prompt: 'go', mode: 'conversation' });
    expect(result.status).toBe('error');
    expect(result.error).toMatchObject({ statusCode: 413, details: { code: 'SUBFLOW_PREPARATION_TOO_LARGE' } });
    expect(result.sharedState.handoffInput).toBe(pending);
    expect(result.sharedState.currentNodeId).toBe(START);
    expect(result.messages.filter(message => message.role === 'tool')).toHaveLength(0);
    expect(result.messages.find(message => message.id === 'assistant-router')?.tool_calls?.map(call => call.id))
      .toEqual(assistantToolCalls.map(call => call.id));
    expect(getSubflowPreparationDiagnostics()).toMatchObject({ active: 0, reservedBytes: 0 });
  });

  it.each(['subflow', 'signal'] as const)('does not answer or recapture a completed historical handoff on a later deterministic %s edge', async (caseTarget) => {
    (FlowExecutor.executeStep as jest.Mock).mockImplementationOnce(async (sharedState: SharedState) => {
      sharedState.currentNodeId = START;
      sharedState.handoffNameMap = { handoff_to_other: OTHER };
      sharedState.handoffTargetTypes = { [WORKER]: caseTarget };
      sharedState.messages.push(
        { role: 'assistant', content: 'Finished.', tool_calls: [
          { id: 'completed-handoff', type: 'function', function: { name: 'handoff_to_other',
            arguments: JSON.stringify({ task: 'old brief', sessionKey: 'old-session' }) } },
        ], id: 'historical-assistant', timestamp: 1 },
        { role: 'tool', tool_call_id: 'completed-handoff',
          content: JSON.stringify({ status: 'Handoff processed', targetNodeId: OTHER }),
          id: 'historical-result', timestamp: 2 },
        { role: 'user', content: 'Continue with this new request.', id: 'new-user', timestamp: 3 },
      );
      return { sharedState, action: EDGE };
    });

    const result = await runFlow({ flowId: 'flow-1', prompt: 'continue', mode: 'conversation' });

    expect(result.status).toBe('completed');
    expect(result.sharedState.currentNodeId).toBe(WORKER);
    expect(result.messages.filter(message => message.role === 'tool' && message.tool_call_id === 'completed-handoff'))
      .toHaveLength(1);
    expect(result.sharedState.handoffInput).toBeUndefined();
  });

  it('answers only the pending calls in a partially completed handoff batch', async () => {
    targetType = 'subflow';
    assistantToolCalls = [spawnCall('already-answered', 'old brief'), spawnCall('pending', 'new brief')];
    const originalStep = (FlowExecutor.executeStep as jest.Mock).getMockImplementation()!;
    (FlowExecutor.executeStep as jest.Mock).mockImplementationOnce(async (sharedState: SharedState) => {
      const result = await originalStep(sharedState);
      sharedState.messages.push({ role: 'tool', tool_call_id: 'already-answered',
        content: JSON.stringify({ status: 'Handoff processed', targetNodeId: WORKER }),
        id: 'existing-result', timestamp: 2 });
      return result;
    });

    const result = await runFlow({ flowId: 'flow-1', prompt: 'continue', mode: 'conversation' });

    expect(result.status).toBe('completed');
    expect(result.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id))
      .toEqual(['already-answered', 'pending']);
    expect(result.sharedState.handoffInput).toMatchObject({ tasks: ['new brief'] });
  });

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

  it('captures a Process-to-Signal body in target-scoped handoff state', async () => {
    targetType = 'signal';
    assistantToolCalls = [
      { id: 'c1', type: 'function', function: { name: 'handoff_to_worker', arguments: JSON.stringify({ body: 'signal payload' }) } },
    ];

    const result = await runFlow({ flowId: 'flow-1', prompt: 'go', mode: 'conversation' });

    expect(result.sharedState.handoffInput).toMatchObject({
      targetNodeId: WORKER,
      fromHandoffTool: true,
      signalBody: 'signal payload',
    });
  });

  it('marks a parameterless Signal handoff so SignalNode can reject it defensively', async () => {
    targetType = 'signal';
    assistantToolCalls = [
      { id: 'c1', type: 'function', function: { name: 'handoff_to_worker', arguments: '{}' } },
    ];

    const result = await runFlow({ flowId: 'flow-1', prompt: 'go', mode: 'conversation' });

    expect(result.sharedState.handoffInput).toMatchObject({
      targetNodeId: WORKER,
      fromHandoffTool: true,
    });
    expect(result.sharedState.handoffInput?.signalBody).toBeUndefined();
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

  it('captures a parameterless Subflow handoff as one default-input job', async () => {
    targetType = 'subflow';
    assistantToolCalls = [
      { id: 'c1', type: 'function', function: { name: 'handoff_to_worker', arguments: '{}' } },
    ];

    const result = await runFlow({ flowId: 'flow-1', prompt: 'go', mode: 'conversation' });

    expect(result.sharedState.handoffInput).toMatchObject({
      targetNodeId: WORKER,
      tasks: [''],
    });
  });

  it('executes ordinary calls before committing a handoff from the same assistant turn', async () => {
    mixedBatch = true;
    assistantToolCalls = [
      { id: 'ordinary-1', type: 'function', function: { name: 'mcp_read_issue', arguments: '{}' } },
      spawnCall('handoff-1', 'continue after reading'),
      { id: 'ordinary-2', type: 'function', function: { name: 'mcp_read_comments', arguments: '{}' } },
    ];

    const result = await runFlow({
      flowId: 'flow-1',
      prompt: 'go',
      mode: 'conversation',
      flujo: true,
      requireApproval: false,
    });

    expect(result.status).toBe('completed');
    expect(ModelHandler.processToolCalls).toHaveBeenCalledTimes(1);
    expect((ModelHandler.processToolCalls as jest.Mock).mock.calls[0][0].toolCalls.map((call: any) => call.id))
      .toEqual(['ordinary-1', 'ordinary-2']);

    const resultIds = result.messages
      .filter((message: any) => message.role === 'tool')
      .map((message: any) => message.tool_call_id);
    expect(resultIds).toEqual(['ordinary-1', 'ordinary-2', 'handoff-1']);
    expect(result.sharedState.currentNodeId).toBe(WORKER);
  });

  it('keeps caller session keys aligned with their queued Subflow tasks', async () => {
    targetType = 'subflow';
    assistantToolCalls = [
      { id: 'c1', type: 'function', function: { name: 'handoff_to_worker', arguments: JSON.stringify({ task: 'draft', sessionKey: 'writer-a' }) } },
      { id: 'c2', type: 'function', function: { name: 'handoff_to_worker', arguments: JSON.stringify({ task: 'review' }) } },
      { id: 'c3', type: 'function', function: { name: 'handoff_to_worker', arguments: JSON.stringify({ task: 'revise', sessionKey: 'writer-a' }) } },
    ];

    const result = await runFlow({ flowId: 'flow-1', prompt: 'go', mode: 'conversation' });

    expect(result.sharedState.handoffInput).toMatchObject({
      tasks: ['draft', 'review', 'revise'],
      sessionKeys: ['writer-a', null, 'writer-a'],
    });
  });
});
