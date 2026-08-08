import fs from 'fs/promises';
import os from 'os';
import path from 'path';

let dataDir = '';

jest.mock('@/utils/paths', () => ({
  getDataDir: () => dataDir,
}));

import {
  _resetWorkspaceMigrationState,
  migrateWorkspaceLayout,
} from '@/backend/services/workspace/migration';

describe('workspace layout migration (#406)', () => {
  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-workspace-migration-'));
    _resetWorkspaceMigrationState();
  });

  afterEach(async () => {
    _resetWorkspaceMigrationState();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('creates the default workspace layout on a fresh install', async () => {
    const result = await migrateWorkspaceLayout();

    expect(result.subtrees).toEqual({
      db: 'created',
      'mcp-servers': 'created',
      userdata: 'created',
    });
    await expect(
      fs.stat(path.join(dataDir, 'workspaces', 'default-workspace', 'db')),
    ).resolves.toBeDefined();
  });

  it('preserves coexisting legacy and default data without merging or blocking startup', async () => {
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

    expect(result.subtrees.db).toBe('skipped');
    await expect(fs.readFile(path.join(legacyDb, 'legacy.json'), 'utf8')).resolves.toBe(
      'legacy',
    );
    await expect(
      fs.readFile(path.join(workspaceDb, 'workspace.json'), 'utf8'),
    ).resolves.toBe('workspace');
  });
});
