import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  _resetWorkspaceMigrationState,
  _workspaceMigrationPathsForTests,
  migrateWorkspaceLayout,
} from '@/backend/services/workspace/migration';

describe('direct workspace layout migration', () => {
  let fixtureRoot: string;
  let dataRoot: string;
  let appRoot: string;
  let priorDataDir: string | undefined;
  let priorAppRoot: string | undefined;

  const workspaceRoot = () => path.join(dataRoot, 'workspaces', 'default-workspace');
  const write = async (relativePath: string, value: string) => {
    const file = path.join(dataRoot, ...relativePath.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value, 'utf8');
    return file;
  };
  const exists = async (candidate: string) => Boolean(await fs.lstat(candidate).catch(() => undefined));

  beforeEach(async () => {
    priorDataDir = process.env.FLUJO_DATA_DIR;
    priorAppRoot = process.env.FLUJO_APP_ROOT;
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-direct-migration-'));
    dataRoot = path.join(fixtureRoot, 'data');
    appRoot = path.join(fixtureRoot, 'application');
    await Promise.all([
      fs.mkdir(dataRoot, { recursive: true }),
      fs.mkdir(appRoot, { recursive: true }),
    ]);
    process.env.FLUJO_DATA_DIR = dataRoot;
    process.env.FLUJO_APP_ROOT = appRoot;
    _resetWorkspaceMigrationState();
  });

  afterEach(async () => {
    _resetWorkspaceMigrationState();
    if (priorDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
    else process.env.FLUJO_DATA_DIR = priorDataDir;
    if (priorAppRoot === undefined) delete process.env.FLUJO_APP_ROOT;
    else process.env.FLUJO_APP_ROOT = priorAppRoot;
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it('renames a source-only folder without reading or copying payload bytes', async () => {
    const source = await write('userdata/repository/payload.bin', 'move-me');
    const sourceIdentity = (await fs.lstat(source)).ino;
    const open = jest.spyOn(fs, 'open');
    const readFile = jest.spyOn(fs, 'readFile');
    const copyFile = jest.spyOn(fs, 'copyFile');

    await migrateWorkspaceLayout();

    const payloadOperations = [
      ...open.mock.calls.map(([candidate]) => String(candidate)),
      ...readFile.mock.calls.map(([candidate]) => String(candidate)),
      ...copyFile.mock.calls.flatMap(([from, to]) => [String(from), String(to)]),
    ].filter(candidate => candidate.endsWith('payload.bin'));
    open.mockRestore();
    readFile.mockRestore();
    copyFile.mockRestore();

    const destination = path.join(workspaceRoot(), 'userdata', 'repository', 'payload.bin');
    expect(payloadOperations).toEqual([]);
    expect((await fs.lstat(destination)).ino).toBe(sourceIdentity);
    await expect(fs.readFile(destination, 'utf8')).resolves.toBe('move-me');
    await expect(exists(source)).resolves.toBe(false);
    const paths = _workspaceMigrationPathsForTests();
    await expect(exists(paths.journal)).resolves.toBe(false);
    await expect(exists(paths.fastJournal)).resolves.toBe(false);
    await expect(exists(paths.transactions)).resolves.toBe(false);
  });

  it('merges directories, overwrites collisions, and retains disjoint destination files', async () => {
    await Promise.all([
      write('userdata/same.txt', 'legacy-wins'),
      write('userdata/source-only.txt', 'source-only'),
      write('workspaces/default-workspace/userdata/same.txt', 'old-target'),
      write('workspaces/default-workspace/userdata/target-only.txt', 'target-only'),
    ]);

    const marker = await migrateWorkspaceLayout();

    expect(marker.subtrees.userdata).toBe('reconciled');
    await expect(fs.readFile(path.join(workspaceRoot(), 'userdata', 'same.txt'), 'utf8'))
      .resolves.toBe('legacy-wins');
    await expect(fs.readFile(path.join(workspaceRoot(), 'userdata', 'source-only.txt'), 'utf8'))
      .resolves.toBe('source-only');
    await expect(fs.readFile(path.join(workspaceRoot(), 'userdata', 'target-only.txt'), 'utf8'))
      .resolves.toBe('target-only');
    await expect(exists(path.join(dataRoot, 'userdata'))).resolves.toBe(false);
  });

  it('merges all legacy database roots directly into the workspace database', async () => {
    await Promise.all([
      write('db/root.json', 'root-db'),
      write('.next/storage/next.json', 'next-storage'),
      write('storage/storage.json', 'storage'),
    ]);

    await migrateWorkspaceLayout();

    for (const [name, value] of [
      ['root.json', 'root-db'],
      ['next.json', 'next-storage'],
      ['storage.json', 'storage'],
    ]) {
      await expect(fs.readFile(path.join(workspaceRoot(), 'db', name), 'utf8')).resolves.toBe(value);
    }
  });

  it('keeps bundled MCP packages and moves only user-installed MCP entries', async () => {
    process.env.FLUJO_APP_ROOT = dataRoot;
    await Promise.all([
      write('mcp-servers/bash/package.json', 'bundled'),
      write('mcp-servers/custom-server/config.json', 'custom'),
      write('mcp-servers/custom-metadata.json', 'metadata'),
    ]);

    await migrateWorkspaceLayout();

    await expect(fs.readFile(path.join(dataRoot, 'mcp-servers', 'bash', 'package.json'), 'utf8'))
      .resolves.toBe('bundled');
    await expect(fs.readFile(
      path.join(workspaceRoot(), 'mcp-servers', 'custom-server', 'config.json'),
      'utf8',
    )).resolves.toBe('custom');
    await expect(fs.readFile(
      path.join(workspaceRoot(), 'mcp-servers', 'custom-metadata.json'),
      'utf8',
    )).resolves.toBe('metadata');
    await expect(exists(path.join(dataRoot, 'mcp-servers', 'custom-server'))).resolves.toBe(false);
    await expect(exists(path.join(dataRoot, 'mcp-servers', 'custom-metadata.json'))).resolves.toBe(false);
  });

  it('moves a same-name empty MCP server folder as one top-level directory', async () => {
    const sourceServer = path.join(dataRoot, 'mcp-servers', 'custom-server');
    const destinationServer = path.join(workspaceRoot(), 'mcp-servers', 'custom-server');
    await Promise.all([
      write('mcp-servers/custom-server/config.json', 'custom'),
      fs.mkdir(destinationServer, { recursive: true }),
      write('workspaces/default-workspace/mcp-servers/workspace-only/config.json', 'keep'),
    ]);
    const rename = jest.spyOn(fs, 'rename');
    let sourceMoves: string[][] = [];

    try {
      await migrateWorkspaceLayout();
      sourceMoves = rename.mock.calls
        .map(([from, to]) => [path.resolve(String(from)), path.resolve(String(to))])
        .filter(([from]) => from === sourceServer || from.startsWith(`${sourceServer}${path.sep}`));
    } finally {
      rename.mockRestore();
    }

    expect(sourceMoves).toEqual([[sourceServer, destinationServer]]);
    await expect(fs.readFile(path.join(destinationServer, 'config.json'), 'utf8'))
      .resolves.toBe('custom');
    await expect(fs.readFile(
      path.join(workspaceRoot(), 'mcp-servers', 'workspace-only', 'config.json'),
      'utf8',
    )).resolves.toBe('keep');
    await expect(exists(sourceServer)).resolves.toBe(false);
  });

  it('durably rewrites migrated MCP paths in persisted server configuration', async () => {
    process.env.FLUJO_APP_ROOT = dataRoot;
    const legacyServer = path.join(dataRoot, 'mcp-servers', 'custom-server');
    const migratedServer = path.join(workspaceRoot(), 'mcp-servers', 'custom-server');
    const bundledServer = path.join(dataRoot, 'mcp-servers', 'bash');
    const external = path.join(fixtureRoot, 'external-server');
    await Promise.all([
      write('mcp-servers/custom-server/dist/index.js', 'custom'),
      write('mcp-servers/bash/dist/index.js', 'bundled'),
      write('db/mcp_servers.json', JSON.stringify({
        custom: {
          transport: 'stdio',
          rootPath: legacyServer,
          cwd: path.join(legacyServer, 'packages', 'server'),
          command: path.join(legacyServer, 'dist', 'index.js'),
          args: [
            `--config="${path.join(legacyServer, 'config.json')}"`,
            pathToFileURL(path.join(legacyServer, 'settings.json')).href,
            external,
          ],
          roots: [legacyServer, external],
          env: {
            SERVER_HOME: legacyServer,
            SERVER_CONFIG: { value: path.join(legacyServer, 'config.json'), secret: false },
          },
          launch: {
            command: path.join(legacyServer, 'bin', 'launch.js'),
            cwd: legacyServer,
            args: [path.join(legacyServer, 'launch.json')],
            env: { SERVER_HOME: legacyServer },
          },
        },
        bundled: {
          transport: 'stdio',
          rootPath: bundledServer,
          command: path.join(bundledServer, 'dist', 'index.js'),
          args: [],
        },
      })),
    ]);

    await migrateWorkspaceLayout();

    const stored = JSON.parse(await fs.readFile(
      path.join(workspaceRoot(), 'db', 'mcp_servers.json'),
      'utf8',
    )) as Record<string, any>;
    expect(stored.custom).toMatchObject({
      rootPath: migratedServer,
      cwd: path.join(migratedServer, 'packages', 'server'),
      command: path.join(migratedServer, 'dist', 'index.js'),
      args: [
        `--config="${path.join(migratedServer, 'config.json')}"`,
        pathToFileURL(path.join(migratedServer, 'settings.json')).href,
        external,
      ],
      roots: [migratedServer, external],
      env: {
        SERVER_HOME: migratedServer,
        SERVER_CONFIG: { value: path.join(migratedServer, 'config.json'), secret: false },
      },
      launch: {
        command: path.join(migratedServer, 'bin', 'launch.js'),
        cwd: migratedServer,
        args: [path.join(migratedServer, 'launch.json')],
        env: { SERVER_HOME: migratedServer },
      },
    });
    expect(stored.bundled.rootPath).toBe(bundledServer);
    expect(stored.bundled.command).toBe(path.join(bundledServer, 'dist', 'index.js'));
  });

  it('backfills persisted MCP paths when the workspace marker already exists', async () => {
    const legacyServer = path.join(dataRoot, 'mcp-servers', 'custom-server');
    const migratedServer = path.join(workspaceRoot(), 'mcp-servers', 'custom-server');
    await write('mcp-servers/custom-server/index.js', 'custom');
    await migrateWorkspaceLayout();

    const configPath = path.join(workspaceRoot(), 'db', 'mcp_servers.json');
    await fs.writeFile(configPath, JSON.stringify({
      custom: {
        transport: 'stdio',
        rootPath: legacyServer,
        command: path.join(legacyServer, 'index.js'),
        args: [],
      },
    }), 'utf8');
    _resetWorkspaceMigrationState();

    await migrateWorkspaceLayout();

    const stored = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, any>;
    expect(stored.custom.rootPath).toBe(migratedServer);
    expect(stored.custom.command).toBe(path.join(migratedServer, 'index.js'));
  });

  it('removes source links before moving and recreates them at workspace-relative targets', async () => {
    const target = await write('userdata/packages/shared/value.txt', 'linked-value');
    const link = path.join(dataRoot, 'userdata', 'node_modules', 'shared');
    await fs.mkdir(path.dirname(link), { recursive: true });
    try {
      await fs.symlink(
        path.relative(path.dirname(link), path.dirname(target)),
        link,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }

    await migrateWorkspaceLayout();

    const movedLink = path.join(workspaceRoot(), 'userdata', 'node_modules', 'shared');
    const movedTarget = path.join(workspaceRoot(), 'userdata', 'packages', 'shared');
    expect((await fs.lstat(movedLink)).isSymbolicLink()).toBe(true);
    const [actual, expected] = await Promise.all([fs.realpath(movedLink), fs.realpath(movedTarget)]);
    expect(actual.toLowerCase()).toBe(expected.toLowerCase());
  });
});
