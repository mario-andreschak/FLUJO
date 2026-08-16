import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  _resetWorkspaceMigrationState,
  migrateWorkspaceLayout,
} from '@/backend/services/workspace/migration';

describe('direct workspace migration metadata', () => {
  let root: string;
  let priorDataDir: string | undefined;
  let priorAppRoot: string | undefined;

  beforeEach(async () => {
    priorDataDir = process.env.FLUJO_DATA_DIR;
    priorAppRoot = process.env.FLUJO_APP_ROOT;
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-direct-metadata-'));
    process.env.FLUJO_DATA_DIR = root;
    process.env.FLUJO_APP_ROOT = path.join(root, 'application');
    _resetWorkspaceMigrationState();
  });

  afterEach(async () => {
    _resetWorkspaceMigrationState();
    if (priorDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
    else process.env.FLUJO_DATA_DIR = priorDataDir;
    if (priorAppRoot === undefined) delete process.env.FLUJO_APP_ROOT;
    else process.env.FLUJO_APP_ROOT = priorAppRoot;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('preserves file timestamps because payloads are renamed rather than copied', async () => {
    const source = path.join(root, 'snapshots', 'snapshot.json');
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, 'snapshot', 'utf8');
    const timestamp = new Date('2024-01-02T03:04:05.000Z');
    await fs.utimes(source, timestamp, timestamp);

    await migrateWorkspaceLayout();

    const destination = path.join(
      root,
      'workspaces',
      'default-workspace',
      'snapshots',
      'snapshot.json',
    );
    expect((await fs.stat(destination)).mtimeMs).toBe(timestamp.getTime());
  });
});
