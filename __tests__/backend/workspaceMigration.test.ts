import fs from 'fs/promises';
import os from 'os';
import path from 'path';

let dataDir = '';
let priorDataDir: string | undefined;
let priorAppRoot: string | undefined;

jest.mock('@/utils/paths', () => ({
  getDataDir: () => dataDir,
  getAppDir: () => path.join(dataDir, 'application'),
}));

import {
  _resetWorkspaceMigrationState,
  _workspaceMigrationPathsForTests,
  migrateWorkspaceLayout,
} from '@/backend/services/workspace/migration';

describe('workspace layout migration (#406)', () => {
  beforeEach(async () => {
    priorDataDir = process.env.FLUJO_DATA_DIR;
    priorAppRoot = process.env.FLUJO_APP_ROOT;
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-workspace-migration-'));
    process.env.FLUJO_DATA_DIR = dataDir;
    process.env.FLUJO_APP_ROOT = path.join(dataDir, 'application');
    _resetWorkspaceMigrationState();
  });

  afterEach(async () => {
    _resetWorkspaceMigrationState();
    await fs.rm(dataDir, { recursive: true, force: true });
    if (priorDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
    else process.env.FLUJO_DATA_DIR = priorDataDir;
    if (priorAppRoot === undefined) delete process.env.FLUJO_APP_ROOT;
    else process.env.FLUJO_APP_ROOT = priorAppRoot;
  });

  it('creates the default workspace layout on a fresh install', async () => {
    const result = await migrateWorkspaceLayout();

    expect(result.subtrees).toEqual({
      db: 'created',
      'mcp-servers': 'created',
      userdata: 'created',
      snapshots: 'created',
      screenshots: 'created',
      recordings: 'created',
      'browser-profile': 'created',
      'bash-utils': 'created',
      artifacts: 'created',
    });
    await expect(
      fs.stat(path.join(dataDir, 'workspaces', 'default-workspace', 'db')),
    ).resolves.toBeDefined();
  });

  it('does not traverse or stage a populated workspace when every legacy source is absent', async () => {
    const workspaceUserdata = path.join(
      dataDir,
      'workspaces',
      'default-workspace',
      'userdata',
    );
    const payload = path.join(workspaceUserdata, 'large-repository', '.git', 'objects', 'payload.bin');
    await fs.mkdir(path.dirname(payload), { recursive: true });
    await fs.writeFile(payload, 'destination-data-must-stay-in-place', 'utf8');

    const readdir = jest.spyOn(fs, 'readdir');
    const open = jest.spyOn(fs, 'open');
    const readFile = jest.spyOn(fs, 'readFile');
    const copyFile = jest.spyOn(fs, 'copyFile');
    let destinationIo: string[] = [];
    let result: Awaited<ReturnType<typeof migrateWorkspaceLayout>>;
    try {
      result = await migrateWorkspaceLayout();
      const withinUserdata = (candidate: unknown) => {
        const resolved = path.resolve(String(candidate));
        const relative = path.relative(workspaceUserdata, resolved);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
      };
      destinationIo = [
        ...readdir.mock.calls.map(([candidate]) => `readdir:${candidate.toString()}`),
        ...open.mock.calls.map(([candidate]) => `open:${candidate.toString()}`),
        ...readFile.mock.calls.map(([candidate]) => `readFile:${candidate.toString()}`),
        ...copyFile.mock.calls.flatMap(([source, destination]) => [
          `copyFile:${source.toString()}`,
          `copyFile:${destination.toString()}`,
        ]),
      ].filter(operation => withinUserdata(operation.slice(operation.indexOf(':') + 1)));
    } finally {
      readdir.mockRestore();
      open.mockRestore();
      readFile.mockRestore();
      copyFile.mockRestore();
    }

    expect(destinationIo).toEqual([]);
    expect(result!.subtrees.userdata).toBe('already-migrated');
    await expect(fs.readFile(payload, 'utf8')).resolves.toBe('destination-data-must-stay-in-place');
    const { journal, fastJournal, transactions } = _workspaceMigrationPathsForTests();
    await expect(fs.stat(journal)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(fastJournal)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(transactions)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reconciles disjoint legacy and workspace data without losing either copy', async () => {
    const legacyDb = path.join(dataDir, 'db');
    const workspaceDb = path.join(
      dataDir,
      'workspaces',
      'default-workspace',
      'db',
    );
    await fs.mkdir(legacyDb, { recursive: true });
    await fs.mkdir(workspaceDb, { recursive: true });
    await fs.writeFile(path.join(legacyDb, 'legacy.json'), 'legacy');
    await fs.writeFile(path.join(workspaceDb, 'workspace.json'), 'workspace');

    const result = await migrateWorkspaceLayout();

    expect(result.subtrees.db).toBe('reconciled');
    await expect(fs.readFile(path.join(workspaceDb, 'legacy.json'), 'utf8')).resolves.toBe(
      'legacy',
    );
    await expect(
      fs.readFile(path.join(workspaceDb, 'workspace.json'), 'utf8'),
    ).resolves.toBe('workspace');
    await expect(fs.stat(legacyDb)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
