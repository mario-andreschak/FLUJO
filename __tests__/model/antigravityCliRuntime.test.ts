import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
let mockDataDir = '';
jest.mock('@/utils/workspace', () => ({ getWorkspaceDataDir: () => mockDataDir }));
import { prepareAntigravityCliRuntime, ANTIGRAVITY_NATIVE_DENIES } from '@/backend/services/model/adapters/antigravityCliRuntime';

let temporary: string;
let originalEnv: NodeJS.ProcessEnv;
beforeEach(async () => {
  originalEnv = { ...process.env };
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-antigravity-runtime-test-'));
  mockDataDir = path.join(temporary, 'data');
  process.env.ANTIGRAVITY_CLI_HOME = path.join(temporary, 'no-login');
});
afterEach(async () => {
  process.env = originalEnv; jest.restoreAllMocks();
  await fs.rm(temporary, { recursive: true, force: true });
});

test('isolates concurrent invocations, billing/config env, exact flow permissions and cleanup', async () => {
  Object.assign(process.env, { GOOGLE_API_KEY: 'foreign-key', GEMINI_API_KEY: 'foreign-key', GOOGLE_APPLICATION_CREDENTIALS: 'foreign.json', GOOGLE_GEMINI_BASE_URL: 'https://foreign', AGY_CLI_DISABLE_AUTO_UPDATE: '0', AGY_LLM_GATEWAY_URL: 'https://foreign', ANTIGRAVITY_LS_ADDRESS: 'foreign', JETSKI_TEST_GAIA_TOKEN: 'foreign-auth', NODE_OPTIONS: '--require foreign', GIT_DIR: 'foreign', GIT_WORK_TREE: 'foreign', GIT_CONFIG_COUNT: '9' });
  const [one, two] = await Promise.all([1, 2].map(() => prepareAntigravityCliRuntime({ model: 'default', apiKey: 'explicit-key', maxTurns: 3, bridge: { url: 'http://127.0.0.1/mcp/private', tools: ['safe_tool'] } })));
  expect(one.home).not.toBe(two.home);
  expect(one.env.GEMINI_API_KEY).toBe('explicit-key');
  for (const key of ['GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_GEMINI_BASE_URL', 'AGY_LLM_GATEWAY_URL', 'ANTIGRAVITY_LS_ADDRESS', 'JETSKI_TEST_GAIA_TOKEN', 'NODE_OPTIONS', 'ANTIGRAVITY_CLI_HOME', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_COUNT']) expect(one.env[key]).toBeUndefined();
  expect(one.env.HOME).toBe(one.home);
  expect(one.env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('true');
  expect(one.env.GIT_CONFIG_NOSYSTEM).toBe('1');
  expect(await fs.readFile(one.env.GIT_CONFIG_GLOBAL, 'utf8')).toBe('');
  expect(await fs.readFile(path.join(one.workingDirectory, '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/flujo\n');
  const settings = JSON.parse(await fs.readFile(path.join(one.home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'));
  expect(settings.modelProvider).toBe('gemini');
  expect(settings.permissions).toEqual({ allow: ['mcp(flujo/safe_tool)'], deny: ANTIGRAVITY_NATIVE_DENIES, ask: [] });
  const agent = await fs.readFile(path.join(one.workingDirectory, '.agents', 'agents', 'flujo.md'), 'utf8');
  expect(agent).toContain('inheritCustomizations: false'); expect(agent).toContain('tools: []'); expect(agent).toContain('subagent: false');
  expect(JSON.parse(await fs.readFile(path.join(one.workingDirectory, '.agents', 'mcp_config.json'), 'utf8'))).toEqual({ mcpServers: { flujo: { serverUrl: 'http://127.0.0.1/mcp/private' } } });
  await one.cleanup(); await one.cleanup();
  await expect(fs.access(one.home)).rejects.toThrow(); await expect(fs.access(two.home)).resolves.toBeUndefined(); await two.cleanup();
});

test('seeds only official account cache, strips selector and leaves source intact', async () => {
  const host = path.join(temporary, 'host'), hostCli = path.join(host, '.gemini', 'antigravity-cli');
  await fs.mkdir(hostCli, { recursive: true });
  const credentials = JSON.stringify({ token: { refresh_token: 'synthetic-refresh', access_token: 'synthetic-access' }, auth_method: 'synthetic', id_token: 'synthetic' });
  await fs.writeFile(path.join(hostCli, 'antigravity-oauth-token'), credentials);
  await fs.writeFile(path.join(hostCli, 'settings.json'), '{"permissions":{"allow":["command(*)"]}}');
  await fs.writeFile(path.join(host, '.gemini', 'GEMINI.md'), 'foreign instructions');
  process.env.ANTIGRAVITY_CLI_HOME = host;
  const runtime = await prepareAntigravityCliRuntime({ model: 'default', apiKey: '', maxTurns: 5 });
  expect(await fs.readFile(path.join(runtime.home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'utf8')).toBe(credentials);
  expect(runtime.env.ANTIGRAVITY_CLI_HOME).toBeUndefined(); expect(runtime.env.GEMINI_API_KEY).toBeUndefined();
  await expect(fs.access(path.join(runtime.home, '.gemini', 'GEMINI.md'))).rejects.toThrow();
  await runtime.cleanup(); expect(await fs.readFile(path.join(hostCli, 'antigravity-oauth-token'), 'utf8')).toBe(credentials);
});

test('missing file cache permits native keyring authentication and invalid cache fails without secret diagnostics', async () => {
  const runtime = await prepareAntigravityCliRuntime({ model: 'default', apiKey: '', maxTurns: 1 }); await runtime.cleanup();
  const cli = path.join(process.env.ANTIGRAVITY_CLI_HOME!, '.gemini', 'antigravity-cli');
  await fs.mkdir(cli, { recursive: true }); await fs.writeFile(path.join(cli, 'antigravity-oauth-token'), 'secret-invalid-json');
  await expect(prepareAntigravityCliRuntime({ model: 'default', apiKey: '', maxTurns: 1 })).rejects.toThrow(/account cache is invalid/);
  expect(await fs.readdir(path.join(mockDataDir, 'db', 'antigravity-cli-runtime'))).toEqual([]);
});

test('API-key mode ignores account cache and rejects remote/unbound bridge config', async () => {
  const cli = path.join(process.env.ANTIGRAVITY_CLI_HOME!, '.gemini', 'antigravity-cli');
  await fs.mkdir(cli, { recursive: true }); await fs.writeFile(path.join(cli, 'antigravity-oauth-token'), 'invalid-cache');
  const runtime = await prepareAntigravityCliRuntime({ model: 'default', apiKey: 'key', maxTurns: 1 }); await runtime.cleanup();
  await expect(prepareAntigravityCliRuntime({ model: 'default', apiKey: 'key', maxTurns: 1, bridge: { url: 'https://remote/mcp', tools: ['bound'] } })).rejects.toThrow(/private Antigravity tool bridge/);
});
