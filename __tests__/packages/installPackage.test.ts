/**
 * Orchestrator tests for the package install pipeline (issue #198).
 *
 * All IO boundaries are mocked at the module edge (registry fetch, MCP install,
 * model/flow/scheduler services, storage) so the orchestration logic —
 * consent dry-run, fail-soft on missing required secrets, fresh + deterministic
 * flow-id remapping, disabled planned executions, idempotent re-install — runs
 * for real without touching the network or disk. Manifests are validated
 * against the real #192 `flujoPackageSchema` (NOT mocked) so fixtures below
 * must be well-formed `FlujoPackage` documents.
 */

const fetchPackageManifestMock = jest.fn();
jest.mock('@/backend/services/packages/packageRegistry', () => ({
  fetchPackageManifest: (...a: unknown[]) => fetchPackageManifestMock(...a),
}));

const installRegistryServerMock = jest.fn();
jest.mock('@/backend/services/mcp/registryInstall', () => ({
  installRegistryServer: (...a: unknown[]) => installRegistryServerMock(...a),
}));

const loadModelsMock = jest.fn();
const addModelMock = jest.fn();
const updateModelMock = jest.fn();
jest.mock('@/backend/services/model', () => ({
  modelService: {
    loadModels: (...a: unknown[]) => loadModelsMock(...a),
    addModel: (...a: unknown[]) => addModelMock(...a),
    updateModel: (...a: unknown[]) => updateModelMock(...a),
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

const updateServerConfigMock = jest.fn();
const loadServerConfigsMock = jest.fn();
const deleteServerConfigMock = jest.fn();
jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    updateServerConfig: (...a: unknown[]) => updateServerConfigMock(...a),
    loadServerConfigs: (...a: unknown[]) => loadServerConfigsMock(...a),
    deleteServerConfig: (...a: unknown[]) => deleteServerConfigMock(...a),
  },
}));

const schedulerCreateMock = jest.fn();
const schedulerUpdateMock = jest.fn();
jest.mock('@/backend/services/scheduler', () => ({
  getSchedulerService: () => ({
    create: (...a: unknown[]) => schedulerCreateMock(...a),
    update: (...a: unknown[]) => schedulerUpdateMock(...a),
  }),
}));

// In-memory storage for the install ledger.
const store = new Map<string, unknown>();
jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async (key: string, fallback: unknown) => (store.has(key) ? store.get(key) : fallback)),
  saveItem: jest.fn(async (key: string, value: unknown) => { store.set(key, value); }),
}));

import { installPackage } from '@/backend/services/packages/installPackage';

const manifest = () => ({
  schemaVersion: 1,
  id: 'pkg-my-pkg-id',
  name: 'my-pkg',
  version: '1.0.0',
  publisher: 'acme',
  secrets: [
    { name: 'API_KEY', required: true },
    { name: 'OPT', required: false },
  ],
  mcpServers: [
    {
      name: 'web',
      transport: 'stdio',
      installOrigin: { sourceType: 'registry', ref: 'ai.keenable/web-search' },
      envDeclarations: [{ name: 'WEB_KEY', isSecret: true, secretRef: 'API_KEY' }],
    },
  ],
  models: [{ id: 'model-1', name: 'gpt-4o', displayName: 'My GPT', provider: 'openai', apiKeyRef: { kind: 'secret', secret: 'API_KEY' } }],
  flows: [
    {
      flow: {
        id: 'local-root',
        name: 'Root',
        nodes: [{ id: 'n1', data: { type: 'subflow', label: 'child', properties: { subflowId: 'local-child' } } }],
        edges: [],
      },
    },
    { flow: { id: 'local-child', name: 'Child', nodes: [], edges: [] } },
  ],
  plannedExecutions: [
    { id: 'pe-nightly', name: 'Nightly', flowId: 'local-root', prompt: 'go', enabled: true, trigger: { type: 'schedule', cron: '0 0 * * *' } },
  ],
});

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  fetchPackageManifestMock.mockResolvedValue(manifest());
  installRegistryServerMock.mockResolvedValue({ installed: true, serverName: 'web-search', tools: [{ name: 't' }] });
  loadModelsMock.mockResolvedValue([]);
  addModelMock.mockResolvedValue({ success: true });
  updateModelMock.mockResolvedValue({ success: true });
  loadFlowsMock.mockResolvedValue([]);
  saveFlowMock.mockResolvedValue({ success: true });
  updateServerConfigMock.mockResolvedValue({ name: 'x' });
  loadServerConfigsMock.mockResolvedValue([]);
  deleteServerConfigMock.mockResolvedValue({ success: true });
  schedulerCreateMock.mockResolvedValue({ execution: { id: 'x' } });
  schedulerUpdateMock.mockResolvedValue({ execution: { id: 'x' } });
});

describe('installPackage — happy path', () => {
  it('installs servers, models, flows and disabled planned executions', async () => {
    const summary = await installPackage({ source: 'registry', packageId: 'my-pkg', secrets: { API_KEY: 'sk-1' }, consentGranted: true });

    expect(summary.ok).toBe(true);
    expect(summary.dryRun).toBe(false);

    // Server: registry install called with the resolved env, recorded as created.
    expect(installRegistryServerMock).toHaveBeenCalledWith('ai.keenable/web-search', { WEB_KEY: 'sk-1' });
    expect(summary.servers[0]).toEqual(expect.objectContaining({ localName: 'web', installed: true, serverName: 'web-search' }));

    // Model: created with a fresh id and the plaintext key (addModel encrypts).
    expect(addModelMock).toHaveBeenCalledTimes(1);
    expect(addModelMock.mock.calls[0][0]).toEqual(expect.objectContaining({ displayName: 'My GPT', ApiKey: 'sk-1', provider: 'openai' }));

    // Flows: saved with fresh deterministic ids.
    expect(saveFlowMock).toHaveBeenCalledTimes(2);
    const savedIds = saveFlowMock.mock.calls.map((c) => (c[0] as { id: string }).id).sort();
    expect(savedIds).toEqual(['pkg-my-pkg-local-child', 'pkg-my-pkg-local-root']);

    // Planned execution: created disabled, with a remapped flowId.
    expect(schedulerCreateMock).toHaveBeenCalledTimes(1);
    expect(schedulerCreateMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({ id: 'pkg-my-pkg-nightly', enabled: false, flowId: 'pkg-my-pkg-local-root' }),
    );
    expect(summary.disabled.some((d) => d.type === 'plannedExecution' && d.name === 'Nightly')).toBe(true);
  });

  it('remaps a subflow reference to the freshly-installed child flow id', async () => {
    await installPackage({ source: 'registry', packageId: 'my-pkg', secrets: { API_KEY: 'sk-1' }, consentGranted: true });
    const rootSave = saveFlowMock.mock.calls.find((c) => (c[0] as { id: string }).id === 'pkg-my-pkg-local-root');
    const rootFlow = rootSave![0] as { nodes: Array<{ data: { properties: { subflowId: string } } }> };
    expect(rootFlow.nodes[0].data.properties.subflowId).toBe('pkg-my-pkg-local-child');
  });

  it('never writes a secret VALUE into the summary', async () => {
    const summary = await installPackage({ source: 'registry', packageId: 'my-pkg', secrets: { API_KEY: 'sk-SECRET' }, consentGranted: true });
    expect(JSON.stringify(summary)).not.toContain('sk-SECRET');
  });
});

describe('installPackage — consent dry-run', () => {
  it('returns a preview and mutates nothing when consent is not granted', async () => {
    const summary = await installPackage({ source: 'registry', packageId: 'my-pkg', secrets: { API_KEY: 'sk-1' } });

    expect(summary.dryRun).toBe(true);
    expect(summary.preview).toBeDefined();
    expect(summary.preview!.servers[0]).toEqual(expect.objectContaining({ localName: 'web', source: 'registry:ai.keenable/web-search' }));
    expect(summary.preview!.secrets).toEqual([
      expect.objectContaining({ key: 'API_KEY', required: true, provided: true }),
      expect.objectContaining({ key: 'OPT', required: false, provided: false }),
    ]);

    expect(installRegistryServerMock).not.toHaveBeenCalled();
    expect(addModelMock).not.toHaveBeenCalled();
    expect(saveFlowMock).not.toHaveBeenCalled();
    expect(schedulerCreateMock).not.toHaveBeenCalled();
  });
});

describe('installPackage — invalid manifest', () => {
  it('fails the whole install with errors and mutates nothing', async () => {
    fetchPackageManifestMock.mockResolvedValue({ name: 'no-schema-version' });
    const summary = await installPackage({ source: 'registry', packageId: 'x', consentGranted: true });
    expect(summary.ok).toBe(false);
    expect(summary.errors.length).toBeGreaterThan(0);
    expect(saveFlowMock).not.toHaveBeenCalled();
  });

  it('fails cleanly when the manifest fetch throws', async () => {
    fetchPackageManifestMock.mockRejectedValue(new Error('registry down'));
    const summary = await installPackage({ source: 'registry', packageId: 'x', consentGranted: true });
    expect(summary.ok).toBe(false);
    expect(summary.errors.join(' ')).toContain('registry down');
  });
});

describe('installPackage — missing required secret is fail-soft', () => {
  it('disables the dependent server and model instead of failing the install', async () => {
    const summary = await installPackage({ source: 'registry', packageId: 'my-pkg', secrets: {}, consentGranted: true });

    // Whole install still succeeds.
    expect(summary.ok).toBe(true);

    // Server: not installed (needsEnv), recorded as disabled; install NOT attempted.
    expect(installRegistryServerMock).not.toHaveBeenCalled();
    expect(summary.servers[0]).toEqual(expect.objectContaining({ localName: 'web', installed: false, needsEnv: ['WEB_KEY'] }));
    expect(summary.disabled.some((d) => d.type === 'server' && d.name === 'web')).toBe(true);

    // Model: created keyless, recorded disabled.
    expect(addModelMock.mock.calls[0][0]).toEqual(expect.objectContaining({ displayName: 'My GPT', ApiKey: '' }));
    expect(summary.disabled.some((d) => d.type === 'model' && d.name === 'My GPT')).toBe(true);
  });
});

describe('installPackage — idempotent re-install', () => {
  it('updates existing entities in place rather than duplicating', async () => {
    loadFlowsMock.mockResolvedValue([{ id: 'pkg-my-pkg-local-root' }, { id: 'pkg-my-pkg-local-child' }]);
    loadModelsMock.mockResolvedValue([{ id: 'existing-model', displayName: 'My GPT' }]);
    schedulerCreateMock.mockResolvedValue({ conflict: true, error: 'exists' });

    const summary = await installPackage({ source: 'registry', packageId: 'my-pkg', secrets: { API_KEY: 'sk-1' }, consentGranted: true });

    // Model updated (not added) under the existing id.
    expect(updateModelMock).toHaveBeenCalledTimes(1);
    expect(updateModelMock.mock.calls[0][0]).toEqual(expect.objectContaining({ id: 'existing-model', displayName: 'My GPT' }));
    expect(addModelMock).not.toHaveBeenCalled();

    // Flows recorded as updated (ids already existed).
    expect(summary.updated.filter((u) => u.type === 'flow')).toHaveLength(2);

    // Planned execution: create conflict -> update in place.
    expect(schedulerUpdateMock).toHaveBeenCalledWith('pkg-my-pkg-nightly', expect.objectContaining({ enabled: false }));
    expect(summary.updated.some((u) => u.type === 'plannedExecution')).toBe(true);
  });
});

describe('installPackage — created provenance (issue #211)', () => {
  it('records only newly-created ids in the ledger.created lists', async () => {
    await installPackage({ source: 'registry', packageId: 'my-pkg', secrets: { API_KEY: 'sk-1' }, consentGranted: true });
    const file = store.get('package_installs') as Record<string, { created?: { flows: string[]; models: string[]; servers: string[]; plannedExecutions: string[] } }>;
    const created = file['my-pkg'].created!;
    expect(created.flows.sort()).toEqual(['pkg-my-pkg-local-child', 'pkg-my-pkg-local-root']);
    expect(created.models).toHaveLength(1);
    expect(created.servers).toEqual(['web-search']);
    expect(created.plannedExecutions).toEqual(['pkg-my-pkg-nightly']);
  });

  it('does NOT record adopted/updated entities as created', async () => {
    loadFlowsMock.mockResolvedValue([{ id: 'pkg-my-pkg-local-root' }, { id: 'pkg-my-pkg-local-child' }]);
    loadModelsMock.mockResolvedValue([{ id: 'existing-model', displayName: 'My GPT' }]);
    installRegistryServerMock.mockResolvedValue({ installed: true, serverName: 'web-search', alreadyExisted: true });
    schedulerCreateMock.mockResolvedValue({ conflict: true, error: 'exists' });

    await installPackage({ source: 'registry', packageId: 'my-pkg', secrets: { API_KEY: 'sk-1' }, consentGranted: true });
    const file = store.get('package_installs') as Record<string, { created?: { flows: string[]; models: string[]; servers: string[]; plannedExecutions: string[] } }>;
    const created = file['my-pkg'].created!;
    expect(created.flows).toEqual([]);
    expect(created.models).toEqual([]);
    expect(created.servers).toEqual([]);
    expect(created.plannedExecutions).toEqual([]);
  });
});

describe('installPackage — ledger + status', () => {
  it('persists the last summary so it can be read back', async () => {
    await installPackage({ source: 'registry', packageId: 'my-pkg', secrets: { API_KEY: 'sk-1' }, consentGranted: true });
    const { getLastInstallSummary } = await import('@/backend/services/packages/installPackage');
    const last = await getLastInstallSummary('my-pkg');
    expect(last).not.toBeNull();
    expect(last!.package?.name).toBe('my-pkg');
  });
});

describe('installPackage — adopt-and-configure', () => {
  // For adopt tests, pre-populate so that the 'web' server exists before install.
  beforeEach(() => {
    loadServerConfigsMock.mockResolvedValue([{ name: 'web', transport: 'stdio', env: {} }]);
  });

  it('Test A: happy path — merges env, marks isSecret, classifies as updated not created', async () => {
    const summary = await installPackage({
      source: 'registry',
      packageId: 'my-pkg',
      secrets: { API_KEY: 'sk-1' },
      consentGranted: true,
    });

    // Registry install NOT called — adopt path took over.
    expect(installRegistryServerMock).not.toHaveBeenCalled();

    // updateServerConfig called with the merged env, isSecret tagged.
    expect(updateServerConfigMock).toHaveBeenCalledWith('web', {
      env: { WEB_KEY: { value: 'sk-1', metadata: { isSecret: true } } },
    });

    // Server classified as updated, not created.
    expect(summary.updated.some((u) => u.type === 'server' && u.name === 'web')).toBe(true);
    expect(summary.created.filter((c) => c.type === 'server')).toHaveLength(0);

    // Ledger: entities includes 'web', created does NOT.
    const file = store.get('package_installs') as Record<string, {
      entities?: { servers: string[] };
      created?: { servers: string[] };
    }>;
    expect(file['my-pkg'].created!.servers).toEqual([]);
    expect(file['my-pkg'].entities!.servers).toContain('web');
  });

  it('Test B: missing required secret — partial merge, note added, server not disabled', async () => {
    const summary = await installPackage({
      source: 'registry',
      packageId: 'my-pkg',
      secrets: {},
      consentGranted: true,
    });

    // updateServerConfig still called (partial merge, key omitted).
    expect(updateServerConfigMock).toHaveBeenCalledWith('web', expect.objectContaining({ env: expect.any(Object) }));

    // The updated entry for the server has a note mentioning the missing env name.
    const serverUpdate = summary.updated.find((u) => u.type === 'server');
    expect(serverUpdate).toBeDefined();
    expect(serverUpdate!.note).toContain('WEB_KEY');

    // Server is NOT in the disabled list.
    expect(summary.disabled.filter((d) => d.type === 'server')).toHaveLength(0);
  });

  it('Test C: updateServerConfig fails — server goes to skipped, not updated', async () => {
    updateServerConfigMock.mockResolvedValueOnce({ success: false, error: 'disk full' });

    const summary = await installPackage({
      source: 'registry',
      packageId: 'my-pkg',
      secrets: { API_KEY: 'sk-1' },
      consentGranted: true,
    });

    expect(summary.skipped.some((s) => s.type === 'server' && s.name === 'web')).toBe(true);
    expect(summary.updated.filter((u) => u.type === 'server')).toHaveLength(0);
  });

  it('Test D: remote server env declarations tag secret-derived values as isSecret', async () => {
    // Override to use a remote-server manifest (no adopt path).
    fetchPackageManifestMock.mockResolvedValue({
      schemaVersion: 1,
      id: 'pkg-remote-pkg-id',
      name: 'remote-pkg',
      version: '1.0.0',
      secrets: [{ name: 'API_KEY', required: true }],
      mcpServers: [
        {
          name: 'my-remote',
          transport: 'streamable',
          installOrigin: { sourceType: 'remote', url: 'https://example.com/mcp' },
          envDeclarations: [{ name: 'API_KEY', isSecret: true, secretRef: 'API_KEY' }],
        },
      ],
      models: [],
      flows: [],
      plannedExecutions: [],
    });
    // No pre-existing servers — remote server is a fresh upsert.
    loadServerConfigsMock.mockResolvedValue([]);

    await installPackage({
      source: 'registry',
      packageId: 'remote-pkg',
      secrets: { API_KEY: 'sk-1' },
      consentGranted: true,
    });

    expect(updateServerConfigMock).toHaveBeenCalledTimes(1);
    const config = updateServerConfigMock.mock.calls[0][1] as { env: Record<string, unknown> };
    expect(config.env['API_KEY']).toEqual({ value: 'sk-1', metadata: { isSecret: true } });
  });
});

describe('installPackage — {{secret.NAME}} placeholder resolution', () => {
  it('replaces {{secret.NAME}} with the supplied value in model, flow and planned-execution content', async () => {
    fetchPackageManifestMock.mockResolvedValue({
      schemaVersion: 1,
      id: 'pkg-placeholder-pkg-id',
      name: 'placeholder-pkg',
      version: '1.0.0',
      secrets: [{ name: 'API_KEY', required: true }],
      mcpServers: [],
      models: [{
        id: 'model-1', name: 'gpt-4o', displayName: 'My GPT', provider: 'openai',
        promptTemplate: 'Use key {{secret.API_KEY}} please', apiKeyRef: { kind: 'none' },
      }],
      flows: [{
        flow: {
          id: 'local-root', name: 'Root',
          nodes: [{ id: 'n1', data: { type: 'process', properties: { prompt: 'token={{secret.API_KEY}}' } } }],
          edges: [],
        },
      }],
      plannedExecutions: [{
        id: 'pe-1', name: 'Nightly', flowId: 'local-root', enabled: true,
        prompt: 'run with {{secret.API_KEY}}', trigger: { type: 'schedule', cron: '0 0 * * *' },
      }],
    });

    await installPackage({ source: 'registry', packageId: 'placeholder-pkg', secrets: { API_KEY: 'sk-real-value' }, consentGranted: true });

    expect(addModelMock.mock.calls[0][0]).toEqual(expect.objectContaining({ promptTemplate: 'Use key sk-real-value please' }));
    const savedFlow = saveFlowMock.mock.calls[0][0] as { nodes: Array<{ data: { properties: { prompt: string } } }> };
    expect(savedFlow.nodes[0].data.properties.prompt).toBe('token=sk-real-value');
    expect(schedulerCreateMock.mock.calls[0][0]).toEqual(expect.objectContaining({ prompt: 'run with sk-real-value' }));
  });

  it('leaves the placeholder untouched when the secret was not supplied', async () => {
    fetchPackageManifestMock.mockResolvedValue({
      schemaVersion: 1,
      id: 'pkg-placeholder-pkg-2-id',
      name: 'placeholder-pkg-2',
      version: '1.0.0',
      secrets: [{ name: 'OPT', required: false }],
      mcpServers: [],
      models: [],
      flows: [{
        flow: {
          id: 'local-root', name: 'Root',
          nodes: [{ id: 'n1', data: { type: 'process', properties: { prompt: 'token={{secret.OPT}}' } } }],
          edges: [],
        },
      }],
      plannedExecutions: [],
    });

    await installPackage({ source: 'registry', packageId: 'placeholder-pkg-2', secrets: {}, consentGranted: true });
    const savedFlow = saveFlowMock.mock.calls[0][0] as { nodes: Array<{ data: { properties: { prompt: string } } }> };
    expect(savedFlow.nodes[0].data.properties.prompt).toBe('token={{secret.OPT}}');
  });
});

describe('installPackage — process-node model binding remap', () => {
  it('remaps properties.boundModel from the manifest-local model id to the freshly-installed model id', async () => {
    fetchPackageManifestMock.mockResolvedValue({
      schemaVersion: 1,
      id: 'pkg-bound-pkg-id',
      name: 'bound-pkg',
      version: '1.0.0',
      secrets: [],
      mcpServers: [],
      models: [{ id: 'model-1', name: 'gpt-4o', displayName: 'My GPT', provider: 'openai', apiKeyRef: { kind: 'none' } }],
      flows: [{
        flow: {
          id: 'local-root', name: 'Root',
          nodes: [{ id: 'n1', data: { type: 'process', properties: { boundModel: 'model-1', modelName: 'stale-name' } } }],
          edges: [],
        },
      }],
      plannedExecutions: [],
    });
    addModelMock.mockResolvedValue({ success: true });

    await installPackage({ source: 'registry', packageId: 'bound-pkg', secrets: {}, consentGranted: true });

    const installedModelId = addModelMock.mock.calls[0][0].id as string;
    expect(installedModelId).not.toBe('model-1');
    const savedFlow = saveFlowMock.mock.calls[0][0] as { nodes: Array<{ data: { properties: { boundModel: string; modelName: string } } }> };
    expect(savedFlow.nodes[0].data.properties.boundModel).toBe(installedModelId);
    expect(savedFlow.nodes[0].data.properties.modelName).toBe('gpt-4o');
  });

  it('remaps boundModel to a pre-existing (adopted) model id, not a fresh one', async () => {
    fetchPackageManifestMock.mockResolvedValue({
      schemaVersion: 1,
      id: 'pkg-bound-pkg-2-id',
      name: 'bound-pkg-2',
      version: '1.0.0',
      secrets: [],
      mcpServers: [],
      models: [{ id: 'model-1', name: 'gpt-4o', displayName: 'My GPT', provider: 'openai', apiKeyRef: { kind: 'none' } }],
      flows: [{
        flow: {
          id: 'local-root', name: 'Root',
          nodes: [{ id: 'n1', data: { type: 'process', properties: { boundModel: 'model-1' } } }],
          edges: [],
        },
      }],
      plannedExecutions: [],
    });
    loadModelsMock.mockResolvedValue([{ id: 'existing-model-xyz', displayName: 'My GPT' }]);

    await installPackage({ source: 'registry', packageId: 'bound-pkg-2', secrets: {}, consentGranted: true });

    expect(addModelMock).not.toHaveBeenCalled();
    const savedFlow = saveFlowMock.mock.calls[0][0] as { nodes: Array<{ data: { properties: { boundModel: string } } }> };
    expect(savedFlow.nodes[0].data.properties.boundModel).toBe('existing-model-xyz');
  });
});

describe('installPackage — requiredGlobals / missingGlobals', () => {
  it('reports requiredGlobals that are not currently set as a host global var, in both preview and the final summary', async () => {
    fetchPackageManifestMock.mockResolvedValue({
      schemaVersion: 1,
      id: 'pkg-globals-pkg-id',
      name: 'globals-pkg',
      version: '1.0.0',
      requiredGlobals: ['OPENAI_KEY'],
      secrets: [],
      mcpServers: [],
      models: [{ id: 'model-1', name: 'gpt-4o', displayName: 'My GPT', provider: 'openai', apiKeyRef: { kind: 'global', var: 'OPENAI_KEY' } }],
      flows: [],
      plannedExecutions: [],
    });

    const preview = await installPackage({ source: 'registry', packageId: 'globals-pkg' });
    expect(preview.preview!.missingGlobals).toEqual(['OPENAI_KEY']);

    const summary = await installPackage({ source: 'registry', packageId: 'globals-pkg', consentGranted: true });
    expect(summary.missingGlobals).toEqual(['OPENAI_KEY']);
    // The model still installs with the literal ${global:VAR} binding — it's a
    // host-config gap, not a reason to fail-soft-disable the model itself.
    expect(addModelMock.mock.calls[0][0]).toEqual(expect.objectContaining({ ApiKey: '${global:OPENAI_KEY}' }));
  });

  it('reports no missing globals once the host has the global var set', async () => {
    store.set('global_env_vars', { OPENAI_KEY: 'sk-already-set' });
    fetchPackageManifestMock.mockResolvedValue({
      schemaVersion: 1,
      id: 'pkg-globals-pkg-2-id',
      name: 'globals-pkg-2',
      version: '1.0.0',
      requiredGlobals: ['OPENAI_KEY'],
      secrets: [],
      mcpServers: [],
      models: [],
      flows: [],
      plannedExecutions: [],
    });

    const preview = await installPackage({ source: 'registry', packageId: 'globals-pkg-2' });
    expect(preview.preview!.missingGlobals).toEqual([]);
  });
});
