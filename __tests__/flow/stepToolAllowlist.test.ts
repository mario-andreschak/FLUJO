/**
 * A step's tool list holds at call time, not only when it is offered.
 *
 * `SharedState.toolNameMap` keeps every tool bound during a run so history stays
 * decodable. Before this guard, a later step could therefore call a tool that only
 * an earlier step was offered, and FLUJO's by-name tools were never checked at all.
 * The dispatch boundary is exercised for real; only the MCP service is replaced.
 */

const callToolMock = jest.fn();
const loadServerConfigsMock = jest.fn();
jest.mock('@/backend/services/mcp', () => {
  const actual = jest.requireActual('@/backend/services/mcp');
  return {
    ...actual,
    mcpService: {
      ...actual.mcpService,
      callTool: (...args: unknown[]) => callToolMock(...args),
      loadServerConfigs: (...args: unknown[]) => loadServerConfigsMock(...args),
    },
  };
});

import OpenAI from 'openai';
import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { ToolHandler } from '@/backend/execution/flow/handlers/ToolHandler';
import { encodeToolName, isToolOfferedInStep } from '@/backend/execution/flow/handlers/toolNamespace';
import { ProcessNode } from '@/backend/execution/flow/nodes/ProcessNode';
import { applyApprovalDecision } from '@/backend/execution/flow/resumeAfterApproval';
import type { ProcessNodeParams, SharedState } from '@/backend/execution/flow/types';
import { saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';

const FIRST_STEP_TOOL = encodeToolName('srv', 'read_deadlines');
const SECOND_STEP_TOOL = encodeToolName('srv', 'summarise');
const toolNameMap = {
  [FIRST_STEP_TOOL]: { server: 'srv', tool: 'read_deadlines' },
  [SECOND_STEP_TOOL]: { server: 'srv', tool: 'summarise' },
};

const toolCall = (id: string, name: string): OpenAI.ChatCompletionMessageFunctionToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: '{}' },
});

beforeEach(() => {
  callToolMock.mockReset().mockResolvedValue({ success: true, data: { ok: true } });
  loadServerConfigsMock.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('isToolOfferedInStep', () => {
  it('accepts everything when no step recorded an offer', () => {
    expect(isToolOfferedInStep(FIRST_STEP_TOOL, undefined, toolNameMap)).toBe(true);
  });

  it('accepts only the offered names', () => {
    expect(isToolOfferedInStep(SECOND_STEP_TOOL, [SECOND_STEP_TOOL], toolNameMap)).toBe(true);
    expect(isToolOfferedInStep(FIRST_STEP_TOOL, [SECOND_STEP_TOOL], toolNameMap)).toBe(false);
    expect(isToolOfferedInStep(FIRST_STEP_TOOL, [], toolNameMap)).toBe(false);
  });

  it('treats a legacy spelling as an alias of the offered pair only', () => {
    expect(isToolOfferedInStep('_-_-_srv_-_-_summarise', [SECOND_STEP_TOOL], toolNameMap)).toBe(true);
    expect(isToolOfferedInStep('_-_-_srv_-_-_read_deadlines', [SECOND_STEP_TOOL], toolNameMap)).toBe(false);
  });
});

describe('dispatch enforces the current step offer', () => {
  it('answers a call to an earlier step tool with an error and does not run it', async () => {
    const emit = jest.fn();
    const result = await ModelHandler.processToolCalls({
      toolCalls: [toolCall('c1', FIRST_STEP_TOOL)],
      toolNameMap,
      offeredToolNames: [],
      emit,
    });

    expect(result.success).toBe(true);
    expect(callToolMock).not.toHaveBeenCalled();
    if (!result.success) return;
    expect(result.value.toolCallMessages).toHaveLength(1);
    expect(result.value.toolCallMessages[0]).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
    expect(String(result.value.toolCallMessages[0].content)).toContain('not available in this step');
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool:result', toolCallId: 'c1', isError: true }));
  });

  it('still runs the offered call in a mixed batch and answers both', async () => {
    const result = await ModelHandler.processToolCalls({
      toolCalls: [toolCall('c1', FIRST_STEP_TOOL), toolCall('c2', SECOND_STEP_TOOL)],
      toolNameMap,
      offeredToolNames: [SECOND_STEP_TOOL],
    });

    expect(result.success).toBe(true);
    expect(callToolMock).toHaveBeenCalledTimes(1);
    expect(callToolMock.mock.calls[0].slice(0, 2)).toEqual(['srv', 'summarise']);
    if (!result.success) return;
    expect(result.value.toolCallMessages.map((message) => (message as { tool_call_id?: string }).tool_call_id)).toEqual(['c1', 'c2']);
    expect(String(result.value.toolCallMessages[0].content)).toContain('not available in this step');
    expect(String(result.value.toolCallMessages[1].content)).not.toContain('not available in this step');
  });

  it.each(['read_resource', 'list_mcp_resources', 'todo', 'question'])(
    'also rejects the by-name tool %s when the step did not offer it',
    async (name) => {
      const result = await ModelHandler.processToolCalls({
        toolCalls: [toolCall('c1', name)],
        toolNameMap,
        offeredToolNames: [SECOND_STEP_TOOL],
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(String(result.value.toolCallMessages[0].content)).toContain('not available in this step');
    },
  );

  it('leaves callers without an offer unchanged', async () => {
    const result = await ModelHandler.processToolCalls({
      toolCalls: [toolCall('c1', FIRST_STEP_TOOL)],
      toolNameMap,
    });

    expect(result.success).toBe(true);
    expect(callToolMock).toHaveBeenCalledTimes(1);
  });

  it('applies the same offer when a human approves the call later', async () => {
    const state = {
      conversationId: 'conversation',
      flowId: 'flow',
      status: 'awaiting_tool_approval',
      messages: [],
      title: 'test',
      createdAt: 1,
      updatedAt: 1,
      toolNameMap,
      offeredToolNames: [SECOND_STEP_TOOL],
      pendingToolCalls: [toolCall('c1', FIRST_STEP_TOOL)],
    } as unknown as SharedState;

    const decision = await applyApprovalDecision(state, 'c1', 'approve');

    expect(decision.outcome).toBe('ready');
    expect(callToolMock).not.toHaveBeenCalled();
    expect(String(state.messages.find((message) => message.role === 'tool')?.content)).toContain('not available in this step');
  });
});

describe('ProcessNode.prep records one offer per step', () => {
  const flowSnapshot = (ids: string[]) => ({
    id: 'flow',
    name: 'Flow',
    nodes: ids.map((id) => ({
      id,
      type: 'process',
      position: { x: 0, y: 0 },
      data: { type: 'process', label: id, properties: { boundModel: 'model-1', promptTemplate: 'Prompt' } },
    })),
    edges: [],
  });

  const params = (id: string, toolName?: string): ProcessNodeParams => ({
    id,
    label: id,
    type: 'process',
    properties: {
      boundModel: 'model-1',
      promptTemplate: 'Prompt',
      ...(toolName
        ? { mcpNodes: [{ id: `${id}-mcp`, properties: { boundServer: 'srv', enabledTools: [toolName] } }] }
        : {}),
    },
  } as unknown as ProcessNodeParams);

  const stateFor = (ids: string[]) => ({
    trackingInfo: { executionId: 'run', startTime: 1, nodeExecutionTracker: [] },
    messages: [{ role: 'user', content: 'Hello', id: 'm1', timestamp: 1 }],
    flowId: 'flow',
    flowSnapshot: flowSnapshot(ids),
    conversationId: 'conversation',
    title: 'test',
    createdAt: 1,
    updatedAt: 1,
  } as unknown as SharedState);

  beforeEach(async () => {
    await saveItem(StorageKey.MODELS, [{ id: 'model-1', name: 'fixture', provider: 'openai', adapter: 'openai', ApiKey: '' }]);
    jest.spyOn(ToolHandler, 'processMCPNodes').mockImplementation(async (input) => ({
      success: true,
      value: {
        availableTools: (input.mcpNodes ?? []).flatMap((node) => (node.properties.enabledTools ?? []).map((tool) => ({
          name: encodeToolName(node.properties.boundServer ?? '', tool),
          originalName: tool,
          server: node.properties.boundServer,
          description: tool,
          inputSchema: { type: 'object', properties: {} },
        }))),
      },
    }));
  });

  it('replaces the offer on the next step while the name map stays decodable', async () => {
    const state = stateFor(['first', 'second']);

    await new ProcessNode().prep(state, params('first', 'read_deadlines'));
    expect(state.offeredToolNames).toContain(FIRST_STEP_TOOL);

    await new ProcessNode().prep(state, params('second', 'summarise'));
    expect(state.offeredToolNames).toContain(SECOND_STEP_TOOL);
    expect(state.offeredToolNames).not.toContain(FIRST_STEP_TOOL);
    expect(state.toolNameMap?.[FIRST_STEP_TOOL]).toMatchObject({ server: 'srv', tool: 'read_deadlines' });
    expect(isToolOfferedInStep(FIRST_STEP_TOOL, state.offeredToolNames, state.toolNameMap)).toBe(false);
  });

  it('records no tools on a forced summary turn', async () => {
    const state = stateFor(['first']);
    state.forceSummaryTurn = true;

    await new ProcessNode().prep(state, params('first', 'read_deadlines'));

    expect(state.offeredToolNames).toEqual([]);
  });
});
