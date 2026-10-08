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

const installGithubServerMock = jest.fn();
jest.mock('@/backend/services/mcp/githubInstall', () => ({
  installGithubServer: (...a: unknown[]) => installGithubServerMock(...a),
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
const schedulerGetMock = jest.fn();
jest.mock('@/backend/services/scheduler', () => ({
  getSchedulerService: () => ({
    create: (...a: unknown[]) => schedulerCreateMock(...a),
    update: (...a: unknown[]) => schedulerUpdateMock(...a),
    get: (...a: unknown[]) => schedulerGetMock(...a),
  }),
}));

// In-memory storage for the install ledger.
const store = new Map<string, unknown>();
jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async (key: string, fallback: unknown) => (store.has(key) ? store.get(key) : fallback)),
  saveItem: jest.fn(async (key: string, value: unknown) => { store.set(key, value); }),
}));

import { installPackage, getLastInstallSummary, inspectPackageUninstall, uninstallPackage } from '@/backend/services/packages/installPackage';

// Independent fixed vectors for newly installed flows. Existing ledger IDs
// deliberately keep their legacy strings in the compatibility cases below.
const INSTALLED_ROOT_ID = '49dce82c2d109956d0f7ed39b135c82bbc90a9600c8b23a62f190b835150d4e1';
const INSTALLED_CHILD_ID = '1e50606c6aa171ef02d4c59c9456ce65cab80dacae561afa2e40aa168593d103';

function seedLegacyFlowInstall(createdFlows: string[] = []) {
  store.set('package_installs', { 'my-pkg': {
    packageName: 'my-pkg', version: '0.9.0', installedAt: '2026-10-03T00:00:00Z',
    entities: { flows: { 'local-root': 'pkg-my-pkg-local-root', 'local-child': 'pkg-my-pkg-local-child' },
      models: {}, servers: [], plannedExecutions: [] },
    created: { flows: createdFlows, models: [], servers: [], plannedExecutions: [] },
  } });
}

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
  models: [{
    id: 'model-1',
    name: 'gpt-5',
    displayName: 'My GPT',
    provider: 'openai',
    adapter: 'openai-responses',
    reasoningEffort: 'high',
    serviceTier: 'priority',
    supportsTools: false,
    supportedParameters: ['temperature', 'response_format'],
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    visionInputCapability: 'supported',
    compactionThreshold: 96_000,
    apiKeyRef: { kind: 'secret', secret: 'API_KEY' },
  }],
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
  installGithubServerMock.mockResolvedValue({ installed: true, serverName: 'github-server' });
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
  schedulerGetMock.mockResolvedValue(null);
});

describe('installPackage — happy path', () => {
  it('installs servers, models, flows and disabled planned executions', async () => {
    const summary = await installPackage({ source: 'registry', packageId: 'my-pkg', secrets: { API_KEY: 'sk-1' }, consentGranted: true });

    expect(summary.ok).toBe(true);
    expect(summary.dryRun).toBe(false);

    // Server: registry install called with the resolved env, recorded as created.
    expect(installRegistryServerMock).toHaveBeenCalledWith(
      'ai.keenable/web-search',
      { WEB_KEY: 'sk-1' },
      { serverName: 'web', preferredTransport: 'stdio', headerOverrides: {} },
    );
    expect(summary.servers[0]).toEqual(expect.objectContaining({ localName: 'web', installed: true, serverName: 'web-search' }));
    expect(updateServerConfigMock).toHaveBeenCalledWith('web-search', { folder: 'my-pkg' });

    // Model: created with a fresh id and the plaintext key (addModel encrypts).
    expect(addModelMock).toHaveBeenCalledTimes(1);
    expect(addModelMock.mock.calls[0][0]).toEqual(expect.objectContaining({
      displayName: 'My GPT',
      ApiKey: 'sk-1',
      provider: 'openai',
      adapter: 'openai-responses',
      reasoningEffort: 'high',
      serviceTier: 'priority',
      supportsTools: false,
      supportedParameters: ['temperature', 'response_format'],
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      visionInputCapability: 'supported',
      compactionThreshold: 96_000,
      folder: 'my-pkg',
    }));

    // Flows: saved with fresh deterministic ids in the package folder.
    expect(saveFlowMock).toHaveBeenCalledTimes(2);
    const savedIds = saveFlowMock.mock.calls.map((c) => (c[0] as { id: string }).id).sort();
    expect(savedIds).toEqual([INSTALLED_CHILD_ID, INSTALLED_ROOT_ID]);
    expect(saveFlowMock.mock.calls.every((c) => (c[0] as { folder?: string }).folder === 'my-pkg')).toBe(true);

    // Planned execution: created disabled, with a remapped flowId.
    expect(schedulerCreateMock).toHaveBeenCalledTimes(1);
    expect(schedulerCreateMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        id: 'pkg-my-pkg-nightly',
        enabled: false,
        flowId: INSTALLED_ROOT_ID,
        folder: 'my-pkg',
      }),
    );
    expect(summary.disabled.some((d) => d.type === 'plannedExecution' && d.name === 'Nightly')).toBe(true);
  });

  it('remaps a subflow reference to the freshly-installed child flow id', async () => {
    await installPackage({ source: 'registry', packageId: 'my-pkg', secrets: { API_KEY: 'sk-1' }, consentGranted: true });
    const rootSave = saveFlowMock.mock.calls.find((c) => (c[0] as { id: string }).id === INSTALLED_ROOT_ID);
    const rootFlow = rootSave![0] as { nodes: Array<{ data: { properties: { subflowId: string } } }> };
    expect(rootFlow.nodes[0].data.properties.subflowId).toBe(INSTALLED_CHILD_ID);
  });

  it('never writes a secret VALUE into the summary', async () => {
    const summary = await installPackage({ source: 'registry', packageId: 'my-pkg', secrets: { API_KEY: 'sk-SECRET' }, consentGranted: true });
    expect(JSON.stringify(summary)).not.toContain('sk-SECRET');
  });
});

describe('installPackage — Persona control-plane boundary', () => {
  it('rejects Persona target fields before installing any entity', async () => {
    const targeted = manifest();
    targeted.plannedExecutions[0] = {
      ...targeted.plannedExecutions[0],
      personaId: 'persona_support',
      behaviorSlotKey: 'primary',
    } as typeof targeted.plannedExecutions[number];
    fetchPackageManifestMock.mockResolvedValue(targeted);

    const summary = await installPackage({
      source: 'registry',
      packageId: 'my-pkg',
      consentGranted: true,
    });

    expect(summary.ok).toBe(false);
    expect(summary.errors.join(' ')).toMatch(/Persona-targeted/i);
    expect(installRegistryServerMock).not.toHaveBeenCalled();
    expect(addModelMock).not.toHaveBeenCalled();
    expect(saveFlowMock).not.toHaveBeenCalled();
    expect(schedulerCreateMock).not.toHaveBeenCalled();
    expect(schedulerUpdateMock).not.toHaveBeenCalled();
  });

  it.each([
    ['archive marker', { personaArchived: true }],
    ['retirement marker', { personaRetired: true }],
  ])('rejects a Persona %s from an untrusted manifest', async (_label, markers) => {
    const targeted = manifest();
    targeted.plannedExecutions[0] = {
      ...targeted.plannedExecutions[0],
      ...markers,
    } as typeof targeted.plannedExecutions[number];
    fetchPackageManifestMock.mockResolvedValue(targeted);

    const summary = await installPackage({
      source: 'registry',
      packageId: 'my-pkg',
      consentGranted: true,
    });

    expect(summary.ok).toBe(false);
    expect(summary.errors.join(' ')).toMatch(/Persona-targeted/i);
    expect(saveFlowMock).not.toHaveBeenCalled();
    expect(schedulerCreateMock).not.toHaveBeenCalled();
    expect(schedulerUpdateMock).not.toHaveBeenCalled();
  });

  it('rejects a deterministic-id collision with an existing Persona plan all-or-none', async () => {
    schedulerGetMock.mockResolvedValue({
      id: 'pkg-my-pkg-nightly',
      personaId: 'persona_support',
      behaviorSlotKey: 'primary',
    });

    const summary = await installPackage({
      source: 'registry',
      packageId: 'my-pkg',
      consentGranted: true,
    });

    expect(summary.ok).toBe(false);
    expect(summary.errors.join(' ')).toMatch(/protected workspace execution/i);
    expect(installRegistryServerMock).not.toHaveBeenCalled();
    expect(addModelMock).not.toHaveBeenCalled();
    expect(saveFlowMock).not.toHaveBeenCalled();
    expect(schedulerCreateMock).not.toHaveBeenCalled();
    expect(schedulerUpdateMock).not.toHaveBeenCalled();
  });

  it('rejects a deterministic-id collision with anonymized Persona evidence', async () => {
    schedulerGetMock.mockResolvedValue({
      id: 'pkg-my-pkg-nightly',
      personaArchived: true,
      personaRetired: true,
    });

    const summary = await installPackage({
      source: 'registry',
      packageId: 'my-pkg',
      consentGranted: true,
    });

    expect(summary.ok).toBe(false);
    expect(summary.errors.join(' ')).toMatch(/protected workspace execution/i);
    expect(installRegistryServerMock).not.toHaveBeenCalled();
    expect(saveFlowMock).not.toHaveBeenCalled();
    expect(schedulerCreateMock).not.toHaveBeenCalled();
    expect(schedulerUpdateMock).not.toHaveBeenCalled();
  });
});

describe('installPackage — GitHub servers', () => {
  const githubManifest = () => ({
    schemaVersion: 1,
    id: 'pkg-github-id',
    name: 'github-pkg',
    version: '1.0.0',
    secrets: [{ name: 'TOKEN', required: true }],
    mcpServers: [
      {
        name: 'github-server',
        transport: 'stdio',
        installOrigin: {
          sourceType: 'github',
          ref: 'https://github.com/acme/server.git',
          gitRef: 'v2.0.0',
          subdirectory: 'packages/server',
          installCommand: 'pnpm install --frozen-lockfile',
          buildCommand: 'pnpm run build',
        },
        envDeclarations: [
          { name: 'API_TOKEN', isSecret: true, secretRef: 'TOKEN' },
        ],
      },
    ],
    models: [],
    flows: [],
    plannedExecutions: [],
  });

  it('shows reviewed commands in preview and passes the complete recipe to the installer', async () => {
    fetchPackageManifestMock.mockResolvedValue(githubManifest());

    const preview = await installPackage({
      source: 'registry',
      packageId: 'github-pkg',
      secrets: { TOKEN: 'secret-value' },
    });
    expect(preview.preview?.servers[0]).toEqual(expect.objectContaining({
      installCommand: 'pnpm install --frozen-lockfile',
      buildCommand: 'pnpm run build',
    }));
    expect(installGithubServerMock).not.toHaveBeenCalled();

    await installPackage({
      source: 'registry',
      packageId: 'github-pkg',
      secrets: { TOKEN: 'secret-value' },
      consentGranted: true,
    });
    expect(installGithubServerMock).toHaveBeenCalledWith({
      name: 'github-server',
      repositoryUrl: 'https://github.com/acme/server.git',
      ref: 'v2.0.0',
      subdirectory: 'packages/server',
      installCommand: 'pnpm install --frozen-lockfile',
      buildCommand: 'pnpm run build',
      env: { API_TOKEN: 'secret-value' },
      secretEnvNames: ['API_TOKEN'],
      argTemplates: undefined,
      disabled: undefined,
      folder: 'github-pkg',
    });
  });

  it('adopts and configures an existing GitHub server without rebuilding it', async () => {
    fetchPackageManifestMock.mockResolvedValue(githubManifest());
    loadServerConfigsMock.mockResolvedValue([
      { name: 'github-server', transport: 'stdio', env: { KEEP: 'yes' }, args: ['dist/index.js'] },
    ]);

    const summary = await installPackage({
      source: 'registry',
      packageId: 'github-pkg',
      secrets: { TOKEN: 'secret-value' },
      consentGranted: true,
    });

    expect(installGithubServerMock).not.toHaveBeenCalled();
    expect(updateServerConfigMock).toHaveBeenCalledWith('github-server', {
      env: {
        KEEP: 'yes',
        API_TOKEN: { value: 'secret-value', metadata: { isSecret: true } },
      },
      folder: 'github-pkg',
    });
    expect(summary.updated).toContainEqual(expect.objectContaining({
      type: 'server',
      name: 'github-server',
    }));
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
    seedLegacyFlowInstall();
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
    expect(created.flows.sort()).toEqual([INSTALLED_CHILD_ID, INSTALLED_ROOT_ID]);
    expect(created.models).toHaveLength(1);
    expect(created.servers).toEqual(['web-search']);
    expect(created.plannedExecutions).toEqual(['pkg-my-pkg-nightly']);
  });

  it('does NOT record adopted/updated entities as created', async () => {
    seedLegacyFlowInstall();
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

describe('installPackage — collision-resistant flow identity', () => {
  const packageName = 'collision-probe-' + 'x'.repeat(80);
  const first = 'flow-00045416';
  const second = 'flow-00139699';
  const legacyId = 'pkg-collision-probe-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-5d8bc397';

  function collisionManifest() {
    const value = manifest();
    value.name = packageName;
    value.secrets = [];
    value.models = [];
    value.mcpServers = [];
    value.flows = [
      { flow: { id: first, name: 'First', nodes: [{ id: 'n1', data: { type: 'subflow', label: 'child', properties: { subflowId: second } } }], edges: [] } },
      { flow: { id: second, name: 'Second', nodes: [], edges: [] } },
    ];
    value.plannedExecutions = value.flows.map(({ flow }, index) => ({
      ...value.plannedExecutions[0], id: `plan-${index}`, name: `Plan ${index}`, flowId: flow.id,
    }));
    return value;
  }

  it('retains both flows from the actual 32-bit collision and separates every reference', async () => {
    fetchPackageManifestMock.mockResolvedValue(collisionManifest());
    const stored = new Map<string, { id: string; name: string }>();
    saveFlowMock.mockImplementation(async (flow: { id: string; name: string }) => {
      stored.set(flow.id, flow);
      return { success: true };
    });
    const result = await installPackage({ source: 'registry', packageId: 'collision', consentGranted: true });
    expect(result.ok).toBe(true);
    expect(stored.size).toBe(2);
    expect([...stored.values()].map((flow) => flow.name).sort()).toEqual(['First', 'Second']);
    const installedIds = saveFlowMock.mock.calls.map(([flow]) => flow.id);
    expect(new Set(installedIds).size).toBe(2);
    expect(saveFlowMock.mock.calls[0][0].nodes[0].data.properties.subflowId).toBe(installedIds[1]);
    expect(schedulerCreateMock.mock.calls.map(([plan]) => plan.flowId)).toEqual(installedIds);
    const ledger = store.get('package_installs') as Record<string, { entities: { flows: Record<string, string> } }>;
    expect(ledger[packageName].entities.flows).toEqual({ [first]: installedIds[0], [second]: installedIds[1] });
  });

  it.each([true, false])('retains legacy references and creation ownership across reinstall (provenance: %s)', async (provenance) => {
    const value = collisionManifest();
    value.flows = [value.flows[0]];
    value.flows[0].flow.nodes = [];
    value.plannedExecutions = [value.plannedExecutions[0]];
    fetchPackageManifestMock.mockResolvedValue(value);
    loadFlowsMock.mockResolvedValue([{ id: legacyId, name: 'Existing name' }]);
    const record = { entities: { flows: { [first]: legacyId } },
      ...(provenance ? { created: { flows: [legacyId], models: [], servers: [], plannedExecutions: [] } } : {}) };
    store.set('package_installs', { [packageName]: record });
    schedulerCreateMock.mockResolvedValue({ conflict: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await installPackage({ source: 'registry', packageId: 'collision', consentGranted: true,
        renames: { flows: { [first]: 'Existing name' } } });
      expect(result.ok).toBe(true);
      expect(saveFlowMock.mock.calls.at(-1)![0]).toEqual(expect.objectContaining({ id: legacyId, name: 'Existing name' }));
      expect(schedulerUpdateMock.mock.calls.at(-1)![1]).toEqual(expect.objectContaining({ flowId: legacyId, enabled: false }));
      const ledger = store.get('package_installs') as Record<string, { created: { flows: string[] } }>;
      expect(ledger[packageName].created.flows).toEqual([legacyId]);
    }
  });

  it('refuses ambiguous legacy aliases before any entity mutation and retains the ledger', async () => {
    fetchPackageManifestMock.mockResolvedValue(collisionManifest());
    const ledger = { [packageName]: { entities: { flows: { [first]: legacyId, [second]: legacyId } } } };
    store.set('package_installs', ledger);
    loadFlowsMock.mockResolvedValue([{ id: legacyId }]);
    const result = await installPackage({ source: 'registry', packageId: 'collision', consentGranted: true });
    expect(result.ok).toBe(false);
    expect(saveFlowMock).not.toHaveBeenCalled();
    expect(addModelMock).not.toHaveBeenCalled();
    expect(installRegistryServerMock).not.toHaveBeenCalled();
    expect(schedulerCreateMock).not.toHaveBeenCalled();
    expect(schedulerUpdateMock).not.toHaveBeenCalled();
    expect(store.get('package_installs')).toBe(ledger);
  });

  it('refuses an unowned occupied new ID before installing the package', async () => {
    loadFlowsMock.mockResolvedValue([{ id: INSTALLED_ROOT_ID }]);
    const result = await installPackage({ source: 'registry', packageId: 'my-pkg', consentGranted: true });
    expect(result.ok).toBe(false);
    expect(saveFlowMock).not.toHaveBeenCalled();
    expect(addModelMock).not.toHaveBeenCalled();
    expect(installRegistryServerMock).not.toHaveBeenCalled();
    expect(schedulerCreateMock).not.toHaveBeenCalled();
    expect(store.has('package_installs')).toBe(false);
  });

  it('rejects duplicate manifest-local IDs before mutation', async () => {
    const value = manifest();
    value.flows[1].flow.id = value.flows[0].flow.id;
    fetchPackageManifestMock.mockResolvedValue(value);
    const result = await installPackage({ source: 'registry', packageId: 'my-pkg', consentGranted: true });
    expect(result.ok).toBe(false);
    expect(saveFlowMock).not.toHaveBeenCalled();
    expect(addModelMock).not.toHaveBeenCalled();
    expect(installRegistryServerMock).not.toHaveBeenCalled();
    expect(schedulerCreateMock).not.toHaveBeenCalled();
  });

  it('preserves legacy mappings and creation ownership after a failed flow save', async () => {
    const ids = ['pkg-my-pkg-local-root', 'pkg-my-pkg-local-child'];
    seedLegacyFlowInstall(ids);
    loadFlowsMock.mockResolvedValue(ids.map((id) => ({ id })));
    saveFlowMock.mockResolvedValueOnce({ success: false, error: 'controlled failure' });
    const result = await installPackage({ source: 'registry', packageId: 'my-pkg', consentGranted: true });
    expect(result.skipped.some((step) => step.type === 'flow' && step.note === 'controlled failure')).toBe(true);
    const ledger = store.get('package_installs') as Record<string, { entities: { flows: Record<string, string> }; created: { flows: string[] } }>;
    expect(ledger['my-pkg'].entities.flows).toEqual({ 'local-root': ids[0], 'local-child': ids[1] });
    expect(ledger['my-pkg'].created.flows).toEqual(ids);
  });

  it('keeps an omitted legacy flow recorded so a later version reuses its references', async () => {
    const ids = ['pkg-my-pkg-local-root', 'pkg-my-pkg-local-child'];
    seedLegacyFlowInstall(ids);
    loadFlowsMock.mockResolvedValue(ids.map((id) => ({ id })));
    const value = manifest();
    value.flows = [value.flows[0]];
    fetchPackageManifestMock.mockResolvedValue(value);
    await installPackage({ source: 'registry', packageId: 'my-pkg', consentGranted: true });
    fetchPackageManifestMock.mockResolvedValue(manifest());
    await installPackage({ source: 'registry', packageId: 'my-pkg', consentGranted: true });
    expect(saveFlowMock.mock.calls.at(-1)![0].id).toBe(ids[1]);
    const ledger = store.get('package_installs') as Record<string, { created: { flows: string[] } }>;
    expect(ledger['my-pkg'].created.flows).toEqual(ids);
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
      folder: 'my-pkg',
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
    const config = updateServerConfigMock.mock.calls[0][1] as {
      env: Record<string, unknown>;
      folder?: string;
    };
    expect(config.env['API_KEY']).toEqual({ value: 'sk-1', metadata: { isSecret: true } });
    expect(config.folder).toBe('remote-pkg');
  });

  it('Test E: secret global env/header bindings stay references and retain secret metadata', async () => {
    fetchPackageManifestMock.mockResolvedValue({
      schemaVersion: 1,
      id: 'pkg-global-server-id',
      name: 'global-server-pkg',
      version: '1.0.0',
      requiredGlobals: ['GITHUB_TOKEN'],
      secrets: [],
      mcpServers: [
        {
          name: 'github',
          transport: 'streamable',
          installOrigin: { sourceType: 'remote', url: 'https://example.com/mcp' },
          envDeclarations: [
            { name: 'GITHUB_TOKEN', isSecret: true, globalVar: 'GITHUB_TOKEN' },
          ],
          headerDeclarations: [
            { name: 'Authorization', isSecret: true, globalVar: 'GITHUB_TOKEN' },
          ],
        },
      ],
      models: [],
      flows: [],
      plannedExecutions: [],
    });
    loadServerConfigsMock.mockResolvedValue([]);

    await installPackage({
      source: 'registry',
      packageId: 'global-server-pkg',
      consentGranted: true,
    });

    const config = updateServerConfigMock.mock.calls[0][1] as {
      env: Record<string, unknown>;
      headers: Record<string, unknown>;
    };
    expect(config.env.GITHUB_TOKEN).toEqual({
      value: '${global:GITHUB_TOKEN}',
      metadata: { isSecret: true },
    });
    expect(config.headers.Authorization).toEqual({
      value: '${global:GITHUB_TOKEN}',
      metadata: { isSecret: true },
    });
  });

  it('preserves an embedded global template when installing a non-secret header', async () => {
    fetchPackageManifestMock.mockResolvedValue({
      schemaVersion: 1,
      id: 'pkg-global-template-id',
      name: 'global-template-pkg',
      version: '1.0.0',
      requiredGlobals: ['GITHUB_TOKEN'],
      globals: [
        { name: 'GITHUB_TOKEN', required: true, isSecret: true },
      ],
      secrets: [],
      mcpServers: [
        {
          name: 'github',
          transport: 'streamable',
          installOrigin: { sourceType: 'remote', url: 'https://example.com/mcp' },
          envDeclarations: [],
          headerDeclarations: [
            {
              name: 'Authorization',
              isSecret: false,
              globalTemplate: 'Bearer ${global:GITHUB_TOKEN}',
            },
          ],
        },
      ],
      models: [],
      flows: [],
      plannedExecutions: [],
    });
    loadServerConfigsMock.mockResolvedValue([]);

    await installPackage({
      source: 'registry',
      packageId: 'global-template-pkg',
      consentGranted: true,
    });

    const config = updateServerConfigMock.mock.calls[0][1] as {
      headers: Record<string, unknown>;
    };
    expect(config.headers.Authorization).toBe('Bearer ${global:GITHUB_TOKEN}');
  });

  it('passes stdio global argument templates to a new registry install', async () => {
    fetchPackageManifestMock.mockResolvedValue({
      schemaVersion: 1,
      id: 'pkg-arg-template-id',
      name: 'arg-template-pkg',
      version: '1.0.0',
      requiredGlobals: ['GITHUB_TOKEN'],
      globals: [{ name: 'GITHUB_TOKEN', required: true, isSecret: true }],
      secrets: [],
      mcpServers: [
        {
          name: 'web-search',
          transport: 'stdio',
          installOrigin: { sourceType: 'registry', ref: 'ai.keenable/web-search' },
          envDeclarations: [],
          argTemplates: [
            { index: 2, value: '--token=${global:GITHUB_TOKEN}' },
          ],
        },
      ],
      models: [],
      flows: [],
      plannedExecutions: [],
    });
    loadServerConfigsMock.mockResolvedValue([]);

    await installPackage({
      source: 'registry',
      packageId: 'arg-template-pkg',
      consentGranted: true,
    });

    expect(installRegistryServerMock).toHaveBeenCalledWith(
      'ai.keenable/web-search',
      {},
      {
        argTemplates: [
          { index: 2, value: '--token=${global:GITHUB_TOKEN}' },
        ],
        preferredTransport: 'stdio',
        serverName: 'web-search',
        headerOverrides: {},
      },
    );
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

  it('substitutes a selected installed model without updating or owning it', async () => {
    const packageManifest = {
      ...manifest(),
      mcpServers: [],
      flows: [{
        flow: {
          id: 'local-root',
          name: 'Root',
          nodes: [{ id: 'n1', data: { type: 'process', properties: { boundModel: 'model-1', modelName: 'My GPT' } } }],
          edges: [],
        },
      }],
      plannedExecutions: [],
    };
    fetchPackageManifestMock.mockResolvedValue(packageManifest);
    loadModelsMock.mockResolvedValue([{ id: 'installed-claude', name: 'claude-3-7-sonnet', displayName: 'Claude' }]);

    const summary = await installPackage({
      source: 'registry',
      packageId: 'my-pkg',
      secrets: {},
      modelMappings: { 'model-1': 'installed-claude' },
      consentGranted: true,
    });

    expect(summary.ok).toBe(true);
    expect(addModelMock).not.toHaveBeenCalled();
    expect(updateModelMock).not.toHaveBeenCalled();
    const savedFlow = saveFlowMock.mock.calls[0][0] as { nodes: Array<{ data: { properties: { boundModel: string; modelName: string } } }> };
    expect(savedFlow.nodes[0].data.properties).toMatchObject({
      boundModel: 'installed-claude',
      modelName: 'claude-3-7-sonnet',
    });
    expect(summary.skipped).toContainEqual(expect.objectContaining({ type: 'model', id: 'installed-claude' }));
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

  it('treats required globals[] declarations as required without the legacy field', async () => {
    fetchPackageManifestMock.mockResolvedValue({
      schemaVersion: 1,
      id: 'pkg-declared-globals-id',
      name: 'declared-globals',
      version: '1.0.0',
      globals: [
        { name: 'REPOSITORY_URL', required: true, isSecret: false },
        { name: 'OPTIONAL_LABEL', required: false, isSecret: false },
      ],
      secrets: [],
      mcpServers: [],
      models: [],
      flows: [],
      plannedExecutions: [],
    });

    const preview = await installPackage({ source: 'registry', packageId: 'declared-globals' });
    expect(preview.preview!.globals).toEqual([
      { name: 'REPOSITORY_URL', required: true, isSecret: false },
      { name: 'OPTIONAL_LABEL', required: false, isSecret: false },
    ]);
    expect(preview.preview!.missingGlobals).toEqual(['REPOSITORY_URL']);
  });
});

describe('installPackage — public identity and credential boundary', () => {
  it.each(['package name', 'flow id', 'flow name', 'model displayName', 'plan name', 'server name'])(
    'rejects placeholder-bearing %s before accessing supplied secrets or host services', async field => {
      const pkg = manifest();
      const value = 'public-prefix-{{secret.API_KEY}}';
      if (field === 'package name') pkg.name = value;
      if (field === 'flow id') pkg.flows[0].flow.id = value;
      if (field === 'flow name') pkg.flows[0].flow.name = value;
      if (field === 'model displayName') pkg.models[0].displayName = value;
      if (field === 'plan name') pkg.plannedExecutions[0].name = value;
      if (field === 'server name') pkg.mcpServers[0].name = value;
      fetchPackageManifestMock.mockResolvedValue(pkg);
      const secretAccess = jest.fn(() => { throw new Error('synthetic secret access must not happen'); });
      const input = { source: 'registry' as const, packageId: 'fixture', consentGranted: true,
        get secrets(): Record<string, string> { return secretAccess(); } };
      const summary = await installPackage(input);
      expect(summary.ok).toBe(false);
      expect(summary.errors.join(' ')).toContain('Package identities and public labels cannot contain secret placeholders');
      expect(secretAccess).not.toHaveBeenCalled();
      for (const boundary of [loadModelsMock, loadFlowsMock, saveFlowMock, addModelMock, updateModelMock,
        schedulerGetMock, schedulerCreateMock, schedulerUpdateMock, loadServerConfigsMock,
        installRegistryServerMock, installGithubServerMock]) expect(boundary).not.toHaveBeenCalled();
      expect(store.size).toBe(0);
    },
  );

  it.each(['fresh', 'recorded legacy'])('keeps %s long public flow ids stable across different credentials without publishing the credentials in identities or ledger', async mode => {
    const localId = `public-local-${'A'.repeat(100)}`;
    const pkg = { ...manifest(), mcpServers: [], flows: [{ flow: { id: localId, name: 'Public Flow',
      nodes: [{ id: 'n1', data: { type: 'process', label: 'Public Node', properties: { prompt: '{{secret.API_KEY}}' } } }],
      edges: [] } }] };
    pkg.plannedExecutions[0].flowId = localId;
    pkg.plannedExecutions[0].prompt = '{{secret.API_KEY}}';
    fetchPackageManifestMock.mockResolvedValue(pkg);
    const savedFlows = new Map<string, unknown>();
    // Independent SHA-256 vector for new IDs; recorded legacy IDs stay owned.
    const expected = mode === 'fresh'
      ? '2f10ae1e1f300ef8341696a7e58d6ce8da6e7fb71add6fb35617a58880103412'
      : 'pkg-my-pkg-public-local-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-41b92396';
    if (mode === 'recorded legacy') {
      savedFlows.set(expected, { id: expected, name: 'Public Flow', nodes: [], edges: [] });
      store.set('package_installs', { 'my-pkg': {
        packageName: 'my-pkg', version: '0.9.0', installedAt: '2026-10-03T00:00:00Z',
        entities: { flows: { [localId]: expected }, models: {}, servers: [], plannedExecutions: [] },
        created: { flows: [expected], models: [], servers: [], plannedExecutions: [] },
      } });
    }
    loadFlowsMock.mockImplementation(async () => [...savedFlows.values()]);
    saveFlowMock.mockImplementation(async flow => { savedFlows.set(flow.id, flow); return { success: true }; });
    const first = await installPackage({ source: 'registry', packageId: 'fixture', consentGranted: true,
      secrets: { API_KEY: 'synthetic-credential-first' } });
    const second = await installPackage({ source: 'registry', packageId: 'fixture', consentGranted: true,
      secrets: { API_KEY: 'synthetic-credential-second' } });
    expect(first.ok && second.ok).toBe(true);
    expect(expected).toHaveLength(64);
    expect(saveFlowMock.mock.calls.map(([flow]) => flow.id)).toEqual([expected, expected]);
    expect(second.updated).toContainEqual({ type: 'flow', name: 'Public Flow', id: expected });
    expect(saveFlowMock.mock.calls[1][0].nodes[0].data.properties.prompt).toBe('synthetic-credential-second');
    expect(addModelMock.mock.calls[1][0].ApiKey).toBe('synthetic-credential-second');
    expect(schedulerCreateMock.mock.calls[1][0].prompt).toBe('synthetic-credential-second');
    expect(schedulerCreateMock.mock.calls[1][0].flowId).toBe(expected);
    const published = JSON.stringify({ first, second, ledger: store.get('package_installs') });
    expect(published).not.toContain('synthetic-credential-');
    expect(published).not.toContain('{{secret.');
  });

  it.each(['__proto__', 'constructor', 'toString'])('preserves own public key %s through references, renames and ledger round-trip', async key => {
    const pkg = { ...manifest(), mcpServers: [], flows: [{ flow: { id: key, name: 'Public Flow',
      nodes: [{ id: 'n1', data: { type: 'process', label: 'Public Node', properties: { boundModel: key } } }], edges: [] } }] };
    pkg.name = key;
    pkg.models[0].id = key;
    pkg.models[0].displayName = key;
    pkg.plannedExecutions[0].flowId = key;
    fetchPackageManifestMock.mockResolvedValue(pkg);
    const renamed = Object.fromEntries([[key, 'Renamed Public Flow']]);
    const summary = await installPackage({ source: 'registry', packageId: 'fixture', consentGranted: true,
      modelMappings: {}, renames: { flows: renamed }, secrets: { API_KEY: 'synthetic-key-value' } });
    expect(summary.ok).toBe(true);
    const modelId = addModelMock.mock.calls[0][0].id;
    expect(saveFlowMock.mock.calls[0][0].nodes[0].data.properties.boundModel).toBe(modelId);
    expect(saveFlowMock.mock.calls[0][0].name).toBe('Renamed Public Flow');
    const ledger = store.get('package_installs') as Record<string, any>;
    expect(Object.getPrototypeOf(ledger)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(ledger, key)).toBe(true);
    expect(ledger[key].entities.flows[key]).toBe(saveFlowMock.mock.calls[0][0].id);
    expect(ledger[key].entities.models[key]).toBe(modelId);
    store.set('package_installs', JSON.parse(JSON.stringify(ledger)));
    expect(await getLastInstallSummary(key)).toEqual(summary);
    expect((await inspectPackageUninstall(key)).exists).toBe(true);
  });

  it('keeps an own __proto__ property as data while resolving runtime content', async () => {
    const pkg = manifest();
    pkg.mcpServers = [];
    pkg.flows[0].flow.nodes[0].data.properties = JSON.parse('{"__proto__":{"fixture":"{{secret.API_KEY}}"}}');
    fetchPackageManifestMock.mockResolvedValue(pkg);
    await installPackage({ source: 'registry', packageId: 'fixture', consentGranted: true,
      secrets: { API_KEY: 'synthetic-prototype-content' } });
    const properties = saveFlowMock.mock.calls[0][0].nodes[0].data.properties;
    expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(properties, '__proto__')).toBe(true);
    expect(properties.__proto__).toEqual({ fixture: 'synthetic-prototype-content' });
    expect(properties.fixture).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).fixture).toBeUndefined();
  });

  it('ignores inherited package ledger entries for status, inspection and uninstall', async () => {
    const inherited = Object.create({ inherited: { summary: { fixture: 'untrusted' },
      entities: { flows: { f: 'unowned-flow' }, models: {}, servers: [], plannedExecutions: [] } } });
    store.set('package_installs', inherited);
    expect(await getLastInstallSummary('inherited')).toBeNull();
    expect(await inspectPackageUninstall('inherited')).toEqual({ exists: false, requiresPersonaControl: false });
    expect(await uninstallPackage('inherited')).toMatchObject({ ok: true, removed: [], skipped: [], errors: [] });
    expect(schedulerGetMock).not.toHaveBeenCalled();
    expect(store.get('package_installs')).toBe(inherited);
  });
});
