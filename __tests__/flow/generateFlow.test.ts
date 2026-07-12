/**
 * Tests for the LLM flow generator (issue #14): context gathering (no key leakage, no
 * spawning offline servers), JSON extraction from messy model output, the compile →
 * validate → repair loop, and the draft-not-persisted contract.
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

import { generateFlow, extractJsonObject } from '@/backend/services/flow/generateFlow';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const generatorModel = { id: 'model-gen', name: 'gpt-4o', displayName: 'Generator', ApiKey: 'encrypted:key', adapter: 'openai' };

const goodSpec = {
  name: 'research_flow',
  description: 'Researches and answers',
  nodes: [
    { key: 's', type: 'start', prompt: 'You are a researcher.' },
    {
      key: 'p',
      type: 'process',
      label: 'Researcher',
      model: 'model-abc',
      prompt: 'Do the research.',
      servers: [{ name: 'brave-search', tools: ['web_search'] }],
    },
    { key: 'f', type: 'finish' },
  ],
  edges: [
    { from: 's', to: 'p' },
    { from: 'p', to: 'f' },
  ],
};

const completionWith = (text: string) => ({ completion: { choices: [{ message: { content: text } }] } });

beforeEach(() => {
  jest.clearAllMocks();
  getModelMock.mockResolvedValue(generatorModel);
  resolveKeyMock.mockResolvedValue('sk-secret-key');
  loadModelsMock.mockResolvedValue([
    generatorModel,
    { id: 'model-abc', name: 'claude-sonnet', displayName: 'Worker', ApiKey: 'encrypted:other', description: 'the workhorse' },
  ]);
  loadServerConfigsMock.mockResolvedValue([
    { name: 'brave-search' },
    { name: 'offline-srv' },
    { name: 'disabled-srv', disabled: true },
  ]);
  getServerStatusMock.mockImplementation(async (name: string) => ({
    status: name === 'brave-search' ? 'connected' : 'error',
  }));
  listServerToolsMock.mockResolvedValue({
    tools: [
      { name: 'web_search', description: 'Search the web' },
      { name: 'news_search', description: 'Search news' },
    ],
  });
  loadFlowsMock.mockResolvedValue([
    { id: 'flow-1', name: 'Summarizer', description: 'Summarizes text', nodes: [], edges: [] },
  ]);
  createCompletionMock.mockResolvedValue(completionWith(JSON.stringify(goodSpec)));
  searchRegistryMock.mockResolvedValue([]);
  installRegistryServerMock.mockResolvedValue({ installed: false, error: 'not mocked' });
});

// ---------------------------------------------------------------------------
// extractJsonObject
// ---------------------------------------------------------------------------

describe('extractJsonObject', () => {
  it('parses a bare JSON object', () => {
    expect(extractJsonObject('{"a": 1}')).toEqual({ a: 1 });
  });

  it('strips code fences and prefaces', () => {
    expect(extractJsonObject('Here is your flow:\n```json\n{"a": {"b": 2}}\n```\nEnjoy!')).toEqual({ a: { b: 2 } });
  });

  it('is not fooled by braces inside strings', () => {
    expect(extractJsonObject('{"prompt": "use {curly} braces \\" and } even escaped"}')).toEqual({
      prompt: 'use {curly} braces " and } even escaped',
    });
  });

  it('returns null when there is no JSON object', () => {
    expect(extractJsonObject('Sorry, I cannot do that.')).toBeNull();
    expect(extractJsonObject('{"unterminated": ')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('generateFlow — happy path', () => {
  it('returns a clean draft in one attempt', async () => {
    const result = await generateFlow({ description: 'Build me a research flow', modelId: 'model-gen' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.attempts).toBe(1);
    expect(result.validation.errorCount).toBe(0);
    expect(result.flow.name).toBe('research_flow');
    expect(result.flow.nodes.map((n) => n.type).sort()).toEqual(['finish', 'mcp', 'process', 'start']);
  });

  it('parses a fenced, prefaced model reply', async () => {
    createCompletionMock.mockResolvedValue(
      completionWith('Sure! Here it is:\n```json\n' + JSON.stringify(goodSpec) + '\n```')
    );
    const result = await generateFlow({ description: 'x', modelId: 'model-gen' });
    expect(result.success).toBe(true);
  });

  it('calls the adapter with temperature 0 and the sampling recipe (getModel → key → completion)', async () => {
    await generateFlow({ description: 'x', modelId: 'model-gen' });
    expect(getModelMock).toHaveBeenCalledWith('model-gen');
    expect(resolveKeyMock).toHaveBeenCalledWith('encrypted:key');
    const input = createCompletionMock.mock.calls[0][0];
    expect(input.temperature).toBe(0);
    expect(input.apiKey).toBe('sk-secret-key');
    expect(input.messages[0].role).toBe('system');
    expect(input.messages[1]).toEqual({ role: 'user', content: 'x' });
  });

  it('never persists the draft', async () => {
    await generateFlow({ description: 'x', modelId: 'model-gen' });
    expect(saveFlowMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Context gathering
// ---------------------------------------------------------------------------

describe('generateFlow — context gathering', () => {
  async function systemPrompt(): Promise<string> {
    await generateFlow({ description: 'x', modelId: 'model-gen' });
    return createCompletionMock.mock.calls[0][0].messages[0].content as string;
  }

  it('catalogs models, connected-server tools, and existing flows', async () => {
    const prompt = await systemPrompt();
    expect(prompt).toContain('model-abc');
    expect(prompt).toContain('Worker');
    expect(prompt).toContain('web_search — Search the web');
    expect(prompt).toContain('"Summarizer" — Summarizes text');
  });

  it('lists an offline server by name only and never asks it for tools', async () => {
    const prompt = await systemPrompt();
    expect(prompt).toContain('offline-srv (offline');
    expect(listServerToolsMock).toHaveBeenCalledTimes(1);
    expect(listServerToolsMock).toHaveBeenCalledWith('brave-search');
  });

  it('skips disabled servers entirely', async () => {
    const prompt = await systemPrompt();
    expect(prompt).not.toContain('disabled-srv');
    expect(getServerStatusMock).not.toHaveBeenCalledWith('disabled-srv');
  });

  it('leaks no API key material into the prompt', async () => {
    const prompt = await systemPrompt();
    expect(prompt).not.toContain('sk-secret-key');
    expect(prompt).not.toContain('encrypted:key');
    expect(prompt).not.toContain('encrypted:other');
    expect(prompt).not.toContain('ApiKey');
  });
});

// ---------------------------------------------------------------------------
// Repair loop
// ---------------------------------------------------------------------------

describe('generateFlow — repair loop', () => {
  it('feeds validation errors back and succeeds on the repaired spec', async () => {
    const brokenSpec = {
      ...goodSpec,
      nodes: goodSpec.nodes.map((n) => (n.key === 'p' ? { ...n, model: 'no-such-model' } : n)),
    };
    createCompletionMock
      .mockResolvedValueOnce(completionWith(JSON.stringify(brokenSpec)))
      .mockResolvedValueOnce(completionWith(JSON.stringify(goodSpec)));

    const result = await generateFlow({ description: 'x', modelId: 'model-gen' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.attempts).toBe(2);
    expect(result.validation.errorCount).toBe(0);

    // The second call must carry the first reply + the error feedback.
    const secondMessages = createCompletionMock.mock.calls[1][0].messages;
    expect(secondMessages).toHaveLength(4);
    expect(secondMessages[2].role).toBe('assistant');
    const feedback = secondMessages[3].content as string;
    expect(secondMessages[3].role).toBe('user');
    expect(feedback).toContain('[error]');
    expect(feedback).toContain('no-such-model');
  });

  it('retries when the reply has no JSON at all', async () => {
    createCompletionMock
      .mockResolvedValueOnce(completionWith('I would love to help but let me explain flows first...'))
      .mockResolvedValueOnce(completionWith(JSON.stringify(goodSpec)));
    const result = await generateFlow({ description: 'x', modelId: 'model-gen' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.attempts).toBe(2);
  });

  it('returns the best draft WITH its issues when the repair budget is exhausted', async () => {
    const brokenSpec = {
      ...goodSpec,
      nodes: goodSpec.nodes.map((n) => (n.key === 'p' ? { ...n, model: 'no-such-model' } : n)),
    };
    createCompletionMock.mockResolvedValue(completionWith(JSON.stringify(brokenSpec)));
    const result = await generateFlow({ description: 'x', modelId: 'model-gen', maxRepairs: 1 });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.attempts).toBe(2);
    expect(result.validation.errorCount).toBeGreaterThan(0);
    expect(result.validation.isRunnable).toBe(false);
    expect(result.validation.issues.map((i) => i.code)).toContain('process-model-missing');
  });

  it('caps maxRepairs at 2', async () => {
    createCompletionMock.mockResolvedValue(completionWith('no json here'));
    const result = await generateFlow({ description: 'x', modelId: 'model-gen', maxRepairs: 99 });
    expect(result.success).toBe(false);
    expect(createCompletionMock).toHaveBeenCalledTimes(3); // 1 + capped 2 repairs
  });

  it('fails 422 when no attempt produces a usable spec', async () => {
    createCompletionMock.mockResolvedValue(completionWith('still no json'));
    const result = await generateFlow({ description: 'x', modelId: 'model-gen' });
    expect(result).toEqual(expect.objectContaining({ success: false, statusCode: 422 }));
  });
});

// ---------------------------------------------------------------------------
// Hard failures
// ---------------------------------------------------------------------------

describe('generateFlow — hard failures', () => {
  it('400 on missing description or modelId', async () => {
    expect(await generateFlow({ description: '  ', modelId: 'model-gen' })).toEqual(
      expect.objectContaining({ success: false, statusCode: 400 })
    );
    expect(await generateFlow({ description: 'x', modelId: '' })).toEqual(
      expect.objectContaining({ success: false, statusCode: 400 })
    );
  });

  it('404 when the generator model does not exist', async () => {
    getModelMock.mockResolvedValue(null);
    expect(await generateFlow({ description: 'x', modelId: 'ghost' })).toEqual(
      expect.objectContaining({ success: false, statusCode: 404 })
    );
  });

  it('500 when the API key cannot be resolved', async () => {
    resolveKeyMock.mockResolvedValue(null);
    expect(await generateFlow({ description: 'x', modelId: 'model-gen' })).toEqual(
      expect.objectContaining({ success: false, statusCode: 500 })
    );
  });

  it('502 when the adapter call throws', async () => {
    createCompletionMock.mockRejectedValue(new Error('Premature close'));
    const result = await generateFlow({ description: 'x', modelId: 'model-gen' });
    expect(result).toEqual(expect.objectContaining({ success: false, statusCode: 502 }));
    if (result.success) return;
    expect(result.error).toContain('Premature close');
  });

  it('context load failures degrade gracefully instead of failing the generation', async () => {
    loadServerConfigsMock.mockRejectedValue(new Error('mcp down'));
    loadFlowsMock.mockRejectedValue(new Error('storage hiccup'));
    const specNoServers = {
      ...goodSpec,
      nodes: goodSpec.nodes.map((n) => (n.key === 'p' ? { ...n, servers: [] } : n)),
    };
    createCompletionMock.mockResolvedValue(completionWith(JSON.stringify(specNoServers)));
    const result = await generateFlow({ description: 'x', modelId: 'model-gen' });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Capability acquisition — marketplace search / install tool loop
// ---------------------------------------------------------------------------

describe('generateFlow — marketplace tools', () => {
  const toolCallCompletion = (name: string, args: object, id = 'call_1') => ({
    completion: {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
          },
        },
      ],
    },
  });

  it('always offers search; offers install ONLY with allowInstall', async () => {
    await generateFlow({ description: 'x', modelId: 'model-gen' });
    const withoutInstall = (createCompletionMock.mock.calls[0][0].tools ?? []).map(
      (t: { function: { name: string } }) => t.function.name
    );
    expect(withoutInstall).toEqual(['search_mcp_marketplace']);

    createCompletionMock.mockClear();
    await generateFlow({ description: 'x', modelId: 'model-gen', allowInstall: true });
    const withInstall = (createCompletionMock.mock.calls[0][0].tools ?? []).map(
      (t: { function: { name: string } }) => t.function.name
    );
    expect(withInstall).toEqual(['search_mcp_marketplace', 'install_mcp_server']);
  });

  it('search → install → spec: executes the tools, reports installs, and re-gathers context', async () => {
    const specWithNewServer = {
      ...goodSpec,
      nodes: goodSpec.nodes.map((n) =>
        n.key === 'p' ? { ...n, servers: [{ name: 'voice', tools: ['sing'] }] } : n
      ),
    };
    searchRegistryMock.mockResolvedValue([
      { name: 'io.github.acme/voice', description: 'TTS', installable: true, requiredEnv: [] },
    ]);
    installRegistryServerMock.mockResolvedValue({
      installed: true,
      serverName: 'voice',
      tools: [{ name: 'sing' }],
    });
    // After the install, the re-gathered context must include the new server.
    loadServerConfigsMock
      .mockResolvedValueOnce([{ name: 'brave-search' }, { name: 'offline-srv' }, { name: 'disabled-srv', disabled: true }])
      .mockResolvedValue([{ name: 'brave-search' }, { name: 'voice' }]);
    getServerStatusMock.mockResolvedValue({ status: 'connected' });
    listServerToolsMock.mockImplementation(async (name: string) => ({
      tools: name === 'voice' ? [{ name: 'sing', description: 'sings' }] : [{ name: 'web_search' }],
    }));

    createCompletionMock
      .mockResolvedValueOnce(toolCallCompletion('search_mcp_marketplace', { query: 'voice' }))
      .mockResolvedValueOnce(toolCallCompletion('install_mcp_server', { name: 'io.github.acme/voice' }, 'call_2'))
      .mockResolvedValueOnce(completionWith(JSON.stringify(specWithNewServer)));

    const result = await generateFlow({ description: 'sing me a song', modelId: 'model-gen', allowInstall: true });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(searchRegistryMock).toHaveBeenCalledWith('voice');
    expect(installRegistryServerMock).toHaveBeenCalledWith('io.github.acme/voice');
    expect(result.installedServers).toEqual([{ name: 'voice', tools: ['sing'] }]);
    // The freshly installed server validates clean (no server-unknown warning).
    expect(result.validation.errorCount).toBe(0);
    expect(result.validation.issues.map((i) => i.code)).not.toContain('server-unknown');

    // Tool results were appended as role:'tool' messages tied to the call ids.
    const finalMessages = createCompletionMock.mock.calls[2][0].messages;
    const toolMessages = finalMessages.filter((m: { role: string }) => m.role === 'tool');
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0].tool_call_id).toBe('call_1');
  });

  it('refuses install when allowInstall is off, even if the model tries', async () => {
    createCompletionMock
      .mockResolvedValueOnce(toolCallCompletion('install_mcp_server', { name: 'x/y' }))
      .mockResolvedValueOnce(completionWith(JSON.stringify(goodSpec)));
    const result = await generateFlow({ description: 'x', modelId: 'model-gen' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(installRegistryServerMock).not.toHaveBeenCalled();
    expect(result.installedServers).toEqual([]);
    // The refusal reached the model as the tool result.
    const toolMsg = createCompletionMock.mock.calls[1][0].messages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMsg.content).toContain('not allowed');
  });

  it('withdraws tools after the turn budget and demands the spec', async () => {
    createCompletionMock.mockImplementation(async (input: { tools?: unknown[] }) => {
      if (input.tools && input.tools.length > 0) {
        return toolCallCompletion('search_mcp_marketplace', { query: 'loop' });
      }
      return completionWith(JSON.stringify(goodSpec));
    });
    const result = await generateFlow({ description: 'x', modelId: 'model-gen', allowInstall: true });
    expect(result.success).toBe(true);
    // Bounded: search ran at most MAX_TOOL_TURNS times, then the spec was demanded.
    expect(searchRegistryMock.mock.calls.length).toBeLessThanOrEqual(8);
  });

  it('a search failure is fed to the model as an error result, not thrown', async () => {
    searchRegistryMock.mockRejectedValue(new Error('registry down'));
    createCompletionMock
      .mockResolvedValueOnce(toolCallCompletion('search_mcp_marketplace', { query: 'voice' }))
      .mockResolvedValueOnce(completionWith(JSON.stringify(goodSpec)));
    const result = await generateFlow({ description: 'x', modelId: 'model-gen' });
    expect(result.success).toBe(true);
    const toolMsg = createCompletionMock.mock.calls[1][0].messages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMsg.content).toContain('registry down');
  });
});
