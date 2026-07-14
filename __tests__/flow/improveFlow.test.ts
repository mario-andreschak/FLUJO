/**
 * Tests for the LLM flow improver (issue #99): the current flow is serialized into the
 * prompt, the model returns a revised spec, and the result keeps the flow's identity
 * (same id, same name unless renamed) and its node layout. Reuses the generate machinery,
 * so this suite focuses on what's new to improve.
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
const saveFlowMock = jest.fn();
jest.mock('@/backend/services/flow', () => ({
  flowService: {
    loadFlows: (...a: unknown[]) => loadFlowsMock(...a),
    saveFlow: (...a: unknown[]) => saveFlowMock(...a),
  },
}));

const searchRegistryMock = jest.fn();
const installRegistryServerMock = jest.fn();
jest.mock('@/backend/services/mcp/registryInstall', () => ({
  searchRegistry: (...a: unknown[]) => searchRegistryMock(...a),
  installRegistryServer: (...a: unknown[]) => installRegistryServerMock(...a),
}));

import { improveFlow } from '@/backend/services/flow/generateFlow';
import { compileFlowSpec, flowToSpec, FlowSpec, CompileContext } from '@/utils/shared/flowSpecCompiler';
import type { Flow } from '@/shared/types/flow';

// ---------------------------------------------------------------------------
// Fixtures — a valid existing flow, built with the same context the mocks expose
// ---------------------------------------------------------------------------

const generatorModel = { id: 'model-gen', name: 'gpt-4o', displayName: 'Generator', ApiKey: 'encrypted:key', adapter: 'openai' };

const buildContext: CompileContext = {
  models: [{ id: 'model-abc', name: 'claude-sonnet', displayName: 'Worker' }],
  servers: [{ name: 'brave-search' }],
  serverTools: { 'brave-search': ['web_search'] },
  flows: [{ id: 'flow-1', name: 'Summarizer' }],
};

const existingSpec: FlowSpec = {
  name: 'my_flow',
  description: 'the original',
  nodes: [
    { key: 's', type: 'start', label: 'Start', prompt: 'You are helpful.' },
    {
      key: 'p',
      type: 'process',
      label: 'Researcher',
      model: 'model-abc',
      prompt: 'Do research.',
      servers: [{ name: 'brave-search', tools: ['web_search'] }],
      inputMode: 'latest-message',
      outputMode: 'latest-message',
    },
    { key: 'f', type: 'finish', label: 'Done' },
  ],
  edges: [
    { from: 's', to: 'p' },
    { from: 'p', to: 'f' },
  ],
};

function makeExistingFlow(): Flow {
  const flow = compileFlowSpec(existingSpec, buildContext).flow!;
  flow.id = 'flow-existing';
  flow.name = 'my_flow';
  // Distinctive positions so layout preservation is observable.
  flow.nodes.forEach((n, i) => {
    n.position = { x: 500 + i * 11, y: 600 + i * 17 };
  });
  return flow;
}

const completionWith = (text: string) => ({ completion: { choices: [{ message: { content: text } }] } });

beforeEach(() => {
  jest.clearAllMocks();
  getModelMock.mockResolvedValue(generatorModel);
  resolveKeyMock.mockResolvedValue('sk-secret-key');
  loadModelsMock.mockResolvedValue([
    generatorModel,
    { id: 'model-abc', name: 'claude-sonnet', displayName: 'Worker', ApiKey: 'encrypted:other' },
  ]);
  loadServerConfigsMock.mockResolvedValue([{ name: 'brave-search' }]);
  getServerStatusMock.mockResolvedValue({ status: 'connected' });
  listServerToolsMock.mockResolvedValue({ tools: [{ name: 'web_search', description: 'Search the web' }] });
  loadFlowsMock.mockResolvedValue([
    { id: 'flow-1', name: 'Summarizer', description: 'Summarizes text', nodes: [], edges: [] },
    { id: 'flow-existing', name: 'my_flow', description: 'the original', nodes: [], edges: [] },
  ]);
  searchRegistryMock.mockResolvedValue([]);
  installRegistryServerMock.mockResolvedValue({ installed: false, error: 'not mocked' });
});

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

describe('improveFlow — prompt', () => {
  it('injects the serialized current flow and the change request into the user prompt', async () => {
    const flow = makeExistingFlow();
    createCompletionMock.mockResolvedValue(completionWith(JSON.stringify(flowToSpec(flow))));

    await improveFlow({ flow, description: 'rename the finish node to End', modelId: 'model-gen' });

    const userMsg = createCompletionMock.mock.calls[0][0].messages[1];
    expect(userMsg.role).toBe('user');
    expect(userMsg.content).toContain('CHANGE REQUEST');
    expect(userMsg.content).toContain('rename the finish node to End');
    // The existing flow is present as a FlowSpec (keyed by the flow's node ids).
    expect(userMsg.content).toContain('"nodes"');
    expect(userMsg.content).toContain('Researcher');
    expect(userMsg.content).toContain(flow.nodes[0].id);
  });

  it('uses the sampling recipe (getModel → key → completion) at temperature 0', async () => {
    const flow = makeExistingFlow();
    createCompletionMock.mockResolvedValue(completionWith(JSON.stringify(flowToSpec(flow))));
    await improveFlow({ flow, description: 'x', modelId: 'model-gen' });
    expect(getModelMock).toHaveBeenCalledWith('model-gen');
    expect(resolveKeyMock).toHaveBeenCalledWith('encrypted:key');
    const input = createCompletionMock.mock.calls[0][0];
    expect(input.temperature).toBe(0);
    expect(input.apiKey).toBe('sk-secret-key');
  });

  it('leaks no API key material into the prompt', async () => {
    const flow = makeExistingFlow();
    createCompletionMock.mockResolvedValue(completionWith(JSON.stringify(flowToSpec(flow))));
    await improveFlow({ flow, description: 'x', modelId: 'model-gen' });
    const prompt = JSON.stringify(createCompletionMock.mock.calls[0][0].messages);
    expect(prompt).not.toContain('sk-secret-key');
    expect(prompt).not.toContain('encrypted:');
  });
});

// ---------------------------------------------------------------------------
// Identity + layout preservation
// ---------------------------------------------------------------------------

describe('improveFlow — identity & layout', () => {
  it('keeps the flow id and name when the model returns the same spec', async () => {
    const flow = makeExistingFlow();
    createCompletionMock.mockResolvedValue(completionWith(JSON.stringify(flowToSpec(flow))));

    const result = await improveFlow({ flow, description: 'no-op tidy up', modelId: 'model-gen' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.attempts).toBe(1);
    expect(result.flow.id).toBe('flow-existing');
    expect(result.flow.name).toBe('my_flow');
    expect(result.flows).toHaveLength(1);
    expect(result.rootFlowId).toBe('flow-existing');
    expect(result.validation.errorCount).toBe(0);
  });

  it('preserves unchanged node positions', async () => {
    const flow = makeExistingFlow();
    const researcher = flow.nodes.find((n) => n.data.label === 'Researcher')!;
    const originalPos = { ...researcher.position };
    createCompletionMock.mockResolvedValue(completionWith(JSON.stringify(flowToSpec(flow))));

    const result = await improveFlow({ flow, description: 'x', modelId: 'model-gen' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const researcher2 = result.flow.nodes.find((n) => n.data.label === 'Researcher')!;
    expect(researcher2.position).toEqual(originalPos);
  });

  it('forces the flow id back to the original even if the model renames the flow', async () => {
    const flow = makeExistingFlow();
    const renamed = { ...flowToSpec(flow), name: 'renamed_flow' };
    createCompletionMock.mockResolvedValue(completionWith(JSON.stringify(renamed)));

    const result = await improveFlow({ flow, description: 'rename it', modelId: 'model-gen' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.flow.id).toBe('flow-existing'); // identity preserved
    expect(result.flow.name).toBe('renamed_flow'); // an explicit rename is honoured
  });

  it('never persists the revised draft', async () => {
    const flow = makeExistingFlow();
    createCompletionMock.mockResolvedValue(completionWith(JSON.stringify(flowToSpec(flow))));
    await improveFlow({ flow, description: 'x', modelId: 'model-gen' });
    expect(saveFlowMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Repair loop
// ---------------------------------------------------------------------------

describe('improveFlow — repair loop', () => {
  it('feeds validation errors back and succeeds on the repaired spec', async () => {
    const flow = makeExistingFlow();
    const good = flowToSpec(flow);
    const broken: FlowSpec = {
      ...good,
      nodes: good.nodes.map((n) => (n.label === 'Researcher' ? { ...n, model: 'no-such-model' } : n)),
    };
    createCompletionMock
      .mockResolvedValueOnce(completionWith(JSON.stringify(broken)))
      .mockResolvedValueOnce(completionWith(JSON.stringify(good)));

    const result = await improveFlow({ flow, description: 'x', modelId: 'model-gen' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.attempts).toBe(2);
    expect(result.validation.errorCount).toBe(0);
    const feedback = createCompletionMock.mock.calls[1][0].messages.slice(-1)[0].content as string;
    expect(feedback).toContain('no-such-model');
  });

  it('returns the best draft with issues when the repair budget is exhausted', async () => {
    const flow = makeExistingFlow();
    const good = flowToSpec(flow);
    const broken: FlowSpec = {
      ...good,
      nodes: good.nodes.map((n) => (n.label === 'Researcher' ? { ...n, model: 'no-such-model' } : n)),
    };
    createCompletionMock.mockResolvedValue(completionWith(JSON.stringify(broken)));
    const result = await improveFlow({ flow, description: 'x', modelId: 'model-gen', maxRepairs: 1 });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.attempts).toBe(2);
    expect(result.validation.errorCount).toBeGreaterThan(0);
    expect(result.validation.issues.map((i) => i.code)).toContain('process-model-missing');
  });
});

// ---------------------------------------------------------------------------
// Hard failures / input validation
// ---------------------------------------------------------------------------

describe('improveFlow — input validation & failures', () => {
  it('400 on a missing change description', async () => {
    expect(await improveFlow({ flow: makeExistingFlow(), description: '  ', modelId: 'model-gen' })).toEqual(
      expect.objectContaining({ success: false, statusCode: 400 })
    );
  });

  it('400 on a missing model id', async () => {
    expect(await improveFlow({ flow: makeExistingFlow(), description: 'x', modelId: '' })).toEqual(
      expect.objectContaining({ success: false, statusCode: 400 })
    );
  });

  it('400 on an invalid flow', async () => {
    expect(await improveFlow({ flow: {} as Flow, description: 'x', modelId: 'model-gen' })).toEqual(
      expect.objectContaining({ success: false, statusCode: 400 })
    );
  });

  it('404 when the generator model does not exist', async () => {
    getModelMock.mockResolvedValue(null);
    expect(await improveFlow({ flow: makeExistingFlow(), description: 'x', modelId: 'ghost' })).toEqual(
      expect.objectContaining({ success: false, statusCode: 404 })
    );
  });

  it('502 when the adapter call throws', async () => {
    createCompletionMock.mockRejectedValue(new Error('Premature close'));
    const result = await improveFlow({ flow: makeExistingFlow(), description: 'x', modelId: 'model-gen' });
    expect(result).toEqual(expect.objectContaining({ success: false, statusCode: 502 }));
  });

  it('422 when no attempt yields a usable spec', async () => {
    createCompletionMock.mockResolvedValue(completionWith('no json here'));
    const result = await improveFlow({ flow: makeExistingFlow(), description: 'x', modelId: 'model-gen' });
    expect(result).toEqual(expect.objectContaining({ success: false, statusCode: 422 }));
  });
});
