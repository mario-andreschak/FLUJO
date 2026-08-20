import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_WORKSPACE,
  WORKSPACE_SUBTREES,
  createWorkspace,
  deleteWorkspace,
  ensureWorkspaceDirs,
  isValidWorkspaceName,
  listWorkspaces,
  loadWorkspaceRoots,
  renameWorkspace,
  updateWorkspaceRoots,
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

  it('owns and creates every runtime data subtree', async () => {
    const expected = [
      'db',
      'mcp-servers',
      'userdata',
      'snapshots',
      'screenshots',
      'recordings',
      'browser-profile',
      'bash-utils',
      'artifacts',
    ];
    expect([...WORKSPACE_SUBTREES]).toEqual(expected);

    const root = await ensureWorkspaceDirs('complete-layout');
    for (const subtree of expected) {
      expect((await fs.lstat(path.join(root, subtree))).isDirectory()).toBe(true);
    }
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

  it('creates, renames, and deletes a workspace without losing data during the rename', async () => {
    const created = await createWorkspace('research');
    expect(created).toMatchObject({ name: 'research', isDefault: false });
    await fs.writeFile(path.join(dataRoot, 'workspaces', 'research', 'userdata', 'note.txt'), 'kept');

    const renamed = await renameWorkspace('research', 'planning');
    expect(renamed).toMatchObject({ name: 'planning', isDefault: false });
    await expect(
      fs.readFile(path.join(dataRoot, 'workspaces', 'planning', 'userdata', 'note.txt'), 'utf8'),
    ).resolves.toBe('kept');
    await expect(workspaceExists('research')).resolves.toBe(false);
    await expect(workspaceExists('planning')).resolves.toBe(true);

    await deleteWorkspace('planning');
    await expect(workspaceExists('planning')).resolves.toBe(false);
  });

  it('persists absolute workspace roots and carries them through a rename', async () => {
    const first = path.join(dataRoot, 'projects', 'one');
    const second = path.join(dataRoot, 'projects', 'two');
    await createWorkspace('research');

    const updated = await updateWorkspaceRoots('research', [first, second]);
    expect(updated.roots).toEqual([first, second]);
    await expect(loadWorkspaceRoots('research')).resolves.toEqual([first, second]);

    const renamed = await renameWorkspace('research', 'planning');
    expect(renamed.roots).toEqual([first, second]);
    await expect(updateWorkspaceRoots('planning', ['relative/path'])).rejects.toMatchObject({
      code: 'WORKSPACE_INVALID_ROOTS',
    });
  });

  it('never renames, replaces, or deletes the default workspace', async () => {
    await ensureWorkspaceDirs(DEFAULT_WORKSPACE);
    await ensureWorkspaceDirs('research');

    await expect(renameWorkspace(DEFAULT_WORKSPACE, 'renamed-default')).rejects.toMatchObject({
      code: 'DEFAULT_WORKSPACE_PROTECTED',
    });
    await expect(renameWorkspace('research', DEFAULT_WORKSPACE)).rejects.toMatchObject({
      code: 'DEFAULT_WORKSPACE_PROTECTED',
    });
    await expect(deleteWorkspace(DEFAULT_WORKSPACE)).rejects.toMatchObject({
      code: 'DEFAULT_WORKSPACE_PROTECTED',
    });
    await expect(workspaceExists(DEFAULT_WORKSPACE)).resolves.toBe(true);
  });

  it('rejects case-insensitive collisions in create and rename operations', async () => {
    await createWorkspace('Research');
    await createWorkspace('planning');

    await expect(createWorkspace('research')).rejects.toMatchObject({
      code: 'WORKSPACE_ALREADY_EXISTS',
    });
    await expect(renameWorkspace('planning', 'RESEARCH')).rejects.toMatchObject({
      code: 'WORKSPACE_ALREADY_EXISTS',
    });
  });
});
