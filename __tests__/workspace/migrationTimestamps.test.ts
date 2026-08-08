import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  _resetWorkspaceMigrationState,
  _setWorkspaceMigrationFaultForTests,
  migrateWorkspaceLayout,
} from '@/backend/services/workspace/migration';

describe('workspace migration timestamp preservation', () => {
  let fixtureRoot: string;
  let dataRoot: string;
  let priorDataDir: string | undefined;
  let priorAppRoot: string | undefined;

  beforeEach(async () => {
    priorDataDir = process.env.FLUJO_DATA_DIR;
    priorAppRoot = process.env.FLUJO_APP_ROOT;
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-workspace-times-'));
    dataRoot = path.join(fixtureRoot, 'data');
    const appRoot = path.join(fixtureRoot, 'application');
    await Promise.all([
      fs.mkdir(dataRoot, { recursive: true }),
      fs.mkdir(appRoot, { recursive: true }),
    ]);
    process.env.FLUJO_DATA_DIR = dataRoot;
    process.env.FLUJO_APP_ROOT = appRoot;
    global.__flujo_flowsCache = null;
    global.__flujo_flowsMigration = undefined;
    _resetWorkspaceMigrationState();
  });

  afterEach(async () => {
    _resetWorkspaceMigrationState();
    global.__flujo_flowsCache = null;
    global.__flujo_flowsMigration = undefined;
    if (priorDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
    else process.env.FLUJO_DATA_DIR = priorDataDir;
    if (priorAppRoot === undefined) delete process.env.FLUJO_APP_ROOT;
    else process.env.FLUJO_APP_ROOT = priorAppRoot;
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it('preserves legacy file times across preflight and post-marker crash recovery', async () => {
    const source = path.join(dataRoot, 'db', 'flows', 'legacy-flow.json');
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, JSON.stringify({
      id: 'legacy-flow',
      name: 'Legacy flow',
      nodes: [],
      edges: [],
    }), 'utf8');
    await fs.utimes(
      source,
      new Date('2019-02-03T04:05:06.000Z'),
      new Date('2020-03-04T05:06:07.000Z'),
    );
    const original = await fs.stat(source);

    _setWorkspaceMigrationFaultForTests(checkpoint => {
      if (checkpoint === 'after-preflight') throw new Error('crash after timestamp inventory');
    });
    await expect(migrateWorkspaceLayout()).rejects.toThrow('crash after timestamp inventory');

    // Simulate the access-time drift caused by recovery reads. The durable
    // manifest, rather than the re-read source metadata, must remain authoritative.
    await fs.utimes(source, new Date('2025-06-07T08:09:10.000Z'), original.mtime);

    _resetWorkspaceMigrationState();
    _setWorkspaceMigrationFaultForTests(checkpoint => {
      if (checkpoint === 'after-marker') throw new Error('crash before timestamp cleanup');
    });
    await expect(migrateWorkspaceLayout()).rejects.toThrow('crash before timestamp cleanup');

    _resetWorkspaceMigrationState();
    await expect(migrateWorkspaceLayout()).resolves.toMatchObject({ version: 2 });

    const destination = path.join(
      dataRoot,
      'workspaces',
      'default-workspace',
      'db',
      'flows',
      'legacy-flow.json',
    );
    const migrated = await fs.stat(destination);
    expect(Math.abs(migrated.atimeMs - original.atimeMs)).toBeLessThan(2_000);
    expect(Math.abs(migrated.mtimeMs - original.mtimeMs)).toBeLessThan(2_000);

    // FlowService backfills missing legacy createdAt/updatedAt from this mtime.
    // Verify the timestamp visible to the actual service survived the layout move.
    const { FlowService } = await import('@/backend/services/flow');
    const flow = (await new FlowService().loadFlows()).find(item => item.id === 'legacy-flow');
    expect(flow).toMatchObject({
      createdAt: Math.floor(original.mtimeMs),
      updatedAt: Math.floor(original.mtimeMs),
    });
  });
});
