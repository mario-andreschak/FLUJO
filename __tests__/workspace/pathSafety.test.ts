import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ensureWorkspaceDirs,
  isValidWorkspaceName,
  listWorkspaces,
  workspaceExists,
} from '@/utils/workspace';

describe('workspace path safety', () => {
  let dataRoot: string;
  let priorDataDir: string | undefined;

  beforeEach(async () => {
    priorDataDir = process.env.FLUJO_DATA_DIR;
    dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-workspace-paths-'));
    process.env.FLUJO_DATA_DIR = dataRoot;
  });

  afterEach(async () => {
    if (priorDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
    else process.env.FLUJO_DATA_DIR = priorDataDir;
    await fs.rm(dataRoot, { recursive: true, force: true });
  });

  it.each([
    'CON', 'con', 'PrN', 'AUX', 'nul', 'COM1', 'com9', 'LPT1', 'lpt9',
  ])('rejects the portable Windows device name %s', name => {
    expect(isValidWorkspaceName(name)).toBe(false);
  });

  it('allows ordinary identifiers that merely contain a reserved prefix', () => {
    expect(isValidWorkspaceName('console')).toBe(true);
    expect(isValidWorkspaceName('com10')).toBe(true);
    expect(isValidWorkspaceName('nul-data')).toBe(true);
  });

  it('refuses a differently-cased alias when creating a workspace', async () => {
    await ensureWorkspaceDirs('Research');
    await expect(ensureWorkspaceDirs('research')).rejects.toThrow(/case alias/i);
    await expect(workspaceExists('Research')).resolves.toBe(true);
    await expect(workspaceExists('research')).resolves.toBe(false);
  });

  it('does not enumerate ambiguous case aliases created out of band', async () => {
    await Promise.all([
      fs.mkdir(path.join(dataRoot, 'workspaces', 'Alpha'), { recursive: true }),
      fs.mkdir(path.join(dataRoot, 'workspaces', 'alpha'), { recursive: true }),
    ]);
    const aliases = (await fs.readdir(path.join(dataRoot, 'workspaces')))
      .filter(name => name.toLowerCase() === 'alpha');
    // A case-insensitive filesystem collapses the two mkdir calls, so there is
    // no ambiguous on-disk state to exercise on that host.
    if (aliases.length < 2) return;

    const names = (await listWorkspaces()).map(workspace => workspace.name);
    expect(names).not.toContain('Alpha');
    expect(names).not.toContain('alpha');
    await expect(workspaceExists('Alpha')).resolves.toBe(false);
    await expect(workspaceExists('alpha')).resolves.toBe(false);
  });

  it('rejects a workspace whose owned subtree is a symlink or junction', async () => {
    const defaultDb = path.join(dataRoot, 'workspaces', 'default-workspace', 'db');
    const research = path.join(dataRoot, 'workspaces', 'research');
    await Promise.all([
      fs.mkdir(defaultDb, { recursive: true }),
      fs.mkdir(research, { recursive: true }),
    ]);
    await fs.symlink(
      defaultDb,
      path.join(research, 'db'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(ensureWorkspaceDirs('research')).rejects.toThrow(/real directory|symlink|junction/i);
  });
});
