const completionMock = jest.fn();
const gatherContextMock = jest.fn();
const suggestToolsMock = jest.fn();
const suggestAgentsMock = jest.fn();
const loadFlowsMock = jest.fn();

jest.mock('@/backend/services/model', () => ({
  modelService: {
    getModel: jest.fn().mockResolvedValue({
      id: 'model-1',
      name: 'Generator',
      adapter: 'openai',
      ApiKey: 'encrypted',
      maxTokens: 4096,
    }),
    resolveAndDecryptApiKey: jest.fn().mockResolvedValue('secret'),
  },
}));
jest.mock('@/backend/services/model/adapters', () => ({
  getCompletionAdapter: () => ({ createCompletion: (...args: unknown[]) => completionMock(...args) }),
}));
jest.mock('@/backend/services/flow/generationContext', () => ({
  gatherGenerationContext: (...args: unknown[]) => gatherContextMock(...args),
}));
jest.mock('@/backend/services/flow/assistedAuthoring', () => ({
  suggestToolsForFlowStep: (...args: unknown[]) => suggestToolsMock(...args),
  suggestAgentsForFlowStep: (...args: unknown[]) => suggestAgentsMock(...args),
}));
jest.mock('@/backend/services/flow', () => ({
  flowService: { loadFlows: (...args: unknown[]) => loadFlowsMock(...args) },
}));
jest.mock('@/backend/services/mcp/registryInstall', () => ({
  searchRegistry: jest.fn().mockResolvedValue([]),
  installRegistryServer: jest.fn().mockResolvedValue({ installed: false }),
}));
jest.mock('@/backend/services/mcp/autoInstall', () => ({
  loadAutoInstallSettings: jest.fn().mockResolvedValue({}),
  appendInstallAudit: jest.fn().mockResolvedValue(undefined),
}));

import { generateFlowVisually } from '@/backend/services/flow/visualGeneration';
import type { VisualGenerationEvent } from '@/shared/types/flow/visualGeneration';

const toolReply = (name: string, args: Record<string, unknown>, id: string) => ({
  completion: {
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
    }],
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  loadFlowsMock.mockResolvedValue([]);
  gatherContextMock.mockResolvedValue({
    blocks: {
      models: [{ id: 'model-1', name: 'Generator' }],
      servers: [{
        name: 'files',
        connected: true,
        tools: [{ name: 'write_file', description: 'Write a file' }],
      }],
      flows: [],
    },
    compile: {
      models: [{ id: 'model-1', name: 'Generator' }],
      servers: [{ name: 'files' }],
      serverTools: { files: ['write_file'] },
      flows: [],
    },
    validatorServers: [{ name: 'files', status: 'connected' }],
    catalog: 'AVAILABLE MODELS\n- model-1\nAVAILABLE MCP SERVERS\n- files/write_file',
  });
  suggestToolsMock.mockResolvedValue({
    nodeId: 'preview-step',
    suggestions: [{ server: 'files', tool: 'write_file', reason: 'exports the answer' }],
    proposedPrompt: 'Write the finished answer with ${tool:files__write_file}.',
  });
  suggestAgentsMock.mockResolvedValue({ nodeId: 'preview-step', suggestions: [] });

  let controllerTurn = 0;
  let agentId = '';
  completionMock.mockImplementation(async (input: {
    messages: Array<{ role: string; content?: string }>;
  }) => {
    controllerTurn += 1;
    if (controllerTurn === 1) {
      return toolReply('create_agent', {
        name: 'Writing helper',
        goal: 'Create and save a polished answer',
      }, 'call-create');
    }
    if (controllerTurn === 2) {
      const created = JSON.parse(String(input.messages.at(-1)?.content));
      agentId = created.agentId;
      return toolReply('add_step', {
        agentId,
        stepId: 'write_answer',
        label: 'Write answer',
        task: 'Write the finished answer.',
      }, 'call-step');
    }
    if (controllerTurn === 3) {
      return toolReply('decide_suggestions', {
        agentId,
        stepId: 'write_answer',
        toolDecisions: [{
          server: 'files',
          tool: 'write_file',
          decision: 'accepted',
          reason: 'The requested output must be written to a file.',
        }],
        agentDecisions: [],
      }, 'call-decide');
    }
    if (controllerTurn === 4) {
      return toolReply('finish_agent', { agentId }, 'call-finish-agent');
    }
    return toolReply('finish_session', {}, 'call-finish-session');
  });
});

describe('visual flow generation controller', () => {
  it('streams real guided mutations, suggestion decisions, and a compiled unsaved result', async () => {
    const events: VisualGenerationEvent[] = [];
    await generateFlowVisually({
      description: 'Write my answer to a file',
      modelId: 'model-1',
      maxDepth: 8,
      allowInstall: false,
    }, (event) => events.push(event), new AbortController().signal);

    expect(events[0]).toEqual(expect.objectContaining({ type: 'session-started', maxDepth: 8 }));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'agent-created' }),
      expect.objectContaining({ type: 'step-added' }),
      expect.objectContaining({ type: 'flow-preview' }),
      expect.objectContaining({ type: 'suggestions' }),
      expect.objectContaining({
        type: 'suggestion-decision',
        decision: expect.objectContaining({
          kind: 'tool',
          decision: 'accepted',
          label: 'files / write_file',
        }),
      }),
    ]));
    const complete = events.find((event) => event.type === 'complete');
    expect(complete).toBeDefined();
    if (!complete || complete.type !== 'complete') return;
    expect(complete.result.flows).toHaveLength(1);
    expect(complete.result.validation.errorCount).toBe(0);
    expect(complete.result.flow.nodes.some((node) => node.type === 'mcp')).toBe(true);
    const previews = events.filter((event) => event.type === 'flow-preview');
    expect(previews.length).toBeGreaterThanOrEqual(2);
    expect(previews.some((event) => event.type === 'flow-preview'
      && event.flow.nodes.some((node) => node.type === 'mcp'))).toBe(true);
    expect(complete.result.flow.nodes.find((node) => node.type === 'process')?.data.properties)
      .toEqual(expect.objectContaining({ inputMode: 'full-history', outputMode: 'latest-message' }));
    expect(loadFlowsMock).not.toHaveBeenCalledWith(expect.objectContaining({ save: true }));

    const firstInput = completionMock.mock.calls[0][0];
    expect(firstInput.temperature).toBe(0);
    expect(firstInput.messages[0].content).toContain('at most 8 nested helper level(s)');
  });
});
