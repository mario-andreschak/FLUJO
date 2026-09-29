import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
let mockDataDir = '';
jest.mock('@/utils/workspace', () => ({ getWorkspaceDataDir: () => mockDataDir }));
import { prepareGeminiCliRuntime } from '@/backend/services/model/adapters/geminiCliRuntime';

let temporary: string;
let originalEnv: NodeJS.ProcessEnv;
beforeEach(async () => {
  originalEnv = { ...process.env };
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-gemini-runtime-test-'));
  mockDataDir = path.join(temporary, 'data');
});
afterEach(async () => {
  process.env = originalEnv;
  jest.restoreAllMocks();
  await fs.rm(temporary, { recursive: true, force: true });
});

test('isolates concurrent invocations, billing env, configs and cleanup', async () => {
  process.env.GOOGLE_API_KEY = 'foreign-google-key';
  process.env.GEMINI_API_KEY = 'foreign-gemini-key';
  process.env.GOOGLE_APPLICATION_CREDENTIALS = 'foreign-adc.json';
  process.env.NODE_OPTIONS = '--require foreign-hook';
  const [one, two] = await Promise.all([1, 2].map(() => prepareGeminiCliRuntime({ model: 'flash', apiKey: 'explicit-key', maxTurns: 3, bridge: { url: 'http://127.0.0.1/mcp/private', tools: ['safe_tool'] } })));
  expect(one.home).not.toBe(two.home);
  expect(one.env.GEMINI_API_KEY).toBe('explicit-key');
  expect(one.env.GOOGLE_API_KEY).toBeUndefined();
  expect(one.env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
  expect(one.env.NODE_OPTIONS).toBeUndefined();
  expect(one.env.GEMINI_CLI_HOME).toBe(one.home);
  expect(one.env.GEMINI_CLI_NO_RELAUNCH).toBe('1');
  expect(one.env.GEMINI_CLI_TRUST_WORKSPACE).toBe('true');
  expect(one.env.NO_BROWSER).toBe('true');
  expect(await fs.readFile(path.join(one.home, '.gemini', '.env'), 'utf8')).toBe('');
  const settings = JSON.parse(await fs.readFile(path.join(one.home, '.gemini', 'settings.json'), 'utf8'));
  expect(settings.tools.core).toEqual([]);
  expect(settings.mcpServers.flujo.includeTools).toEqual(['safe_tool']);
  expect(settings.security.auth.enforcedType).toBe('gemini-api-key');
  expect(settings.admin.extensions.enabled).toBe(false);
  await one.cleanup();
  await one.cleanup();
  await expect(fs.access(one.home)).rejects.toThrow();
  await expect(fs.access(two.home)).resolves.toBeUndefined();
  await two.cleanup();
});

test('seeds only OAuth/account caches from GEMINI_CLI_HOME and keeps host state unchanged', async () => {
  const host = path.join(temporary, 'host');
  await fs.mkdir(path.join(host, '.gemini'), { recursive: true });
  const credentials = JSON.stringify({ refresh_token: 'test-refresh', access_token: 'test-access' });
  await fs.writeFile(path.join(host, '.gemini', 'oauth_creds.json'), credentials);
  await fs.writeFile(path.join(host, '.gemini', 'google_accounts.json'), '{"active":"test@example.com"}');
  await fs.writeFile(path.join(host, '.gemini', 'settings.json'), '{"mcpServers":{"foreign":{"command":"evil"}}}');
  await fs.writeFile(path.join(host, '.gemini', 'GEMINI.md'), 'foreign instructions');
  process.env.GEMINI_CLI_HOME = host;
  process.env.GOOGLE_GENAI_USE_VERTEXAI = 'true';
  process.env.GOOGLE_CLOUD_PROJECT = 'licensed-project';
  process.env.GOOGLE_CLOUD_PROJECT_ID = 'licensed-project-id';
  const runtime = await prepareGeminiCliRuntime({ model: 'auto', apiKey: '', maxTurns: 5 });
  expect(await fs.readFile(path.join(runtime.home, '.gemini', 'oauth_creds.json'), 'utf8')).toBe(credentials);
  expect(runtime.env.GOOGLE_GENAI_USE_VERTEXAI).toBeUndefined();
  expect(runtime.env.GOOGLE_CLOUD_PROJECT).toBe('licensed-project');
  expect(runtime.env.GOOGLE_CLOUD_PROJECT_ID).toBe('licensed-project-id');
  expect(runtime.env.GEMINI_API_KEY).toBeUndefined();
  await expect(fs.access(path.join(runtime.home, '.gemini', 'GEMINI.md'))).rejects.toThrow();
  await runtime.cleanup();
  expect(await fs.readFile(path.join(host, '.gemini', 'oauth_creds.json'), 'utf8')).toBe(credentials);
});

test('missing or invalid login fails actionably and removes partial runtime', async () => {
  process.env.GEMINI_CLI_HOME = path.join(temporary, 'missing');
  await expect(prepareGeminiCliRuntime({ model: 'auto', apiKey: '', maxTurns: 1 })).rejects.toThrow(/Sign in with Google/);
  expect(await fs.readdir(path.join(mockDataDir, 'db', 'gemini-cli-runtime'))).toEqual([]);
});

test('fails closed when hard-coded system policies could override tool isolation', async () => {
  const readDir = fs.readdir.bind(fs);
  jest.spyOn(fs, 'readdir').mockImplementation((async (directory: unknown, ...rest: unknown[]) => {
    if (String(directory).endsWith('gemini-cli\\policies') || String(directory).endsWith('GeminiCli/policies') || String(directory) === '/etc/gemini-cli/policies') return ['foreign.toml'];
    return readDir(directory as string, ...(rest as []));
  }) as typeof fs.readdir);
  await expect(prepareGeminiCliRuntime({ model: 'auto', apiKey: 'key', maxTurns: 1 })).rejects.toThrow(/system policies/);
});
