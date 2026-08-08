import type OpenAI from 'openai';
import type { SharedState, ProcessNodeParams, ToolDefinition } from '@/backend/execution/flow/types';

const liveStates = new Map<string, Partial<SharedState>>();
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: {
    get conversationStates() {
      return liveStates;
    },
  },
}));

const renderPromptMock = jest.fn();
jest.mock('@/backend/utils/PromptRenderer', () => ({
  promptRenderer: { renderPrompt: (...args: unknown[]) => renderPromptMock(...args) },
}));

const getFlowMock = jest.fn();
jest.mock('@/backend/services/flow/index', () => ({
  flowService: { getFlow: (...args: unknown[]) => getFlowMock(...args) },
}));

const getModelMock = jest.fn();
const resolveKeyMock = jest.fn();
jest.mock('@/backend/services/model', () => ({
  modelService: {
    getModel: (...args: unknown[]) => getModelMock(...args),
    resolveAndDecryptApiKey: (...args: unknown[]) => resolveKeyMock(...args),
  },
}));

const createCompletionMock = jest.fn();
jest.mock('@/backend/services/model/adapters', () => ({
  getCompletionAdapter: () => ({ createCompletion: createCompletionMock }),
}));

const callMcpToolMock = jest.fn();
jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    loadServerConfigs: jest.fn(async () => []),
    callTool: (...args: unknown[]) => callMcpToolMock(...args),
  },
}));

import {
  MEETING_CAST_VOTE_TOOL_NAME,
  MEETING_CONTROL_TOOL_NAME,
  MEETING_PARTICIPANT_PROTOCOL,
  MEETING_PROPOSE_MOTION_TOOL_NAME,
  MEETING_REQUEST_BREAKOUT_TOOL_NAME,
  MEETING_SEND_PRIVATE_TOOL_NAME,
  MEETING_TOOL_NAMES,
  appendMeetingParticipantProtocol,
  buildMeetingTools,
  executeMeetingTool,
  isMeetingToolName,
  normalizeMeetingToolAction,
} from '@/backend/execution/flow/handlers/meetingTools';
import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { ProcessNode } from '@/backend/execution/flow/nodes/ProcessNode';

function participantState(overrides: Partial<SharedState> = {}): SharedState {
  return {
    trackingInfo: { executionId: 'exec-1', startTime: 1, nodeExecutionTracker: [] },
    messages: [],
    flowId: 'flow-1',
    conversationId: 'conv-1',
    status: 'running',
    title: 'Meeting participant',
    createdAt: 1,
    updatedAt: 1,
    meetingParticipant: {
      protocolVersion: 1,
      meetingId: 'meeting-1',
      participantId: 'alice',
      participantName: 'Alice',
      role: 'participant',
    },
    meetingTurn: { turnId: 'turn-1', roundId: 'round-1', actions: [] },
    ...overrides,
  } as SharedState;
}

function processParams(): ProcessNodeParams {
  return {
    id: 'process-1',
    label: 'Participant model',
    type: 'process',
    properties: { boundModel: 'model-1' },
  } as ProcessNodeParams;
}

function toolCall(
  id: string,
  name: string,
  args: unknown,
): OpenAI.ChatCompletionMessageFunctionToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

function toOpenAiTool(tool: ToolDefinition): OpenAI.ChatCompletionFunctionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  } as OpenAI.ChatCompletionFunctionTool;
}

function completion(content = 'Public contribution.') {
  return {
    completion: {
      id: 'chatcmpl-meeting',
      object: 'chat.completion',
      created: 1,
      model: 'meeting-model',
      choices: [{
        index: 0,
        finish_reason: 'stop',
        logprobs: null,
        message: { role: 'assistant', content, refusal: null },
      }],
    },
  };
}

beforeEach(() => {
  liveStates.clear();
  renderPromptMock.mockReset().mockResolvedValue('Base participant instructions.');
  getFlowMock.mockReset().mockResolvedValue({ id: 'flow-1', name: 'Flow', nodes: [], edges: [] });
  getModelMock.mockReset().mockResolvedValue({
    id: 'model-1',
    name: 'meeting-model',
    provider: 'openai',
    adapter: 'openai',
  });
  resolveKeyMock.mockReset().mockResolvedValue('test-key');
  createCompletionMock.mockReset().mockResolvedValue(completion());
  callMcpToolMock.mockReset();
});

describe('fixed meeting tool contract', () => {
  it('builds five byte-stable definitions with compact enum schemas', () => {
    const first = buildMeetingTools();
    const second = buildMeetingTools();

    expect(first.map((tool) => tool.name)).toEqual(MEETING_TOOL_NAMES);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(((first[0].inputSchema.properties as Record<string, any>).action).enum)
      .toEqual(['silent', 'leave']);
    expect(((first[2].inputSchema.properties as Record<string, any>).kind).enum)
      .toEqual(['finish', 'cancel', 'followup']);
    expect(((first[3].inputSchema.properties as Record<string, any>).choice).enum)
      .toEqual(['yes', 'no', 'abstain']);
    expect(first.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true);
  });

  it('recognizes only the reserved meeting tool names', () => {
    for (const name of MEETING_TOOL_NAMES) expect(isMeetingToolName(name)).toBe(true);
    expect(isMeetingToolName('meeting_speak')).toBe(false);
    expect(isMeetingToolName('todo')).toBe(false);
  });

  it('appends a stable protocol without interpolating participant data', () => {
    expect(appendMeetingParticipantProtocol('Base')).toBe(`Base\n\n${MEETING_PARTICIPANT_PROTOCOL}`);
    expect(appendMeetingParticipantProtocol('')).toBe(MEETING_PARTICIPANT_PROTOCOL);
    expect(MEETING_PARTICIPANT_PROTOCOL).not.toContain('Alice');
  });
});

describe('meeting action normalization and live turn buffer', () => {
  it('normalizes every action shape, trims strings, and de-duplicates recipients', () => {
    expect(normalizeMeetingToolAction(MEETING_CONTROL_TOOL_NAME, {
      action: 'silent', reason: '  already covered  ',
    })).toEqual({ action: { type: 'control', action: 'silent', reason: 'already covered' } });

    expect(normalizeMeetingToolAction(MEETING_SEND_PRIVATE_TOOL_NAME, {
      to: [' bob ', 'bob', 'carol'], content: '  Please verify this. ',
    })).toEqual({
      action: { type: 'private-message', to: ['bob', 'carol'], content: 'Please verify this.' },
    });

    expect(normalizeMeetingToolAction(MEETING_PROPOSE_MOTION_TOOL_NAME, {
      kind: 'followup', proposal: ' Review next week ',
    })).toEqual({
      action: { type: 'propose-motion', kind: 'followup', proposal: 'Review next week' },
    });

    expect(normalizeMeetingToolAction(MEETING_CAST_VOTE_TOOL_NAME, {
      motionId: ' motion-1 ', choice: 'yes', rationale: ' Ready ',
    })).toEqual({
      action: { type: 'cast-vote', motionId: 'motion-1', choice: 'yes', rationale: 'Ready' },
    });

    expect(normalizeMeetingToolAction(MEETING_REQUEST_BREAKOUT_TOOL_NAME, {
      participants: ['alice', ' bob ', 'alice'], topic: ' Resolve API shape ', maxRounds: 2,
    })).toEqual({
      action: {
        type: 'request-breakout',
        participants: ['alice', 'bob'],
        topic: 'Resolve API shape',
        maxRounds: 2,
      },
    });
  });

  it('rejects malformed calls without appending partial actions', async () => {
    const state = participantState();
    liveStates.set('conv-1', state);

    const invalid = await executeMeetingTool(
      MEETING_REQUEST_BREAKOUT_TOOL_NAME,
      { participants: [], topic: '', maxRounds: 0 },
      { conversationId: 'conv-1' },
    );
    expect(invalid.success).toBe(false);
    expect(state.meetingTurn?.actions).toEqual([]);

    expect(normalizeMeetingToolAction(MEETING_CAST_VOTE_TOOL_NAME, {
      motionId: 'm1', choice: 'maybe',
    })).toEqual({ error: 'meeting_cast_vote choice must be "yes", "no", or "abstain".' });
  });

  it('requires both a participant identity and an active turn', async () => {
    liveStates.set('plain', participantState({
      conversationId: 'plain', meetingParticipant: undefined, meetingTurn: undefined,
    }));
    liveStates.set('idle', participantState({ conversationId: 'idle', meetingTurn: undefined }));

    await expect(executeMeetingTool(
      MEETING_CONTROL_TOOL_NAME,
      { action: 'silent' },
      { conversationId: 'plain' },
    )).resolves.toMatchObject({ success: false, error: expect.stringContaining('outside a meeting') });
    await expect(executeMeetingTool(
      MEETING_CONTROL_TOOL_NAME,
      { action: 'silent' },
      { conversationId: 'idle' },
    )).resolves.toMatchObject({ success: false, error: expect.stringContaining('active meeting turn') });
  });

  it('appends validated actions in call order to the live turn', async () => {
    const state = participantState();
    liveStates.set('conv-1', state);

    await executeMeetingTool(MEETING_CONTROL_TOOL_NAME, { action: 'silent' }, { conversationId: 'conv-1' });
    await executeMeetingTool(
      MEETING_CAST_VOTE_TOOL_NAME,
      { motionId: 'motion-1', choice: 'abstain' },
      { conversationId: 'conv-1' },
    );

    expect(state.meetingTurn?.actions).toEqual([
      { type: 'control', action: 'silent' },
      { type: 'cast-vote', motionId: 'motion-1', choice: 'abstain' },
    ]);
  });
});

describe('ProcessNode meeting advertisement', () => {
  it('injects the protocol and all fixed tools only for participant state', async () => {
    const meetingPrep = await new ProcessNode().prep(participantState(), processParams());
    expect(meetingPrep.currentPrompt).toContain(MEETING_PARTICIPANT_PROTOCOL);
    expect(meetingPrep.availableTools?.filter((tool) => isMeetingToolName(tool.name)).map((tool) => tool.name))
      .toEqual(MEETING_TOOL_NAMES);

    const plainPrep = await new ProcessNode().prep(
      participantState({ meetingParticipant: undefined, meetingTurn: undefined }),
      processParams(),
    );
    expect(plainPrep.currentPrompt).toBe('Base participant instructions.');
    expect(plainPrep.availableTools?.some((tool) => isMeetingToolName(tool.name))).toBe(false);
  });
});

describe('meeting tool dispatch', () => {
  it('dispatches meeting tools locally in processToolCalls and returns paired tool results', async () => {
    const state = participantState();
    liveStates.set('conv-1', state);
    const emit = jest.fn();

    const result = await ModelHandler.processToolCalls({
      conversationId: 'conv-1',
      emit,
      toolCalls: [
        toolCall('call-1', MEETING_SEND_PRIVATE_TOOL_NAME, { to: ['bob'], content: 'Check this.' }),
        toolCall('call-2', MEETING_CONTROL_TOOL_NAME, { action: 'silent' }),
      ],
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error.message);
    expect(result.value.toolCallMessages).toHaveLength(2);
    expect(result.value.toolCallMessages.map((message) =>
      message.role === 'tool' ? message.tool_call_id : undefined))
      .toEqual(['call-1', 'call-2']);
    expect(result.value.toolCallMessages[0].content).toContain('"accepted":true');
    expect(state.meetingTurn?.actions).toEqual([
      { type: 'private-message', to: ['bob'], content: 'Check this.' },
      { type: 'control', action: 'silent' },
    ]);
    expect(callMcpToolMock).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tool:result', toolCallId: 'call-1', isError: false,
    }));
  });

  it('turns validation failures into error tool messages without breaking the batch', async () => {
    const state = participantState();
    liveStates.set('conv-1', state);

    const result = await ModelHandler.processToolCalls({
      conversationId: 'conv-1',
      toolCalls: [toolCall('call-bad', MEETING_CAST_VOTE_TOOL_NAME, {
        motionId: '', choice: 'yes',
      })],
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error.message);
    expect(result.value.toolCallMessages[0].content).toMatch(/^Error:/);
    expect(state.meetingTurn?.actions).toEqual([]);
    expect(callMcpToolMock).not.toHaveBeenCalled();
  });

  it('provides the same executors to self-orchestrating adapters', async () => {
    const state = participantState();
    liveStates.set('conv-1', state);
    getModelMock.mockResolvedValue({
      id: 'model-1',
      name: 'meeting-model',
      provider: 'anthropic',
      adapter: 'claude-cli',
    });
    createCompletionMock.mockImplementationOnce(async (input: {
      localToolExecutors?: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
    }) => {
      const localNames = Object.keys(input.localToolExecutors ?? {}).filter(isMeetingToolName);
      expect(localNames).toEqual(MEETING_TOOL_NAMES);
      await input.localToolExecutors?.[MEETING_CAST_VOTE_TOOL_NAME]({
        motionId: 'motion-9', choice: 'no', rationale: 'Needs evidence',
      });
      return completion();
    });

    const result = await ModelHandler.callModel({
      modelId: 'model-1',
      prompt: 'Meeting protocol.',
      messages: [{ role: 'user', content: 'Round update', id: 'u1', timestamp: 1 }],
      tools: buildMeetingTools().map(toOpenAiTool),
      iteration: 1,
      maxIterations: 1,
      nodeName: 'Participant model',
      nodeId: 'process-1',
      conversationId: 'conv-1',
    });

    expect(result.success).toBe(true);
    expect(state.meetingTurn?.actions).toEqual([{
      type: 'cast-vote', motionId: 'motion-9', choice: 'no', rationale: 'Needs evidence',
    }]);
    expect(callMcpToolMock).not.toHaveBeenCalled();
  });
});
