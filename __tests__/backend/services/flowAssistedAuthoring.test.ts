import type { Flow } from '@/shared/types/flow';

const completionMock = jest.fn();
const loadFlowsMock = jest.fn();
const gatherContextMock = jest.fn();

jest.mock('@/backend/services/model', () => ({
  modelService: {
    getModel: jest.fn().mockResolvedValue({ id: 'model-1', name: 'Helper', adapter: 'openai', ApiKey: 'encrypted' }),
    resolveAndDecryptApiKey: jest.fn().mockResolvedValue('secret'),
  },
}));
jest.mock('@/backend/services/model/adapters', () => ({
  getCompletionAdapter: () => ({ createCompletion: (...args: unknown[]) => completionMock(...args) }),
}));
jest.mock('@/backend/services/flow', () => ({
  flowService: { loadFlows: (...args: unknown[]) => loadFlowsMock(...args) },
}));
jest.mock('@/backend/services/scheduler', () => ({
  getSchedulerService: () => ({ list: jest.fn().mockResolvedValue([]) }),
}));
jest.mock('@/backend/services/flow/generationContext', () => ({
  gatherGenerationContext: (...args: unknown[]) => gatherContextMock(...args),
}));

import {
  checkFlowPlausibility,
  generateFlowName,
  improvePromptForFlowStep,
  suggestAgentsForFlowStep,
  suggestToolsForFlowStep,
} from '@/backend/services/flow/assistedAuthoring';

const processFlow = (id: string, prompt: string): Flow => ({
  id,
  name: id,
  nodes: [{
    id: `${id}-work`,
    type: 'process',
    position: { x: 0, y: 0 },
    data: {
      label: 'Work',
      type: 'process',
      properties: { promptTemplate: prompt, inputMode: 'latest-message' },
    },
  }],
  edges: [],
});

beforeEach(() => {
  jest.clearAllMocks();
  loadFlowsMock.mockResolvedValue([]);
  gatherContextMock.mockResolvedValue({
    blocks: {
      models: [{ id: 'model-1', name: 'Helper' }],
      servers: [{
        name: 'files',
        connected: true,
        tools: [
          { name: 'read_file', description: 'Read a file' },
          { name: 'write_file', description: 'Write a file' },
        ],
      }],
      flows: [],
    },
    compile: {
      models: [{ id: 'model-1', name: 'Helper' }],
      servers: [{ name: 'files' }],
      serverTools: { files: ['read_file', 'write_file'] },
      flows: [],
    },
    validatorServers: [{ name: 'files', status: 'connected' }],
    catalog: '',
  });
});

describe('assisted flow authoring service', () => {
  it('generates a valid, unique name from the first workflow goal', async () => {
    completionMock.mockResolvedValueOnce({
      completion: { choices: [{ message: { content: '{"name":"Notes Helper!"}' } }] },
    });

    await expect(generateFlowName({
      flow: processFlow('root', 'Summarize my notes in friendly language'),
      modelId: 'model-1',
      existingNames: ['Notes Helper'],
    })).resolves.toEqual({ name: 'Notes Helper 2' });
  });

  it('keeps only exact connected tool suggestions and respects an explicit empty answer', async () => {
    completionMock.mockResolvedValueOnce({
      completion: { choices: [{ message: { content: JSON.stringify({
        suggestions: [
          { server: 'files', tool: 'read_file', reason: 'needed' },
          { server: 'files', tool: 'delete_disk', reason: 'invented' },
        ],
        proposedPrompt: 'Read it.',
      }) } }] },
    });
    const first = await suggestToolsForFlowStep({
      flow: processFlow('root', 'Read a file'),
      nodeId: 'root-work',
      modelId: 'model-1',
    });
    expect(first.suggestions).toEqual([{ server: 'files', tool: 'read_file', reason: 'needed' }]);

    completionMock.mockResolvedValueOnce({
      completion: { choices: [{ message: { content: '{"suggestions":[],"proposedPrompt":"Read a file"}' } }] },
    });
    const second = await suggestToolsForFlowStep({
      flow: processFlow('root', 'Read a file'),
      nodeId: 'root-work',
      modelId: 'model-1',
    });
    expect(second.suggestions).toEqual([]);
  });

  it('reconsiders the connected catalog with the prior proposal and user feedback', async () => {
    const root = processFlow('root', 'Export the notes');
    root.nodes.push({
      id: 'child-call',
      type: 'subflow',
      position: { x: 0, y: 100 },
      data: { label: 'Writer', type: 'subflow', properties: { subflowId: 'child' } },
    });
    const child = processFlow('child', 'Fresh unsaved child prompt');
    child.nodes.push({
      id: 'grandchild-call',
      type: 'subflow',
      position: { x: 0, y: 100 },
      data: { label: 'Researcher', type: 'subflow', properties: { subflowId: 'grandchild' } },
    });
    loadFlowsMock.mockResolvedValue([
      processFlow('child', 'STALE child prompt'),
      processFlow('grandchild', 'Research supporting facts'),
    ]);
    const previousSuggestion = {
      nodeId: 'root-work',
      suggestions: [{ server: 'files', tool: 'read_file', reason: 'read notes' }],
      proposedPrompt: 'Read with ${tool:files__read_file}.',
    };
    completionMock.mockResolvedValueOnce({
      completion: { choices: [{ message: { content: JSON.stringify({
        suggestions: [{ server: 'files', tool: 'write_file', reason: 'exports the result' }],
        proposedPrompt: 'Export with ${tool:files__write_file}.',
        assistantMessage: 'The write tool is a better fit for the requested export.',
      }) } }] },
    });

    const result = await suggestToolsForFlowStep({
      flow: root,
      relatedFlows: [child],
      nodeId: 'root-work',
      modelId: 'model-1',
      feedback: ['There may be one tool that handles the whole export.'],
      previousSuggestion,
    });

    const request = completionMock.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const userPayload = JSON.parse(request.messages[1].content);
    expect(userPayload).toEqual(expect.objectContaining({
      feedback: ['There may be one tool that handles the whole export.'],
      previousSuggestion,
    }));
    expect(userPayload.connectedTools[0].tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'read_file' }),
      expect.objectContaining({ name: 'write_file' }),
    ]));
    expect(userPayload.workflowTree.map((entry: { id: string }) => entry.id))
      .toEqual(['root', 'child', 'grandchild']);
    expect(userPayload.workflowTree[1].nodes[0].prompt).toBe('Fresh unsaved child prompt');
    expect(result.suggestions).toEqual([
      { server: 'files', tool: 'write_file', reason: 'exports the result' },
    ]);
    expect(result.assistantMessage).toBe('The write tool is a better fit for the requested export.');
  });

  it('keeps only exact saved-agent suggestions and excludes the current flow', async () => {
    gatherContextMock.mockResolvedValueOnce({
      blocks: {
        models: [{ id: 'model-1', name: 'Helper' }],
        servers: [],
        flows: [
          { id: 'root', name: 'Current', nodeCount: 1 },
          { id: 'writer', name: 'Writer', description: 'Drafts polished copy', nodeCount: 3 },
        ],
      },
      compile: { models: [], servers: [], serverTools: {}, flows: [] },
      validatorServers: [],
      catalog: '',
    });
    completionMock.mockResolvedValueOnce({
      completion: { choices: [{ message: { content: JSON.stringify({
        suggestions: [
          { flowId: 'writer', reason: 'draft the final copy' },
          { flowId: 'missing', reason: 'invented' },
          { flowId: 'root', reason: 'self reference' },
        ],
      }) } }] },
    });

    await expect(suggestAgentsForFlowStep({
      flow: processFlow('root', 'Draft polished copy'),
      nodeId: 'root-work',
      modelId: 'model-1',
    })).resolves.toEqual({
      nodeId: 'root-work',
      suggestions: [{ flowId: 'writer', flowName: 'Writer', reason: 'draft the final copy' }],
    });
  });

  it('preserves connected references when improving a prompt', async () => {
    const root = processFlow('root', 'Read with ${tool:files__read_file}.');
    root.nodes.push({
      id: 'child-call',
      type: 'subflow',
      position: { x: 0, y: 100 },
      data: { label: 'Child', type: 'subflow', properties: { subflowId: 'child' } },
    });
    const child = processFlow('child', 'Handle the delegated work');
    completionMock.mockResolvedValueOnce({
      completion: { choices: [{ message: { content: '{"prompt":"Read the source carefully and summarize it."}' } }] },
    });

    const result = await improvePromptForFlowStep({
      flow: root,
      relatedFlows: [child],
      nodeId: 'root-work',
      modelId: 'model-1',
    });

    expect(result.prompt).toContain('Read the source carefully');
    expect(result.prompt).toContain('${tool:files__read_file}');
    const request = completionMock.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const userPayload = JSON.parse(request.messages[1].content);
    expect(userPayload.workflowTree.map((entry: { id: string }) => entry.id)).toEqual(['root', 'child']);
  });

  it('appends validated handoff conditions at the end of an improved prompt', async () => {
    const root = processFlow('root', 'Check whether there are GitHub issues to plan.');
    root.nodes.push(
      {
        id: 'convert',
        type: 'process',
        position: { x: -100, y: 100 },
        data: {
          label: 'Convert GitHub Issues to Plans',
          type: 'process',
          description: 'Convert discovered issues into implementation plans.',
          properties: {},
        },
      },
      {
        id: 'available',
        type: 'process',
        position: { x: 100, y: 100 },
        data: {
          label: 'Plan Available',
          type: 'process',
          description: 'Continue when a plan is already available.',
          properties: {},
        },
      },
    );
    root.edges = [
      {
        id: 'empty',
        source: 'root-work',
        target: 'convert',
        data: { edgeType: 'standard', condition: { kind: 'equals', value: 'EMPTY', ignoreCase: true } },
      },
      {
        id: 'not-empty',
        source: 'root-work',
        target: 'available',
        data: { edgeType: 'standard' },
      },
    ];
    completionMock.mockResolvedValueOnce({
      completion: { choices: [{ message: { content: JSON.stringify({
        prompt: 'Inspect the GitHub issue list. Ignore ${handoff:invented}.',
        handoffConditions: [
          {
            toolName: 'handoff_to_convert_github_issues_to_plans',
            condition: 'If the issue list IS empty',
          },
          {
            toolName: 'handoff_to_plan_available',
            condition: 'If the issue list is NOT empty',
          },
          { toolName: 'handoff_to_invented', condition: 'Always' },
        ],
      }) } }] },
    });

    const result = await improvePromptForFlowStep({
      flow: root,
      nodeId: 'root-work',
      modelId: 'model-1',
    });
    const request = completionMock.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const userPayload = JSON.parse(request.messages[1].content);

    expect(userPayload.handoffs).toEqual([
      expect.objectContaining({
        toolName: 'handoff_to_convert_github_issues_to_plans',
        targetLabel: 'Convert GitHub Issues to Plans',
        edgeCondition: expect.objectContaining({ kind: 'equals', value: 'EMPTY' }),
      }),
      expect.objectContaining({
        toolName: 'handoff_to_plan_available',
        targetLabel: 'Plan Available',
      }),
    ]);
    expect(result.prompt).not.toContain('${handoff:invented}');
    expect(result.prompt).toMatch(/Handoff conditions:\n- If the issue list IS empty, hand off to \$\{tool:handoff__handoff_to_convert_github_issues_to_plans\}\.\n- If the issue list is NOT empty, hand off to \$\{tool:handoff__handoff_to_plan_available\}\.$/);
  });

  it('uses unsaved descendants over stored copies and repairs the referenced bundle', async () => {
    const root = processFlow('root', 'Root prompt');
    root.nodes.push({
      id: 'child-call',
      type: 'subflow',
      position: { x: 0, y: 100 },
      data: { label: 'Child', type: 'subflow', properties: { subflowId: 'child' } },
    });
    const storedChild = processFlow('child', 'STALE stored prompt');
    const draftChild = processFlow('child', 'Fresh draft prompt');
    loadFlowsMock.mockResolvedValue([storedChild]);

    const result = await checkFlowPlausibility({ flow: root, relatedFlows: [draftChild] });
    const repairedChild = result.repairedFlows.find((flow) => flow.id === 'child');
    expect(result.repairedFlows.map((flow) => flow.id)).toEqual(['root', 'child']);
    expect(repairedChild?.nodes[0].data.properties).toEqual(expect.objectContaining({
      promptTemplate: 'Fresh draft prompt',
      inputMode: 'full-history',
      outputMode: 'latest-message',
    }));
  });
});
