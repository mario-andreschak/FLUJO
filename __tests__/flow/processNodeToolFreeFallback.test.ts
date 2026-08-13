import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { modelService } from '@/backend/services/model';
import { FinishNode, ProcessNode } from '@/backend/execution/flow/nodes';
import type {
  ProcessNodeParams,
  ProcessNodePrepResult,
  SharedState,
  ToolDefinition,
} from '@/backend/execution/flow/types';
import type { FlujoChatMessage } from '@/shared/types/chat';

const handoffTool = (name = 'handoff_to_finish_node'): ToolDefinition => ({
  name,
  description: 'Finish',
  inputSchema: { type: 'object', properties: {}, required: [] },
});

const message = (
  role: FlujoChatMessage['role'],
  content: string,
  id: string
): FlujoChatMessage => ({ role, content, id, timestamp: 1 } as FlujoChatMessage);

function prep(availableTools: ToolDefinition[] = [handoffTool()]): ProcessNodePrepResult {
  return {
    nodeId: 'proc',
    nodeType: 'process',
    currentPrompt: 'Generate an image',
    boundModel: 'image-model',
    availableTools,
    messages: [message('user', 'Generate a banana ice cream image', 'u1')],
  };
}

function params(overrides: Partial<ProcessNodeParams> = {}): ProcessNodeParams {
  return {
    id: 'proc',
    label: 'Image generator',
    type: 'process',
    properties: { boundModel: 'image-model' },
    orderedOutgoingEdges: ['e-finish'],
    ...overrides,
  };
}

function state(): SharedState {
  return {
    trackingInfo: { executionId: 'exec', startTime: 1, nodeExecutionTracker: [] },
    messages: [],
    flowId: 'flow',
    conversationId: 'conversation',
    title: 'test',
    createdAt: 1,
    updatedAt: 1,
  } as SharedState;
}

function nodeWithFinish(): ProcessNode {
  const node = new ProcessNode();
  const finish = new FinishNode();
  finish.setParams({}, { id: 'finish', label: 'Finish', type: 'finish', properties: {} });
  node.addSuccessor(finish, 'e-finish');
  return node;
}

const unsupportedTools = {
  success: false,
  error: {
    type: 'model',
    code: 'api_error',
    message:
      '404 No endpoints found that support tool use. Try disabling "handoff_to_finish_node".',
    details: {
      status: 404,
      providerError: {
        error: {
          message: 'No endpoints found that support tool use.',
        },
      },
    },
  },
} as const;

const successfulCompletion = {
  success: true,
  value: {
    content: 'generated image content',
    messages: [
      message('user', 'Generate a banana ice cream image', 'u1'),
      message('assistant', 'generated image content', 'a1'),
    ],
  },
} as const;

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ProcessNode unsupported-tool fallback', () => {
  beforeEach(() => {
    jest.spyOn(modelService, 'getModel').mockResolvedValue(null);
  });

  it('uses discovered capability metadata to avoid the invalid tool request', async () => {
    jest.spyOn(modelService, 'getModel').mockResolvedValue({
      id: 'image-model',
      name: 'google/gemini-3.1-flash-lite-image',
      ApiKey: 'encrypted:test',
      baseUrl: 'https://openrouter.ai/api/v1',
      provider: 'openrouter',
      supportsTools: false,
    });
    const callModel = jest
      .spyOn(ModelHandler, 'callModel')
      .mockResolvedValue(successfulCompletion as any);
    const node = nodeWithFinish();
    const nodeParams = params();

    const exec = await node.execCore(prep(), nodeParams);

    expect(callModel).toHaveBeenCalledTimes(1);
    expect(callModel.mock.calls[0][0].tools).toBeUndefined();
    expect(exec.usedToolFreeFallback).toBe(true);
    await expect(node.post(prep(), exec, state(), nodeParams)).resolves.toBe('e-finish');
  });

  it('rejects a provider response that arrives after Persona authority is lost', async () => {
    const leaseLost = new Error('Persona lease is no longer current');
    const assertCurrent = jest
      .fn<Promise<void>, []>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(leaseLost);
    const callModel = jest
      .spyOn(ModelHandler, 'callModel')
      .mockResolvedValue(successfulCompletion as any);
    const prepared: ProcessNodePrepResult = {
      ...prep(),
      executionAuthority: {
        assertCurrent,
        signal: new AbortController().signal,
      },
    };

    await expect(nodeWithFinish().execCore(prepared, params())).rejects.toBe(leaseLost);
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(assertCurrent).toHaveBeenCalledTimes(3);
  });

  it('retries a sole-handoff node without tools and automatically takes its only edge', async () => {
    const callModel = jest
      .spyOn(ModelHandler, 'callModel')
      .mockResolvedValueOnce(unsupportedTools as any)
      .mockResolvedValueOnce(successfulCompletion as any);
    const node = nodeWithFinish();
    const nodeParams = params();

    const exec = await node.execCore(prep(), nodeParams);

    expect(exec.success).toBe(true);
    expect(exec.usedToolFreeFallback).toBe(true);
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(callModel.mock.calls[0][0].tools).toHaveLength(1);
    expect(callModel.mock.calls[1][0].tools).toBeUndefined();
    await expect(node.post(prep(), exec, state(), nodeParams)).resolves.toBe('e-finish');
  });

  it('retries handoff-only tools when conditioned edges own the routing decision', async () => {
    const callModel = jest
      .spyOn(ModelHandler, 'callModel')
      .mockResolvedValueOnce(unsupportedTools as any)
      .mockResolvedValueOnce(successfulCompletion as any);
    const node = nodeWithFinish();
    const nodeParams = params({
      edgeConditions: { 'e-finish': { kind: 'contains', value: 'generated image' } },
    });

    const exec = await node.execCore(prep(), nodeParams);

    expect(callModel).toHaveBeenCalledTimes(2);
    await expect(node.post(prep(), exec, state(), nodeParams)).resolves.toBe('e-finish');
  });

  it('does not strip tools from a node with a connected MCP node', async () => {
    const callModel = jest
      .spyOn(ModelHandler, 'callModel')
      .mockResolvedValue(unsupportedTools as any);
    const nodeParams = params({
      properties: {
        boundModel: 'image-model',
        mcpNodes: [
          {
            id: 'mcp-1',
            properties: { boundServer: 'images', enabledTools: ['generate'] },
          },
        ],
      },
    });

    await expect(nodeWithFinish().execCore(prep(), nodeParams)).rejects.toThrow(
      'Model execution failed'
    );
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it('does not strip a synthetic or executable non-handoff tool', async () => {
    const callModel = jest
      .spyOn(ModelHandler, 'callModel')
      .mockResolvedValue(unsupportedTools as any);
    const executableTool: ToolDefinition = {
      name: 'write_resource',
      description: 'Write an artifact',
      inputSchema: { type: 'object', properties: {} },
    };

    await expect(
      nodeWithFinish().execCore(prep([handoffTool(), executableTool]), params())
    ).rejects.toThrow('Model execution failed');
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it('does not retry when multiple bare paths still require a handoff choice', async () => {
    const callModel = jest
      .spyOn(ModelHandler, 'callModel')
      .mockResolvedValue(unsupportedTools as any);
    const node = nodeWithFinish();
    const alternate = new FinishNode();
    alternate.setParams(
      {},
      { id: 'alternate', label: 'Alternate', type: 'finish', properties: {} }
    );
    node.addSuccessor(alternate, 'e-alternate');
    const nodeParams = params({
      orderedOutgoingEdges: ['e-finish', 'e-alternate'],
    });

    await expect(
      node.execCore(
        prep([handoffTool(), handoffTool('handoff_to_alternate_node')]),
        nodeParams
      )
    ).rejects.toThrow('Model execution failed');
    expect(callModel).toHaveBeenCalledTimes(1);
  });
});
