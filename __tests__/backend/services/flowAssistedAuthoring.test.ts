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
