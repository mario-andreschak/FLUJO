/**
 * Orchestrator tests for the package install pipeline (issue #198).
 *
 * All IO boundaries are mocked at the module edge (registry fetch, MCP install,
 * model/flow/scheduler services, storage) so the orchestration logic —
 * consent dry-run, fail-soft on missing required secrets, fresh + deterministic
 * flow-id remapping, disabled planned executions, idempotent re-install — runs
 * for real without touching the network or disk.
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
jest.mock('@/backend/services/mcp', () => ({
  mcpService: { updateServerConfig: (...a: unknown[]) => updateServerConfigMock(...a) },
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
  schemaVersion: '1',
  name: 'my-pkg',
  version: '1.0.0',
  publisher: 'acme',
  secrets: [
    { key: 'API_KEY', required: true },
    { key: 'OPT', required: false },
  ],
  mcpServers: [
    { localName: 'web', ref: { kind: 'registry', registryName: 'ai.keenable/web-search' }, envFromSecret: { WEB_KEY: 'API_KEY' } },
  ],
  models: [{ name: 'gpt-4o', displayName: 'My GPT', provider: 'openai', apiKeySecret: 'API_KEY' }],
  flows: [
    {
      id: 'local-root',
      name: 'Root',
      nodes: [{ id: 'n1', data: { type: 'subflow', label: 'child', properties: { subflowId: 'local-child' } } }],
      edges: [],
    },
    { id: 'local-child', name: 'Child', nodes: [], edges: [] },
  ],
  plannedExecutions: [{ name: 'Nightly', flowId: 'local-root', prompt: 'go', trigger: { type: 'schedule', cron: '0 0 * * *' } }],
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

describe('installPackage — ledger + status', () => {
  it('persists the last summary so it can be read back', async () => {
    await installPackage({ source: 'registry', packageId: 'my-pkg', secrets: { API_KEY: 'sk-1' }, consentGranted: true });
    const { getLastInstallSummary } = await import('@/backend/services/packages/installPackage');
    const last = await getLastInstallSummary('my-pkg');
    expect(last).not.toBeNull();
    expect(last!.package?.name).toBe('my-pkg');
  });
});
