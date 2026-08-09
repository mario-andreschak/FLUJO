import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  _resetWorkspaceMigrationState,
  _workspaceMigrationPathsForTests,
  migrateWorkspaceLayout,
} from '@/backend/services/workspace/migration';

describe('direct workspace migration startup behavior', () => {
  let root: string;
  let priorDataDir: string | undefined;
  let priorAppRoot: string | undefined;
  let priorBaseUrl: string | undefined;

  beforeEach(async () => {
    priorDataDir = process.env.FLUJO_DATA_DIR;
    priorAppRoot = process.env.FLUJO_APP_ROOT;
    priorBaseUrl = process.env.FLUJO_BASE_URL;
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-direct-startup-'));
    process.env.FLUJO_DATA_DIR = root;
    process.env.FLUJO_APP_ROOT = path.join(root, 'application');
    process.env.FLUJO_BASE_URL = 'http://127.0.0.1:4310';
    _resetWorkspaceMigrationState();
  });

  afterEach(async () => {
    _resetWorkspaceMigrationState();
    if (priorDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
    else process.env.FLUJO_DATA_DIR = priorDataDir;
    if (priorAppRoot === undefined) delete process.env.FLUJO_APP_ROOT;
    else process.env.FLUJO_APP_ROOT = priorAppRoot;
    if (priorBaseUrl === undefined) delete process.env.FLUJO_BASE_URL;
    else process.env.FLUJO_BASE_URL = priorBaseUrl;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('removes obsolete journals and staging from the old migration engine', async () => {
    const paths = _workspaceMigrationPathsForTests();
    await fs.mkdir(path.join(paths.transactions, 'old', 'stage'), { recursive: true });
    await fs.writeFile(paths.journal, 'obsolete', 'utf8');
    await fs.writeFile(paths.fastJournal, 'obsolete', 'utf8');

    await migrateWorkspaceLayout();

    await expect(fs.lstat(paths.journal)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(paths.fastJournal)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(paths.transactions)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes no UUID or digest into the completion marker', async () => {
    await migrateWorkspaceLayout();
    const marker = JSON.parse(
      await fs.readFile(_workspaceMigrationPathsForTests().marker, 'utf8'),
    ) as Record<string, unknown>;

    expect(marker).not.toHaveProperty('transactionId');
    expect(marker).not.toHaveProperty('manifestDigest');
  });

  it('prints a plain-English completion summary with moved and skipped reasons', async () => {
    await fs.mkdir(path.join(root, 'snapshots'), { recursive: true });
    await fs.writeFile(path.join(root, 'snapshots', 'one.json'), 'snapshot', 'utf8');
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      await migrateWorkspaceLayout();
      const output = info.mock.calls.flat().join('\n');
      expect(output).toContain('Workspace migration summary');
      expect(output).toContain('MOVED');
      expect(output).toContain('SKIPPED');
      expect(output).toContain('Why:');
      expect(output).toContain('legacy source does not exist');
      expect(output).toContain('renamed the legacy directory directly into the workspace');
      expect(output.indexOf('[FLUJO] MOVED')).toBeLessThan(
        output.indexOf('[FLUJO] Workspace migration summary'),
      );
      expect(output).toContain(
        '[FLUJO] Start FLUJO in the browser: '
        + '[http://localhost:4310](http://localhost:4310)',
      );
    } finally {
      info.mockRestore();
    }
  });

  it('uses the completion marker on later starts without scanning workspace payloads', async () => {
    await migrateWorkspaceLayout();
    const payloadRoot = path.join(root, 'workspaces', 'default-workspace', 'userdata');
    await fs.writeFile(path.join(payloadRoot, 'payload.txt'), 'untouched', 'utf8');
    _resetWorkspaceMigrationState();
    const readdir = jest.spyOn(fs, 'readdir');

    await migrateWorkspaceLayout();

    const targetReads = readdir.mock.calls
      .map(([candidate]) => path.resolve(String(candidate)))
      .filter(candidate => candidate === payloadRoot || candidate.startsWith(`${payloadRoot}${path.sep}`));
    readdir.mockRestore();
    expect(targetReads).toEqual([]);
  });

  it('collapses an error-free all-skipped run to nothing-to-do and the browser link', async () => {
    await migrateWorkspaceLayout();
    _resetWorkspaceMigrationState();
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);

    try {
      await migrateWorkspaceLayout();
      const completion = info.mock.calls
        .flat()
        .map(String)
        .find(line => line.includes('Workspace migration: nothing to do'));
      expect(completion).toContain('Workspace migration: nothing to do');
      expect(completion).toContain('[http://localhost:4310](http://localhost:4310)');
      expect(completion).not.toContain('[FLUJO] SKIPPED');
      expect(completion).not.toContain('Why:');
      expect(completion).not.toContain('Workspace migration summary');
    } finally {
      info.mockRestore();
    }
  });

  it('skips an unsafe legacy root, records the error, and still completes startup', async () => {
    await fs.writeFile(path.join(root, 'userdata'), 'not-a-directory', 'utf8');

    const marker = await migrateWorkspaceLayout();

    expect(marker.subtrees.userdata).toBe('skipped');
    expect(marker.errors?.some(error => error.includes('unsafe legacy root'))).toBe(true);
    await expect(fs.readFile(path.join(root, 'userdata'), 'utf8')).resolves.toBe('not-a-directory');
  });
});
