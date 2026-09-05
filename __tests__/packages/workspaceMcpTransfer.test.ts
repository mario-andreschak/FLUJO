import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { MCPServerConfig } from '@/shared/types/mcp';
import type { Flow } from '@/shared/types/flow';
import type { Model } from '@/shared/types/model';

let mockWorkspace = '';
const loadConfigs = jest.fn();
const updateConfig = jest.fn();
const connect = jest.fn();
const prepareGithub = jest.fn();
const prepareRegistry = jest.fn();
const gitRaw = jest.fn();
jest.mock('simple-git', () => ({ __esModule: true, default: () => ({ raw: (...args: unknown[]) => gitRaw(...args) }) }));
jest.mock('@/utils/workspace', () => ({
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
  jest.clearAllMocks();
  mockWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-mcp-transfer-'));
  updateConfig.mockResolvedValue({ success: true });
  connect.mockResolvedValue({ success: true });
  prepareRegistry.mockResolvedValue({ config: { transport: 'stdio', command: 'npx', args: ['new-version'] } });
  prepareGithub.mockImplementation(async () => {
    const rootPath = path.join(mockWorkspace, 'mcp-servers', 'new-repo');
    await fs.mkdir(path.join(rootPath, 'dist'), { recursive: true });
    await fs.writeFile(path.join(rootPath, 'dist', 'index.js'), '// installed runtime');
    return { installed: true, config: { transport: 'stdio', rootPath, args: ['./dist/index.js'] } };
  });
});
afterEach(async () => { await fs.rm(mockWorkspace, { recursive: true, force: true }); });

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

it('starts the rebuilt bundled filesystem process and reads/writes only the target workspace', async () => {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-transfer-source-'));
  const client = new Client({ name: 'hot-clone-filesystem-smoke', version: '1.0.0' }, { capabilities: { roots: { listChanged: true } } });
  const sourceFiles = path.join(sourceRoot, 'userdata', 'files');
  const targetFiles = path.join(mockWorkspace, 'userdata', 'files');
  await fs.mkdir(sourceFiles, { recursive: true });
  await fs.mkdir(targetFiles, { recursive: true });
  const config = server({
    name: 'my-files', command: 'node', rootPath: path.join(sourceRoot, 'old-app', 'mcp-servers', 'filesystem'),
    args: [path.join(sourceRoot, 'old-app', 'mcp-servers', 'filesystem', 'dist', 'index.js')],
    source: { type: 'marketplace', id: '@mario.andreschak/mcp-filesystem' },
    env: { FLUJO_FS_ROOTS: sourceFiles }, roots: [sourceFiles],
  });
  loadConfigs.mockResolvedValue([config]);
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(targetFiles).href }] }));
  connect.mockImplementationOnce(async () => {
    const rebuilt = updateConfig.mock.calls[0][1];
    // Exercise FLUJO's actual spawn-parameter resolution, then the real SDK/process boundary.
    const { resolveStdioLaunch } = await import('@/backend/services/mcp/connection');
    const launch = resolveStdioLaunch(rebuilt);
    await client.connect(new StdioClientTransport({ ...launch, stderr: 'pipe', env: {
      ...launch.env, HOME: mockWorkspace, USERPROFILE: mockWorkspace,
    } }));
    return { success: true };
  });
  try {
    const result = await reinstallWorkspaceMcpServers(buildWorkspaceMcpTransferPlan([config], sourceRoot));
    expect(result).toEqual({ ok: true, servers: [{ name: 'my-files', status: 'ready' }] });
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['read_file', 'write_file']));
    const targetFile = path.join(targetFiles, 'worker-result.txt');
    const write = await client.callTool({ name: 'write_file', arguments: { path: targetFile, content: 'cloud-worker-smoke' } });
    expect(write.isError).not.toBe(true);
    const read = await client.callTool({ name: 'read_file', arguments: { path: targetFile } });
    expect(read.isError).not.toBe(true);
    expect(JSON.stringify(read)).toContain('cloud-worker-smoke');
    expect(await fs.readFile(targetFile, 'utf8')).toBe('cloud-worker-smoke');
    await expect(fs.access(path.join(sourceFiles, 'worker-result.txt'))).rejects.toThrow();
  } finally {
    await client.close();
    await fs.rm(sourceRoot, { recursive: true, force: true });
  }
}, 30_000);
