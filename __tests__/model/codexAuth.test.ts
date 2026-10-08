import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

jest.mock('@/utils/workspace', () => ({
  getWorkspaceDataDir: () => process.env.FLUJO_CODEX_TEST_DATA_DIR!,
}));

import { prepareCodexRuntimeEnvironment } from '@/backend/services/model/adapters/codexRuntimeHome';
import {
  CODEX_AUTH_SOURCE_FILE, WORKSPACE_CODEX_AUTH_SOURCE,
  readCodexAuthForTransfer, isChatGptAuthCache,
} from '@/backend/services/model/adapters/codexAuth';

const auth = (id: string) => JSON.stringify({
  auth_mode: 'chatgpt', tokens: { access_token: `test-access-${id}`, refresh_token: `test-refresh-${id}` },
});
const environmentKeys = ['CODEX_HOME', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'FLUJO_CODEX_TEST_DATA_DIR'] as const;

describe('portable Codex authentication', () => {
  let root: string;
  let home: string;
  let host: string;
  let previous: Array<string | undefined>;

  beforeEach(async () => {
    previous = environmentKeys.map(key => process.env[key]);
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-codex-auth-'));
    host = path.join(root, 'personal');
    home = path.join(root, 'workspace', 'db', 'codex-runtime');
    process.env.CODEX_HOME = host;
    process.env.FLUJO_CODEX_TEST_DATA_DIR = path.join(root, 'workspace');
    await fs.mkdir(host, { recursive: true });
  });

  afterEach(async () => {
    environmentKeys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    await fs.rm(root, { recursive: true, force: true });
  });

  it('keeps refreshed child tokens across runs and transfers them while the host login is unchanged', async () => {
    await fs.writeFile(path.join(host, 'auth.json'), auth('initial'));
    await prepareCodexRuntimeEnvironment(true);
    await fs.writeFile(path.join(home, 'auth.json'), auth('refreshed'));
    await prepareCodexRuntimeEnvironment(true);
    expect(await fs.readFile(path.join(home, 'auth.json'), 'utf8')).toBe(auth('refreshed'));
    expect((await readCodexAuthForTransfer()).toString()).toBe(auth('refreshed'));
  });

  it('uses a newly selected host account and honors host logout', async () => {
    await fs.writeFile(path.join(host, 'auth.json'), auth('first'));
    await prepareCodexRuntimeEnvironment(true);
    await fs.writeFile(path.join(host, 'auth.json'), auth('second'));
    expect((await readCodexAuthForTransfer()).toString()).toBe(auth('second'));
    await prepareCodexRuntimeEnvironment(true);
    expect(await fs.readFile(path.join(home, 'auth.json'), 'utf8')).toBe(auth('second'));
    await fs.unlink(path.join(host, 'auth.json'));
    await expect(readCodexAuthForTransfer()).rejects.toThrow('file-backed');
    await prepareCodexRuntimeEnvironment(true);
    await expect(fs.stat(path.join(home, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains an imported workspace login without a host login, including refreshed worker tokens', async () => {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, 'auth.json'), auth('worker'));
    await fs.writeFile(path.join(home, CODEX_AUTH_SOURCE_FILE), JSON.stringify(WORKSPACE_CODEX_AUTH_SOURCE));
    await prepareCodexRuntimeEnvironment(true);
    await fs.writeFile(path.join(home, 'auth.json'), auth('worker-refreshed'));
    await fs.writeFile(path.join(host, 'auth.json'), auth('unrelated'));
    await fs.writeFile(path.join(host, 'config.toml'), 'cli_auth_credentials_store = "keyring"');
    await prepareCodexRuntimeEnvironment(true);
    expect((await readCodexAuthForTransfer()).toString()).toBe(auth('worker-refreshed'));
  });

  it('fails clearly if an imported login disappears instead of adopting another account', async () => {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, CODEX_AUTH_SOURCE_FILE), JSON.stringify(WORKSPACE_CODEX_AUTH_SOURCE));
    await fs.writeFile(path.join(host, 'auth.json'), auth('unrelated'));
    await expect(prepareCodexRuntimeEnvironment(true)).rejects.toThrow('worker Codex login is missing');
  });

  it('exports the current host login before any local Codex model has run', async () => {
    await fs.writeFile(path.join(host, 'auth.json'), auth('host'));
    expect((await readCodexAuthForTransfer()).toString()).toBe(auth('host'));
  });

  it('does not fall back to an unmarked stale workspace cache when the host uses keyring storage', async () => {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, 'auth.json'), auth('stale'));
    await expect(readCodexAuthForTransfer()).rejects.toThrow('file-backed');
  });

  it.each([
    'cli_auth_credentials_store = "keyring"',
    "'cli_auth_credentials_store' = 'auto' # prefer the OS store",
    '"cli_auth_credentials_store" = "unknown-store"',
    'cli_auth_credentials_store = 3',
  ])('rejects ambiguous credential stores despite a stale host file: %s', async config => {
    await fs.writeFile(path.join(host, 'auth.json'), auth('stale-host'));
    await prepareCodexRuntimeEnvironment(true);
    await fs.writeFile(path.join(home, 'auth.json'), auth('refreshed-old-account'));
    await fs.writeFile(path.join(host, 'config.toml'), config);
    await expect(readCodexAuthForTransfer()).rejects.toThrow('requires file-backed');
    await expect(prepareCodexRuntimeEnvironment(true)).rejects.toThrow('requires file-backed');
    expect(await fs.readFile(path.join(home, 'auth.json'), 'utf8')).toBe(auth('refreshed-old-account'));
  });

  it.each([
    '"cli_auth_credentials_store" = "file" # explicit portable storage',
    '# cli_auth_credentials_store = "keyring"\nmodel = "example"',
    "notes = '''\ncli_auth_credentials_store = \"keyring\"\n'''\ncli_auth_credentials_store = 'file'",
    'cli_auth_credentials_store = "file"\n[profiles.legacy]\ncli_auth_credentials_store = "keyring"',
  ])('parses quoted keys, comments and multiline strings without inventing credential settings: %s', async config => {
    await fs.writeFile(path.join(host, 'auth.json'), auth('host'));
    await fs.writeFile(path.join(host, 'config.toml'), config);
    await prepareCodexRuntimeEnvironment(true);
    expect((await readCodexAuthForTransfer()).toString()).toBe(auth('host'));
  });

  it('rejects malformed and unreadable host configuration without exposing source contents', async () => {
    await fs.writeFile(path.join(host, 'auth.json'), auth('stale'));
    const configFile = path.join(host, 'config.toml');
    await fs.writeFile(configFile, 'cli_auth_credentials_store = "private-secret');
    await expect(readCodexAuthForTransfer()).rejects.toThrow('Could not verify');
    await expect(prepareCodexRuntimeEnvironment(true)).rejects.not.toThrow('private-secret');
    await fs.unlink(configFile);
    await fs.mkdir(configFile);
    await expect(readCodexAuthForTransfer()).rejects.toThrow('Could not verify');
    await expect(prepareCodexRuntimeEnvironment(true)).rejects.toThrow('Could not verify');
  });

  it.each([Buffer.from([0xff]), Buffer.alloc(1024 * 1024 + 1)])('rejects invalid encoding and oversized config files', async content => {
    await fs.writeFile(path.join(host, 'auth.json'), auth('stale'));
    await fs.writeFile(path.join(host, 'config.toml'), content);
    await expect(readCodexAuthForTransfer()).rejects.toThrow('Could not verify');
  });

  it('forces file storage and removes inherited API billing credentials for subscription runs', async () => {
    await fs.writeFile(path.join(host, 'auth.json'), auth('host'));
    process.env.OPENAI_API_KEY = 'synthetic-openai';
    process.env.CODEX_API_KEY = 'synthetic-codex';
    const runtime = await prepareCodexRuntimeEnvironment(true);
    expect(runtime.env.OPENAI_API_KEY).toBeUndefined();
    expect(runtime.env.CODEX_API_KEY).toBeUndefined();
    expect(await fs.readFile(path.join(home, 'config.toml'), 'utf8')).toContain('cli_auth_credentials_store = "file"');
    expect(process.env.OPENAI_API_KEY).toBe('synthetic-openai');
  });

  it.each(['{broken secret', '{"OPENAI_API_KEY":"synthetic"}', '{"tokens":{"access_token":"synthetic"}}'])('rejects invalid or non-subscription caches without revealing their contents', async value => {
    await fs.writeFile(path.join(host, 'auth.json'), value);
    expect(isChatGptAuthCache(Buffer.from(value))).toBe(false);
    await expect(readCodexAuthForTransfer()).rejects.toThrow('not a transferable ChatGPT login');
  });
});
