import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';

jest.mock('@/utils/workspace', () => ({
  getWorkspaceDataDir: () => process.env.FLUJO_CODEX_TEST_DATA_DIR!,
}));

import { prepareCodexRuntimeEnvironment } from '@/backend/services/model/adapters/codexRuntimeHome';

describe('Codex runtime home isolation', () => {
  let root: string;
  let originalCodexHome: string | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-codex-home-test-'));
    originalCodexHome = process.env.CODEX_HOME;
    process.env.FLUJO_CODEX_TEST_DATA_DIR = path.join(root, 'flujo-data');
    process.env.CODEX_HOME = path.join(root, 'personal-codex');
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
  });

  afterEach(async () => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    delete process.env.FLUJO_CODEX_TEST_DATA_DIR;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('copies subscription auth but not personal config or MCP servers', async () => {
    await fs.writeFile(path.join(process.env.CODEX_HOME!, 'auth.json'), '{"token":"test"}');
    await fs.writeFile(
      path.join(process.env.CODEX_HOME!, 'config.toml'),
      '[mcp_servers.personal]\ncommand = "private-tool"\n',
    );

    const runtime = await prepareCodexRuntimeEnvironment(true);

    expect(runtime.home).toBe(path.join(process.env.FLUJO_CODEX_TEST_DATA_DIR!, 'db', 'codex-runtime'));
    expect(runtime.workingDirectory).toBe(path.join(runtime.home, 'workspace'));
    await expect(fs.stat(runtime.workingDirectory)).resolves.toMatchObject({});
    expect(runtime.env.CODEX_HOME).toBe(runtime.home);
    expect(runtime.env.HOME).toBe(runtime.home);
    expect(runtime.env.USERPROFILE).toBe(runtime.home);
    expect(runtime.env.XDG_CONFIG_HOME).toBe(path.join(runtime.home, '.config'));
    expect(runtime.env.TMP).toBe(path.join(runtime.home, 'tmp'));
    await expect(fs.readFile(path.join(runtime.home, 'auth.json'), 'utf8')).resolves.toBe('{"token":"test"}');
    await expect(fs.readFile(path.join(runtime.home, 'config.toml'), 'utf8')).resolves.not.toContain(
      'mcp_servers.personal',
    );
  });

  it('does not copy personal authentication for API-key runs', async () => {
    await fs.writeFile(path.join(process.env.CODEX_HOME!, 'auth.json'), '{"token":"test"}');

    const runtime = await prepareCodexRuntimeEnvironment(false);

    await expect(fs.stat(path.join(runtime.home, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
