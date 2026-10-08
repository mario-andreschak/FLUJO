import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { prepareClaudeRuntimeEnvironment } from '@/backend/services/model/adapters/claudeRuntimeHome';
import { runWithWorkspace } from '@/utils/workspace';

describe('Claude runtime home isolation', () => {
  let root: string;
  let previousDataDir: string | undefined;
  let previousConfigDir: string | undefined;
  let previousSecureStorageDir: string | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-claude-home-test-'));
    previousDataDir = process.env.FLUJO_DATA_DIR;
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    previousSecureStorageDir = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    process.env.FLUJO_DATA_DIR = root;
    process.env.CLAUDE_CONFIG_DIR = path.join(root, 'personal-claude');
    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = path.join(root, 'personal-secure-storage');
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
    else process.env.FLUJO_DATA_DIR = previousDataDir;
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    if (previousSecureStorageDir === undefined) delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    else process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = previousSecureStorageDir;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('creates distinct persistent homes and neutral working directories per workspace', async () => {
    const [runtimeA, runtimeB] = await Promise.all([
      runWithWorkspace('claude-runtime-a', () => prepareClaudeRuntimeEnvironment()),
      runWithWorkspace('claude-runtime-b', () => prepareClaudeRuntimeEnvironment()),
    ]);

    expect(runtimeA.home).toBe(path.join(root, 'workspaces', 'claude-runtime-a', 'db', 'claude-runtime'));
    expect(runtimeB.home).toBe(path.join(root, 'workspaces', 'claude-runtime-b', 'db', 'claude-runtime'));
    expect(runtimeA.home).not.toBe(runtimeB.home);
    expect(runtimeA.workingDirectory).toBe(path.join(runtimeA.home, 'workspace'));
    expect(runtimeB.workingDirectory).toBe(path.join(runtimeB.home, 'workspace'));
    await expect(fs.stat(runtimeA.workingDirectory)).resolves.toMatchObject({});
    await expect(fs.stat(runtimeB.workingDirectory)).resolves.toMatchObject({});

    expect(runtimeA.env.CLAUDE_CONFIG_DIR).toBe(runtimeA.home);
    expect(runtimeA.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(runtimeA.home);
    expect(runtimeA.env.HOME).toBe(runtimeA.home);
    expect(runtimeA.env.USERPROFILE).toBe(runtimeA.home);
    expect(runtimeA.env.XDG_CONFIG_HOME).toBe(path.join(runtimeA.home, '.config'));
    expect(runtimeA.env.TMP).toBe(path.join(runtimeA.home, 'tmp'));
    expect(runtimeB.env.CLAUDE_CONFIG_DIR).toBe(runtimeB.home);
    expect(runtimeB.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(runtimeB.home);
    expect(runtimeB.env.HOME).toBe(runtimeB.home);
    expect(runtimeA.env.CLAUDE_CONFIG_DIR).not.toBe(process.env.CLAUDE_CONFIG_DIR);
    expect(runtimeA.env.CLAUDE_SECURESTORAGE_CONFIG_DIR)
      .not.toBe(process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR);
  });
});
