/**
 * Forgiving generation: when the model emits a spec missing a start/finish and without edges,
 * the deterministic pre-compile auto-repair (repairFlowSpec) should make it runnable in ONE
 * attempt (no model repair round), recording what it wired as advisory warnings.
 */

const getModelMock = jest.fn();
const resolveKeyMock = jest.fn();
const loadModelsMock = jest.fn();
jest.mock('@/backend/services/model', () => ({
  modelService: {
    getModel: (...a: unknown[]) => getModelMock(...a),
    resolveAndDecryptApiKey: (...a: unknown[]) => resolveKeyMock(...a),
    loadModels: (...a: unknown[]) => loadModelsMock(...a),
  },
}));

const createCompletionMock = jest.fn();
jest.mock('@/backend/services/model/adapters', () => ({
  getCompletionAdapter: () => ({ createCompletion: (...a: unknown[]) => createCompletionMock(...a) }),
}));

const loadServerConfigsMock = jest.fn();
const getServerStatusMock = jest.fn();
const listServerToolsMock = jest.fn();
jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    loadServerConfigs: (...a: unknown[]) => loadServerConfigsMock(...a),
    getServerStatus: (...a: unknown[]) => getServerStatusMock(...a),
    listServerTools: (...a: unknown[]) => listServerToolsMock(...a),
  },
}));

const loadFlowsMock = jest.fn();
jest.mock('@/backend/services/flow', () => ({
  flowService: { loadFlows: (...a: unknown[]) => loadFlowsMock(...a) },
}));

jest.mock('@/backend/services/mcp/registryInstall', () => ({
  searchRegistry: jest.fn(),
  installRegistryServer: jest.fn(),
}));

import { generateFlow } from '@/backend/services/flow/generateFlow';

const generatorModel = { id: 'model-gen', name: 'gpt-4o', displayName: 'Generator', ApiKey: 'encrypted:key', adapter: 'openai' };
const completionWith = (text: string) => ({ completion: { choices: [{ message: { content: text } }] } });

// No start, no finish, NO edges — three bare process steps in author order.
const brokenSpec = {
  name: 'pipeline',
  nodes: [
    { key: 'a', type: 'process', model: 'model-abc', prompt: 'Step one.' },
    { key: 'b', type: 'process', model: 'model-abc', prompt: 'Step two.' },
    { key: 'c', type: 'process', model: 'model-abc', prompt: 'Step three.' },
  ],
  edges: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  getModelMock.mockResolvedValue(generatorModel);
  resolveKeyMock.mockResolvedValue('sk-secret-key');
  loadModelsMock.mockResolvedValue([
    generatorModel,
    { id: 'model-abc', name: 'claude-sonnet', displayName: 'Worker', ApiKey: 'encrypted:other' },
  ]);
  loadServerConfigsMock.mockResolvedValue([]);
  getServerStatusMock.mockResolvedValue({ status: 'error' });
  listServerToolsMock.mockResolvedValue({ tools: [] });
  loadFlowsMock.mockResolvedValue([]);
  createCompletionMock.mockResolvedValue(completionWith(JSON.stringify(brokenSpec)));
});

describe('generateFlow — forgiving repair', () => {
  it('makes a start/finish/edge-less spec runnable in one attempt', async () => {
    const result = await generateFlow({ description: 'a three-step pipeline', modelId: 'model-gen' });
    expect(result.success).toBe(true);
    if (!result.success) return;

    // One model call: the deterministic repair fixed the wiring, no repair round needed.
    expect(result.attempts).toBe(1);
    expect(createCompletionMock).toHaveBeenCalledTimes(1);
    expect(result.validation.errorCount).toBe(0);

    // Start + finish were injected; the three steps got chained.
    expect(result.flow.nodes.some((n) => n.type === 'start')).toBe(true);
    expect(result.flow.nodes.some((n) => n.type === 'finish')).toBe(true);

    // The repair reported what it did as advisory warnings.
    const codes = result.validation.issues.map((i) => i.code);
    expect(codes).toContain('auto-added-start');
    expect(codes).toContain('auto-added-finish');
    expect(codes).toContain('auto-connected');
  });
});
