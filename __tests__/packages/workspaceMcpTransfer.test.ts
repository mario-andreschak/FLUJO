import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { MCPServerConfig } from '@/shared/types/mcp';
import type { Flow } from '@/shared/types/flow';
import type { Model } from '@/shared/types/model';
import { StorageKey } from '@/shared/types/storage';
import { loadServerConfigs, saveConfig } from '@/backend/services/mcp/config';
import { installBundledFixtureOwner } from '../mcp/fixtures/bundledFixtureOwner';
import { captureOwnedFixtureDirectory, removeOwnedFixtureDirectory } from '../mcp/fixtures/ownedFixtureDirectory';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { performance } from 'node:perf_hooks';

let mockWorkspace = '';
let mockWorkspaceOwnership: ReturnType<typeof captureOwnedFixtureDirectory> | undefined;
let transferCleanupUncertain = false;
let realCase: { controller: AbortController; settled: boolean; cleanupCertain: boolean; body?: Promise<void>;
  retire?: () => void; retirementFailures: unknown[] } | undefined;
const mockConfigStorage = new Map<StorageKey, unknown>();
const mockPreparedConfigs = new Map<string, MCPServerConfig>();
jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async (key: StorageKey, fallback: unknown) => mockConfigStorage.has(key) ? mockConfigStorage.get(key) : fallback),
  saveItem: jest.fn(async (key: StorageKey, value: unknown) => { mockConfigStorage.set(key, value); }),
}));
const loadConfigs = jest.fn();
const updateConfig = jest.fn();
const connect = jest.fn();
const prepareGithub = jest.fn();
const prepareRegistry = jest.fn();
const gitRaw = jest.fn();
jest.mock('simple-git', () => ({ __esModule: true, simpleGit: () => ({ raw: (...args: unknown[]) => gitRaw(...args) }) }));
jest.mock('@/utils/workspace', () => ({
  ...jest.requireActual('@/utils/workspace'),
  getWorkspaceDataDir: () => mockWorkspace,
  getCurrentWorkspace: () => 'worker',
  bindToCurrentWorkspace: (callback: unknown) => callback,
}));
jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    loadServerConfigs: (...args: unknown[]) => loadConfigs(...args),
    updateServerConfig: (...args: unknown[]) => updateConfig(...args),
    connectServer: (...args: unknown[]) => connect(...args),
  },
}));
jest.mock('@/backend/services/mcp/githubInstall', () => ({
  prepareGithubServerRuntime: (...args: unknown[]) => prepareGithub(...args),
}));
jest.mock('@/backend/services/mcp/registryInstall', () => ({
  prepareRegistryServerRuntime: (...args: unknown[]) => prepareRegistry(...args),
}));
import {
  buildWorkspaceMcpTransferPlan,
  reinstallWorkspaceMcpServers,
  pinWorkspaceMcpTransferPlan,
  selectWorkspaceFlowDependencies,
} from '@/backend/services/packages/workspaceMcpTransfer';
import { ensureShippedWorkspacePackages } from '@/backend/services/mcp/shippedWorkspacePackages';
import { createShippedServerConfig, SHIPPED_MCP_SERVERS } from '@/backend/services/mcp/shippedServers';

const source = 'C:\\desktop\\workspaces\\worker';
function server(overrides: Record<string, unknown> = {}): MCPServerConfig {
  return {
    name: 'renamed-server', transport: 'stdio', command: 'npx.cmd',
    args: ['--yes', '@example/server@1.2.3', '--flag', 'custom'],
    rootPath: `${source}\\mcp-servers\\old`, env: { LOG_LEVEL: 'debug' },
    source: { type: 'registry', registryName: 'example/server' }, disabled: false,
    _buildCommand: '', _installCommand: '', ...overrides,
  } as MCPServerConfig;
}

function flow(id: string, nodes: Array<{ type: string; properties: Record<string, unknown> }>): Flow {
  return { id, name: id, edges: [], nodes: nodes.map((node, index) => ({
    id: `${id}-${index}`, type: node.type, position: { x: 0, y: 0 }, data: { label: node.type, ...node },
  })) } as Flow;
}

it('uses package dependency closure for a selected flow, including parallel subflows and Codex models', () => {
  const needed = server({ name: 'needed' });
  const desktop = server({ name: 'desktop-only', command: 'python', source: { type: 'local' }, rootPath: 'D:\\host-files' });
  const entities = {
    flows: [flow('parent', [{ type: 'subflow', properties: { parallelSubflowIds: ['child'] } }]),
      flow('child', [{ type: 'process', properties: { boundModel: 'codex-model' } }, { type: 'mcp', properties: { boundServer: 'needed' } }])],
    models: [{ id: 'codex-model', name: 'codex', adapter: 'codex-cli', ApiKey: '' }] as Model[],
    mcpServers: [needed, desktop],
  };
  const selected = selectWorkspaceFlowDependencies(['parent'], entities);
  expect(selected.flowIds).toEqual(['parent', 'child']);
  expect(selected.modelIds).toEqual(['codex-model']);
  expect(selected.mcpServerNames).toEqual(['needed']);
  expect(selected.requiresCodexAuth).toBe(true);
  expect(selected.disabledServerNames).toEqual(['desktop-only']);
  expect(entities.mcpServers[1].disabled).toBe(false);
  expect(selected.configs[1].disabled).toBe(true);
  const plan = buildWorkspaceMcpTransferPlan(selected.configs, source, { requiredServerNames: selected.mcpServerNames });
  expect(plan.servers.map(item => item.kind)).toEqual(['registry', 'disabled']);
});

it('does not require an unrelated Codex subscription and rejects unavailable selected dependencies', () => {
  const entities = {
    flows: [flow('selected', [{ type: 'process', properties: { boundModel: 'api-model' } }])],
    models: [{ id: 'api-model', name: 'api', ApiKey: 'encrypted:api' },
      { id: 'codex-model', name: 'codex', adapter: 'codex-cli', ApiKey: '' }] as Model[],
    mcpServers: [server()],
  };
  const selected = selectWorkspaceFlowDependencies(['selected'], entities);
  expect(selected.requiresCodexAuth).toBe(false);
  expect(selected.configs[0].disabled).toBe(true);
  expect(selectWorkspaceFlowDependencies(undefined, entities).requiresCodexAuth).toBe(true);
  expect(() => selectWorkspaceFlowDependencies(['missing'], entities)).toThrow('unresolved dependencies');
  expect(() => selectWorkspaceFlowDependencies([], entities)).toThrow('at least one');
  expect(() => selectWorkspaceFlowDependencies(['selected'], { ...entities, models: [] })).toThrow('missing model');
});

it('does not silently disable unsupported, disabled, or dynamic dependencies of selected flows', () => {
  const requiredFlow = flow('selected', [{ type: 'mcp', properties: { boundServer: 'needed' } }]);
  const unsupported = server({ name: 'needed', command: 'python', source: { type: 'local' } });
  const selected = selectWorkspaceFlowDependencies(['selected'], { flows: [requiredFlow], models: [], mcpServers: [unsupported] });
  expect(selected.configs[0].disabled).toBe(false);
  expect(() => buildWorkspaceMcpTransferPlan(selected.configs, source, { requiredServerNames: selected.mcpServerNames })).toThrow('cannot be cloned');
  expect(() => selectWorkspaceFlowDependencies(['selected'], { flows: [requiredFlow], models: [], mcpServers: [{ ...unsupported, disabled: true }] })).toThrow('is disabled');
  expect(() => selectWorkspaceFlowDependencies(['dynamic'], {
    flows: [flow('dynamic', [{ type: 'subflow', properties: { parallelSubflowIdsVar: 'targets' } }])], models: [], mcpServers: [],
  })).toThrow('dynamically');
});

beforeEach(async () => {
  if (transferCleanupUncertain || (realCase && (!realCase.settled || !realCase.cleanupCertain))) throw new Error('Prior actual filesystem case remains unresolved');
  jest.clearAllMocks();
  mockConfigStorage.clear();
  mockPreparedConfigs.clear();
  mockWorkspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'flujo-mcp-transfer-'));
  mockWorkspaceOwnership = captureOwnedFixtureDirectory(mockWorkspace);
  updateConfig.mockImplementation(async (name: string, config: MCPServerConfig) => {
    mockPreparedConfigs.set(name, config);
    return saveConfig(mockPreparedConfigs);
  });
  connect.mockResolvedValue({ success: true });
  prepareRegistry.mockResolvedValue({ config: { transport: 'stdio', command: 'npx', args: ['new-version'] } });
  prepareGithub.mockImplementation(async () => {
    const rootPath = path.join(mockWorkspace, 'mcp-servers', 'new-repo');
    await fs.mkdir(path.join(rootPath, 'dist'), { recursive: true });
    await fs.writeFile(path.join(rootPath, 'dist', 'index.js'), '// installed runtime');
    return { installed: true, config: { transport: 'stdio', rootPath, args: ['./dist/index.js'] } };
  });
});
afterEach(async () => {
  transferCleanupUncertain = true;
  if (realCase && !realCase.settled) {
    realCase.controller.abort(new Error('Actual filesystem case retired by cleanup'));
    try { realCase.retire?.(); } catch (error) { realCase.retirementFailures.push(error); }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([realCase.body?.catch(() => {}), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Actual filesystem case body unsettled; owned roots preserved')), 14_000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  if (realCase && (!realCase.settled || !realCase.cleanupCertain)) throw new Error('Actual filesystem cleanup uncertain; owned roots preserved');
  if (mockWorkspaceOwnership) removeOwnedFixtureDirectory(mockWorkspaceOwnership, path.dirname(mockWorkspace), 'flujo-mcp-transfer-');
  mockWorkspaceOwnership = undefined;
  transferCleanupUncertain = false;
});

it('exports only recipes and location metadata, with no env/header credentials', () => {
  const config = server({ env: { API_KEY: { value: 'private-token', metadata: { isSecret: true } } } });
  const plan = buildWorkspaceMcpTransferPlan([config], source);
  expect(plan.servers[0]).toMatchObject({ kind: 'registry', name: config.name });
  expect(JSON.stringify(plan)).not.toContain('private-token');
  expect(JSON.stringify(plan)).not.toContain('API_KEY');
});

it('reprepares restored registry servers and preserves names, pinned args and all settings', async () => {
  const config = server({ env: {
    LOG_LEVEL: 'debug',
    TOKEN: { value: 'encrypted:opaque', metadata: { isSecret: true } },
    CACHE_DIR: `${source}\\userdata\\cache`,
  }, enableSkills: true, roots: [`${source}\\userdata`] });
  loadConfigs.mockResolvedValue([config]);
  const result = await reinstallWorkspaceMcpServers(buildWorkspaceMcpTransferPlan([config], source));
  expect(result).toEqual({ ok: true, servers: [{ name: config.name, status: 'ready' }] });
  expect(prepareRegistry).toHaveBeenCalledTimes(1);
  const restored = updateConfig.mock.calls[0][1];
  expect(restored).toMatchObject({ name: config.name, command: 'npx', args: config.transport === 'stdio' ? config.args : [], enableSkills: true });
  expect(restored.env).toEqual({ ...config.env, CACHE_DIR: path.join(mockWorkspace, 'userdata', 'cache') });
  expect(restored.rootPath).toContain(mockWorkspace);
  expect(restored.roots).toEqual([path.join(mockWorkspace, 'userdata')]);
  expect(config.rootPath).toContain('C:\\desktop');
});

it('builds GitHub runtimes using the package installer without passing stored credentials to builds', async () => {
  const originalRoot = `${source}\\mcp-servers\\old-repo`;
  const config = server({
    command: 'node', rootPath: originalRoot,
    args: [`${originalRoot}\\dist\\index.js`, '--mode', 'specific', `--cache=${source}\\userdata\\cache`],
    source: { type: 'github', repositoryUrl: 'https://github.com/acme/server', ref: 'abc123', subdirectory: 'packages/server' },
    _installCommand: 'npm ci', _buildCommand: 'npm run build',
    env: { TOKEN: { value: 'encrypted:opaque', metadata: { isSecret: true } } },
  });
  loadConfigs.mockResolvedValue([config]);
  const result = await reinstallWorkspaceMcpServers(buildWorkspaceMcpTransferPlan([config], source));
  expect(result.ok).toBe(true);
  expect(prepareGithub).toHaveBeenCalledWith(expect.objectContaining({
    name: config.name, repositoryUrl: 'https://github.com/acme/server', ref: 'abc123',
    subdirectory: 'packages/server', installCommand: 'npm ci', buildCommand: 'npm run build', env: {},
  }));
  expect(updateConfig.mock.calls[0][1].args).toEqual([
    path.join(mockWorkspace, 'mcp-servers', 'new-repo', 'dist', 'index.js'),
    '--mode', 'specific', `--cache=${path.join(mockWorkspace, 'userdata', 'cache')}`,
  ]);
});

it('reuses prepared GitHub and Registry runtimes after restart, preserving job files and private config', async () => {
  const github = server({ name: 'github', command: 'node', args: ['./dist/index.js'],
    source: { type: 'github', repositoryUrl: 'https://github.com/acme/server', ref: 'a'.repeat(40) } });
  const registry = server({ name: 'registry', env: { TOKEN: 'private-credential' } });
  const plan = buildWorkspaceMcpTransferPlan([github, registry], source);
  loadConfigs.mockResolvedValue([github, registry]);
  expect((await reinstallWorkspaceMcpServers(plan)).ok).toBe(true);
  const restored = updateConfig.mock.calls.map(call => call[1]);
  const jobFile = path.join(restored[0].rootPath, 'job-output.txt');
  await fs.writeFile(jobFile, 'preserve this worker output');
  prepareGithub.mockRejectedValue(new Error('A dirty checkout must never be reinspected on restart'));
  prepareRegistry.mockRejectedValue(new Error('Registry network is offline'));
  loadConfigs.mockResolvedValue(restored);
  expect((await reinstallWorkspaceMcpServers(plan)).ok).toBe(true);
  expect(prepareGithub).toHaveBeenCalledTimes(1);
  expect(prepareRegistry).toHaveBeenCalledTimes(1);
  expect(connect).toHaveBeenCalledTimes(4);
  expect(await fs.readFile(jobFile, 'utf8')).toBe('preserve this worker output');
  const markerRoot = path.join(mockWorkspace, 'userdata', 'mcp-runtime', 'clone-preparation');
  const markers = await Promise.all((await fs.readdir(markerRoot)).map(name => fs.readFile(path.join(markerRoot, name), 'utf8')));
  expect(markers.join('')).not.toContain('private-credential');
  expect(markers.join('')).not.toContain('TOKEN');
});

it('allows servers added to the worker after restore without reinstalling or overwriting them', async () => {
  const original = server({ disabled: true });
  const added = server({ name: 'added-later', transport: 'streamable', serverUrl: 'https://example.com/mcp' });
  const plan = buildWorkspaceMcpTransferPlan([original], source);
  loadConfigs.mockResolvedValue([original, added]);
  expect((await reinstallWorkspaceMcpServers(plan)).ok).toBe(true);
  expect(updateConfig.mock.calls.some(([name]) => name === added.name)).toBe(false);
  loadConfigs.mockResolvedValue([added]);
  await expect(reinstallWorkspaceMcpServers(plan)).rejects.toThrow('does not match');
});

it('retries failed preparation per server while retaining a successful build after handshake failure', async () => {
  const configs = [server({ name: 'prepared' }), server({ name: 'retry' })];
  const plan = buildWorkspaceMcpTransferPlan(configs, source);
  loadConfigs.mockResolvedValue(configs);
  prepareRegistry.mockResolvedValueOnce({ config: { transport: 'stdio' } }).mockRejectedValueOnce(new Error('Offline'));
  connect.mockResolvedValueOnce({ success: false });
  expect((await reinstallWorkspaceMcpServers(plan)).ok).toBe(false);
  loadConfigs.mockResolvedValue([updateConfig.mock.calls[0][1], configs[1]]);
  expect((await reinstallWorkspaceMcpServers(plan)).ok).toBe(true);
  expect(prepareRegistry).toHaveBeenCalledTimes(3);
  expect(connect).toHaveBeenCalledTimes(3);
});

it('rebuilds a missing GitHub entry and does not adopt preparation from another workspace', async () => {
  const github = server({ command: 'node', args: ['./dist/index.js'],
    source: { type: 'github', repositoryUrl: 'https://github.com/acme/server', ref: 'a'.repeat(40) } });
  const plan = buildWorkspaceMcpTransferPlan([github], source);
  loadConfigs.mockResolvedValue([github]);
  expect((await reinstallWorkspaceMcpServers(plan)).ok).toBe(true);
  const restored = updateConfig.mock.calls[0][1];
  loadConfigs.mockResolvedValue([restored]);
  await fs.unlink(path.join(restored.rootPath, 'dist', 'index.js'));
  expect((await reinstallWorkspaceMcpServers(plan)).ok).toBe(true);
  expect(prepareGithub).toHaveBeenCalledTimes(2);
  const markerRoot = path.join(mockWorkspace, 'userdata', 'mcp-runtime', 'clone-preparation');
  const markerFile = path.join(markerRoot, (await fs.readdir(markerRoot))[0]);
  const marker = JSON.parse(await fs.readFile(markerFile, 'utf8'));
  marker.rootPath = 'D:\\different-workspace\\runtime';
  await fs.writeFile(markerFile, JSON.stringify(marker));
  expect((await reinstallWorkspaceMcpServers(plan)).ok).toBe(true);
  expect(prepareGithub).toHaveBeenCalledTimes(3);
});

it('recreates renamed bundled launch paths from the worker image without Registry access', async () => {
  const config = server({
    name: 'my-browser', command: 'node', rootPath: 'C:\\desktop-app\\mcp-servers\\browser',
    args: ['C:\\desktop-app\\mcp-servers\\browser\\dist\\index.js'],
    source: { type: 'marketplace', id: '@mario.andreschak/mcp-browser' },
    env: { FLUJO_DATA_DIR: source, PLAYWRIGHT_BROWSERS_PATH: 'C:\\cache', CUSTOM_FLAG: 'keep' },
  });
  loadConfigs.mockResolvedValue([config]);
  const result = await reinstallWorkspaceMcpServers(buildWorkspaceMcpTransferPlan([config], source));
  expect(result.ok).toBe(true);
  expect(prepareRegistry).not.toHaveBeenCalled();
  const restored = updateConfig.mock.calls[0][1];
  expect(restored.name).toBe('my-browser');
  expect(restored.args[0]).not.toContain('desktop-app');
  expect(restored.env.CUSTOM_FLAG).toBe('keep');
  expect(restored.env.PLAYWRIGHT_BROWSERS_PATH).not.toBe('C:\\cache');
});

it('retains remote OAuth, headers, metadata and disabled state', async () => {
  const config = server({
    name: 'hosted', transport: 'streamable', serverUrl: 'https://mcp.example/api', disabled: true,
    headers: { 'X-Feature': 'ordinary-value', Authorization: { value: 'encrypted:secret', metadata: { isSecret: true } } },
    oauthTokens: { access_token: 'private-access', refresh_token: 'private-refresh' },
    oauthClientInformation: { client_id: 'client' }, source: { type: 'remote' },
  });
  loadConfigs.mockResolvedValue([config]);
  const plan = buildWorkspaceMcpTransferPlan([config], source);
  const result = await reinstallWorkspaceMcpServers(plan);
  expect(result.servers[0].status).toBe('disabled');
  expect(connect).not.toHaveBeenCalled();
  expect(updateConfig.mock.calls[0][1]).toMatchObject(config.transport === 'streamable' ? {
    headers: config.headers, oauthTokens: config.oauthTokens, serverUrl: config.serverUrl,
  } : {});
  expect(JSON.stringify(plan)).not.toContain('private-access');
});

it('supports directly configured package runners, but rejects arbitrary local processes and external files', () => {
  expect(buildWorkspaceMcpTransferPlan([server({ source: { type: 'local' } })], source).servers[0].kind).toBe('package-runner');
  expect(() => buildWorkspaceMcpTransferPlan([server({ command: 'python', source: { type: 'local' } })], source)).toThrow('use a GitHub');
  expect(() => buildWorkspaceMcpTransferPlan([server({ rootPath: 'D:\\external' })], source)).toThrow('outside');
  expect(() => buildWorkspaceMcpTransferPlan([server({ args: ['--config=C:\\private\\settings.json'] })], source)).toThrow('outside');
  expect(() => buildWorkspaceMcpTransferPlan([server({ launch: { command: 'node' } })], source)).toThrow('local HTTP');
  expect(() => buildWorkspaceMcpTransferPlan([server({ args: ['./local-server'] })], source)).toThrow('will not be transferred');
  expect(() => buildWorkspaceMcpTransferPlan([server({ args: ['package', `--config=${source}\\mcp-servers\\settings.json`] })], source)).toThrow('will not be transferred');
  expect(() => buildWorkspaceMcpTransferPlan([server({ roots: ['file:///D:/external'] })], source)).toThrow('outside');
});

it('retains disabled unsupported servers without installing or claiming them ready', async () => {
  const config = server({ command: 'python', source: { type: 'local' }, disabled: true, rootPath: 'D:\\external' });
  const plan = buildWorkspaceMcpTransferPlan([config], source);
  expect(plan.servers[0].kind).toBe('disabled');
  loadConfigs.mockResolvedValue([config]);
  expect(await reinstallWorkspaceMcpServers(plan)).toEqual({ ok: true, servers: [{ name: config.name, status: 'disabled' }] });
  expect(updateConfig).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
});

it('validates additional bundled arguments rather than carrying external file references', () => {
  const config = server({ command: 'node', rootPath: 'C:\\app\\mcp-servers\\browser',
    source: { type: 'marketplace', id: '@mario.andreschak/mcp-browser' },
    args: ['C:\\app\\mcp-servers\\browser\\dist\\index.js', '--config=D:\\external.json'],
  });
  expect(() => buildWorkspaceMcpTransferPlan([config], source)).toThrow('outside');
});

it('pins a clean GitHub source to its installed commit and rejects uncommitted changes', async () => {
  const config = server({ command: 'node', args: ['./dist/index.js'],
    source: { type: 'github', repositoryUrl: 'https://github.com/acme/server', ref: 'main' },
  });
  const plan = buildWorkspaceMcpTransferPlan([config], source);
  const commit = 'a'.repeat(40);
  gitRaw.mockResolvedValueOnce('').mockResolvedValueOnce(`${commit}\n`);
  const pinned = await pinWorkspaceMcpTransferPlan(plan);
  expect(pinned.servers[0].installOrigin?.gitRef).toBe(commit);
  expect(plan.servers[0].installOrigin?.gitRef).toBe('main');
  expect(gitRaw).toHaveBeenCalledWith(['--no-optional-locks', 'status', '--porcelain']);
  gitRaw.mockResolvedValueOnce(' M src/index.ts');
  await expect(pinWorkspaceMcpTransferPlan(plan)).rejects.toThrow('local changes');
});

it('reports failed readiness without echoing remote credential-bearing errors', async () => {
  const config = server();
  loadConfigs.mockResolvedValue([config]);
  connect.mockResolvedValue({ success: false, error: 'server printed private-token' });
  const result = await reinstallWorkspaceMcpServers(buildWorkspaceMcpTransferPlan([config], source));
  expect(result.ok).toBe(false);
  expect(result.servers[0].status).toBe('failed');
  expect(JSON.stringify(result)).not.toContain('private-token');
});

it('pins an unchanged workspace package and rejects source edits instead of silently discarding them', async () => {
  await ensureShippedWorkspacePackages(mockWorkspace, undefined, ['filesystem']);
  const config = createShippedServerConfig(SHIPPED_MCP_SERVERS.find(item => item.packageDirectory === 'filesystem')!);
  const plan = buildWorkspaceMcpTransferPlan([config], mockWorkspace);
  const pinned = await pinWorkspaceMcpTransferPlan(plan);
  expect(pinned.servers[0].bundledRuntimeSha256).toMatch(/^[a-f0-9]{64}$/);
  await fs.writeFile(path.join(mockWorkspace, 'mcp-servers/filesystem/local-customization.ts'), '// custom source');
  await expect(pinWorkspaceMcpTransferPlan(plan)).rejects.toThrow('local changes');
});

it('refuses to replace a pinned workspace runtime with a different worker build', async () => {
  await ensureShippedWorkspacePackages(mockWorkspace, undefined, ['filesystem']);
  const config = createShippedServerConfig(SHIPPED_MCP_SERVERS.find(item => item.packageDirectory === 'filesystem')!);
  const plan = await pinWorkspaceMcpTransferPlan(buildWorkspaceMcpTransferPlan([config], mockWorkspace));
  plan.servers[0].bundledRuntimeSha256 = '0'.repeat(64);
  loadConfigs.mockResolvedValue([config]);
  const result = await reinstallWorkspaceMcpServers(plan);
  expect(result.ok).toBe(false);
  expect(updateConfig).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
});

it('preserves genuine bundled approval on retry and refuses a revoked grant without saving', async () => {
  const descriptor = SHIPPED_MCP_SERVERS.find(value => value.packageDirectory === 'filesystem')!;
  await ensureShippedWorkspacePackages(mockWorkspace, undefined, [descriptor.packageDirectory]);
  const config = { ...createShippedServerConfig(descriptor), roots: [mockWorkspace], env: { FLUJO_FS_ROOTS: mockWorkspace } };
  const plan = buildWorkspaceMcpTransferPlan([{ ...config, disabled: false }], mockWorkspace);
  await saveConfig(new Map([[config.name, { ...config, disabled: false }]]));
  const owner = installBundledFixtureOwner();
  try {
    const { previewBundledHostConsent, approveBundledHostConsent, revokeBundledHostConsent } = await import('@/backend/services/security/bundledMcpConsent');
    const preview = await previewBundledHostConsent(config.name, { runtimeHome: 'host' });
    await approveBundledHostConsent(owner.request(config.name), config.name, {
      runtimeHome: 'host', reviewedDigest: preview.policyDigest, expiresAt: owner.expiresAt,
    });
    const loaded = await loadServerConfigs();
    if (!Array.isArray(loaded)) throw new Error('Could not load the genuine approved fixture.');
    const approved = loaded.find(value => value.name === config.name)!;
    loadConfigs.mockResolvedValue([approved]);
    expect(await reinstallWorkspaceMcpServers(plan)).toEqual({ ok: true, servers: [{ name: config.name, status: 'ready' }] });
    expect(updateConfig).not.toHaveBeenCalled();
    expect(approved.command).toBe(process.execPath);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(config.name);
    expect(await loadServerConfigs()).toEqual(loaded);
    await revokeBundledHostConsent(owner.request(config.name), config.name);
    updateConfig.mockClear();
    connect.mockClear();
    expect(await reinstallWorkspaceMcpServers(plan)).toMatchObject({ ok: false, servers: [{ name: config.name, status: 'failed' }] });
    expect(updateConfig).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(await loadServerConfigs()).toEqual(loaded);
  } finally { owner.restore(); }
}, 30_000);

it('starts the rebuilt bundled filesystem process and reads/writes only the target workspace', () => {
  const context = { controller: new AbortController(), settled: false, cleanupCertain: false,
    retirementFailures: [] } as NonNullable<typeof realCase>;
  realCase = context;
  const epoch = performance.now();
  let diagnostics = 0;
  const phase = (stage: 'source-enter' | 'source-ready' | 'reinstall-enter' | 'reinstall-ready' | 'preview-enter' | 'preview-ready'
    | 'approval-enter' | 'approval-ready' | 'transport-import-enter' | 'transport-import-ready' | 'handshake-enter' | 'handshake-ready'
    | 'tools-enter' | 'tools-ready' | 'write-enter' | 'write-ready' | 'read-enter' | 'read-ready' | 'close-enter' | 'close-ready') => {
    try { if (diagnostics++ < 64) console.info(JSON.stringify({ filesystemTransferPhase: stage, elapsedMs: performance.now() - epoch })); }
    catch { /* Diagnostic output cannot affect actual operations. */ }
  };
  const live = () => context.controller.signal.throwIfAborted();
  // Same original 30-second case budget. Retire the actual owner request and
  // managed transport; abort is not a body/child settlement witness.
  const deadline = setTimeout(() => {
    context.controller.abort(new Error('Original filesystem case deadline reached'));
    try { context.retire?.(); } catch (error) { context.retirementFailures.push(error); }
  }, 30_000);
  context.body = (async () => {
  live(); phase('source-enter');
  const sourceRoot = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'flujo-transfer-source-'));
  const sourceOwnership = captureOwnedFixtureDirectory(sourceRoot);
  phase('source-ready'); live();
  const client = new Client({ name: 'hot-clone-filesystem-smoke', version: '1.0.0' }, { capabilities: { roots: { listChanged: true } } });
  const sourceFiles = path.join(sourceRoot, 'userdata', 'files');
  const targetFiles = path.join(mockWorkspace, 'userdata', 'files');
  await fs.mkdir(sourceFiles, { recursive: true });
  live();
  await fs.mkdir(targetFiles, { recursive: true });
  live();
  const config = server({
    name: 'my-files', command: 'node', rootPath: path.join(sourceRoot, 'old-app', 'mcp-servers', 'filesystem'),
    args: [path.join(sourceRoot, 'old-app', 'mcp-servers', 'filesystem', 'dist', 'index.js')],
    source: { type: 'marketplace', id: '@mario.andreschak/mcp-filesystem' },
    env: { FLUJO_FS_ROOTS: sourceFiles }, roots: [sourceFiles],
  });
  loadConfigs.mockResolvedValue([config]);
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(targetFiles).href }] }));
  const owner = installBundledFixtureOwner();
  let child: ChildProcessWithoutNullStreams | undefined;
  let startEntered = false;
  const observed = { exit: false, close: false, stdoutEnd: false, stderrEnd: false, error: false };
  const childFailures: unknown[] = [];
  const rememberChildFailure = (error: unknown) => {
    observed.error = true;
    try { childFailures.push(error); } catch { /* Uncertainty flag survives a failed error sink. */ }
  };
  let connectionPrimary: unknown;
  let connectionFailed = false;
  connect.mockImplementationOnce(async () => {
    try {
    const rebuilt = updateConfig.mock.calls[0][1];
    live(); phase('preview-enter');
    const { previewBundledHostConsent, approveBundledHostConsent } = await import('@/backend/services/security/bundledMcpConsent');
    const preview = await previewBundledHostConsent(rebuilt.name, { runtimeHome: 'host' });
    phase('preview-ready'); live(); phase('approval-enter');
    const approved = await approveBundledHostConsent(new Request(owner.request(rebuilt.name), {
      signal: context.controller.signal,
    }), rebuilt.name, {
      runtimeHome: 'host', reviewedDigest: preview.policyDigest, expiresAt: owner.expiresAt,
    });
    phase('approval-ready'); live(); phase('transport-import-enter');
    // Exercise the managed production transport without changing its reviewed environment.
    const { createStdioTransport } = await import('@/backend/services/mcp/connection');
    const { getManagedTrustedHost } = await import('@/backend/services/mcp/trustedHost');
    phase('transport-import-ready'); live();
    const transport = createStdioTransport(approved.config);
    // Installed SDK v1 preallocates this PassThrough before start. Preserve
    // early drain and error observation as well as actual child-stream checks.
    const initialStderr = transport.stderr;
    initialStderr?.on('error', rememberChildFailure);
    initialStderr?.resume();
    context.retire = () => { getManagedTrustedHost(transport)?.retire(); };
    const start = transport.start.bind(transport);
    transport.start = async () => {
      live(); startEntered = true;
      await start();
      child = (transport as unknown as { _process?: ChildProcessWithoutNullStreams })._process;
      if (!child) throw new Error('Actual filesystem child ownership unavailable');
      observed.exit = child.exitCode !== null || child.signalCode !== null;
      observed.stdoutEnd = child.stdout.readableEnded;
      observed.stderrEnd = child.stderr.readableEnded;
      child.once('exit', () => { observed.exit = true; });
      child.once('close', () => { observed.close = true; });
      child.stdout.once('end', () => { observed.stdoutEnd = true; });
      child.stderr.once('end', () => { observed.stderrEnd = true; });
      child.on('error', rememberChildFailure);
      child.stdin.on('error', rememberChildFailure);
      child.stdout.on('error', rememberChildFailure);
      child.stderr.on('error', rememberChildFailure);
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        if (stream.errored) rememberChildFailure(stream.errored);
      }
      // Drain the actual created stderr stream after start/capture, without
      // consuming or changing stdout's SDK protocol framing.
      if (transport.stderr !== initialStderr && transport.stderr !== child.stderr) {
        transport.stderr?.on('error', rememberChildFailure);
      }
      transport.stderr?.resume();
    };
    phase('handshake-enter');
    await client.connect(transport);
    phase('handshake-ready'); live();
    return { success: true };
    } catch (error) { connectionPrimary = error; connectionFailed = true; throw error; }
  });
  let primary: unknown;
  let primaryFailed = false;
  try {
    live(); phase('reinstall-enter');
    const result = await reinstallWorkspaceMcpServers(buildWorkspaceMcpTransferPlan([config], sourceRoot));
    phase('reinstall-ready'); live();
    expect(result).toEqual({ ok: true, servers: [{ name: 'my-files', status: 'ready' }] });
    phase('tools-enter');
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['read_file', 'write_file']));
    phase('tools-ready'); live();
    const targetFile = path.join(targetFiles, 'worker-result.txt');
    phase('write-enter');
    const write = await client.callTool({ name: 'write_file', arguments: { path: targetFile, content: 'cloud-worker-smoke' } });
    phase('write-ready'); live();
    expect(write.isError).not.toBe(true);
    phase('read-enter');
    const read = await client.callTool({ name: 'read_file', arguments: { path: targetFile } });
    phase('read-ready'); live();
    expect(read.isError).not.toBe(true);
    expect(JSON.stringify(read)).toContain('cloud-worker-smoke');
    expect(await fs.readFile(targetFile, 'utf8')).toBe('cloud-worker-smoke');
    await expect(fs.access(path.join(sourceFiles, 'worker-result.txt'))).rejects.toThrow();
  } catch (error) { primary = error; primaryFailed = true; throw error; }
  finally {
    const failures: unknown[] = [];
    phase('close-enter');
    try { await client.close(); } catch (error) { failures.push(error); }
    if (startEntered) {
      const end = Date.now() + 5_000;
      while (child && !(observed.exit && observed.close && observed.stdoutEnd && observed.stderrEnd) && Date.now() < end) {
        await new Promise<void>(resolve => setTimeout(resolve, 25));
      }
      if (!child || !(observed.exit && observed.close && observed.stdoutEnd && observed.stderrEnd)) {
        failures.push(new Error('Actual filesystem child exit/close/stdio drain unresolved'));
      }
    }
    failures.push(...context.retirementFailures);
    failures.push(...childFailures);
    if (observed.error && !childFailures.length) failures.push(new Error('Actual child/stream error observed; diagnostic sink failed'));
    try { owner.restoreEnvironment(); } catch (error) { failures.push(error); }
    if (!failures.length) {
      try { owner.removeDirectory(); } catch (error) { failures.push(error); }
    }
    if (!failures.length) {
      try { removeOwnedFixtureDirectory(sourceOwnership, path.dirname(sourceRoot), 'flujo-transfer-source-'); } catch (error) { failures.push(error); }
    }
    context.cleanupCertain = failures.length === 0;
    if (failures.length) throw Object.assign(new AggregateError([
      ...(connectionFailed ? [connectionPrimary] : []), ...(primaryFailed ? [primary] : []), ...failures,
    ], 'Actual filesystem operation/cleanup failed; roots preserved', {
      cause: connectionFailed ? connectionPrimary : primary,
    }), { child, sourceRoot });
    phase('close-ready');
    // reinstall intentionally converts a connection rejection into a failed
    // result. Preserve that actual cause alongside the strict result assertion
    // even when cleanup itself succeeded; cleanup certainty stays unchanged.
    if (connectionFailed) throw new AggregateError([
      connectionPrimary, ...(primaryFailed ? [primary] : []),
    ], 'Actual filesystem connection failed after successful cleanup', { cause: connectionPrimary });
  }
  })().finally(() => { clearTimeout(deadline); context.settled = true; });
  return context.body;
}, 30_000);
