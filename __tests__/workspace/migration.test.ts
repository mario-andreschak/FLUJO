import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  _resetWorkspaceMigrationState,
  _setWorkspaceMigrationFaultForTests,
  _setWorkspaceMigrationHeartbeatMsForTests,
  _setWorkspaceMigrationMountInfoForTests,
  _workspaceMigrationPathsForTests,
  migrateWorkspaceLayout,
  WORKSPACE_LAYOUT_VERSION,
  WorkspaceMigrationConflictError,
  WorkspaceMigrationLockedError,
  WorkspaceMigrationMarkerError,
  WorkspaceMigrationUnsafePathError,
} from '@/backend/services/workspace/migration';
import { WORKSPACE_SUBTREES } from '@/utils/workspace';

describe('transactional workspace layout migration', () => {
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
  };
  const read = (relativePath: string) =>
    fs.readFile(path.join(dataRoot, ...relativePath.split('/')), 'utf8');
  const exists = async (candidate: string) => {
    try {
      await fs.lstat(candidate);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };

  beforeEach(async () => {
    priorDataDir = process.env.FLUJO_DATA_DIR;
    priorAppRoot = process.env.FLUJO_APP_ROOT;
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-workspace-migration-'));
    dataRoot = path.join(fixtureRoot, 'data');
    appRoot = path.join(fixtureRoot, 'application');
    await Promise.all([
      fs.mkdir(dataRoot, { recursive: true }),
      fs.mkdir(appRoot, { recursive: true }),
    ]);
    process.env.FLUJO_DATA_DIR = dataRoot;
    // Keep the disposable data root separate from the application source tree,
    // so the migration treats all fixture MCP entries as runtime installs and
    // never examines this repository's shipped MCP packages.
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

  it('recursively overlays every legacy runtime root without losing disjoint data', async () => {
    await Promise.all([
      write('db/models.json', 'same-models'),
      write('.next/storage/flows.json', 'legacy-flows'),
      write('storage/conversations/chat.json', 'legacy-chat'),
      write('userdata/preferences.json', 'legacy-userdata'),
      write('snapshots/one.json', 'snapshot'),
      write('screenshots/one.png', 'screenshot'),
      write('recordings/one.webm', 'recording'),
      write('browser-profile/state.json', 'browser'),
      write('bash-utils/tool.sh', 'bash-tool'),
      write('artifacts/run.txt', 'artifact'),
      write('mcp-servers/custom-server/config.json', 'mcp-config'),
      write('workspaces/default-workspace/db/models.json', 'same-models'),
      write('workspaces/default-workspace/db/workspace-only.json', 'keep-me'),
      write('workspaces/default-workspace/mcp-servers/workspace-only/config.json', 'keep-mcp'),
    ]);

    const marker = await migrateWorkspaceLayout();

    expect(marker.version).toBe(WORKSPACE_LAYOUT_VERSION);
    await expect(read('workspaces/default-workspace/db/models.json')).resolves.toBe('same-models');
    await expect(read('workspaces/default-workspace/db/flows.json')).resolves.toBe('legacy-flows');
    await expect(read('workspaces/default-workspace/db/conversations/chat.json')).resolves.toBe('legacy-chat');
    await expect(read('workspaces/default-workspace/db/workspace-only.json')).resolves.toBe('keep-me');
    await expect(read('workspaces/default-workspace/mcp-servers/custom-server/config.json'))
      .resolves.toBe('mcp-config');
    await expect(read('workspaces/default-workspace/mcp-servers/workspace-only/config.json'))
      .resolves.toBe('keep-mcp');

    for (const subtree of [
      'userdata',
      'snapshots',
      'screenshots',
      'recordings',
      'browser-profile',
      'bash-utils',
      'artifacts',
    ]) {
      const file = subtree === 'userdata'
        ? 'preferences.json'
        : subtree === 'snapshots'
          ? 'one.json'
          : subtree === 'screenshots'
            ? 'one.png'
            : subtree === 'recordings'
              ? 'one.webm'
              : subtree === 'browser-profile'
                ? 'state.json'
                : subtree === 'bash-utils'
                  ? 'tool.sh'
                  : 'run.txt';
      await expect(read(`workspaces/default-workspace/${subtree}/${file}`)).resolves.toBeDefined();
    }

    for (const legacy of [
      'db', '.next/storage', 'storage', 'userdata', 'snapshots', 'screenshots',
      'recordings', 'browser-profile', 'bash-utils', 'artifacts', 'mcp-servers',
    ]) {
      await expect(exists(path.join(dataRoot, ...legacy.split('/')))).resolves.toBe(false);
    }
    for (const subtree of WORKSPACE_SUBTREES) {
      expect((await fs.lstat(path.join(workspaceRoot(), subtree))).isDirectory()).toBe(true);
    }
    const paths = _workspaceMigrationPathsForTests();
    await expect(exists(paths.journal)).resolves.toBe(false);
    await expect(exists(paths.lock)).resolves.toBe(false);
  });

  it('detects a conflict in a later subtree before mutating an earlier one', async () => {
    await Promise.all([
      write('db/models.json', 'legacy-db'),
      write('userdata/settings.json', 'legacy-userdata'),
      write('workspaces/default-workspace/userdata/settings.json', 'workspace-userdata'),
    ]);

    await expect(migrateWorkspaceLayout()).rejects.toBeInstanceOf(
      WorkspaceMigrationConflictError,
    );

    await expect(read('db/models.json')).resolves.toBe('legacy-db');
    await expect(read('userdata/settings.json')).resolves.toBe('legacy-userdata');
    await expect(read('workspaces/default-workspace/userdata/settings.json'))
      .resolves.toBe('workspace-userdata');
    await expect(exists(_workspaceMigrationPathsForTests().journal)).resolves.toBe(false);
  });

  it('recovers from archived sources even when the durable journal state is stale', async () => {
    await write('db/models.json', 'models');
    _setWorkspaceMigrationFaultForTests(checkpoint => {
      if (checkpoint === 'after-archive:db') throw new Error('simulated power loss');
    });

    await expect(migrateWorkspaceLayout()).rejects.toThrow('simulated power loss');
    const { journal } = _workspaceMigrationPathsForTests();
    const durable = JSON.parse(await fs.readFile(journal, 'utf8')) as {
      entries: Array<{ id: string; state: string }>;
    };
    const db = durable.entries.find(entry => entry.id === 'db');
    expect(db?.state).toBe('sources-archived');
    if (db) db.state = 'planned';
    await fs.writeFile(journal, JSON.stringify(durable, null, 2), 'utf8');

    _resetWorkspaceMigrationState();
    await expect(migrateWorkspaceLayout()).resolves.toMatchObject({ version: 2 });
    await expect(read('workspaces/default-workspace/db/models.json')).resolves.toBe('models');
    await expect(exists(path.join(dataRoot, 'db'))).resolves.toBe(false);
    await expect(exists(journal)).resolves.toBe(false);
  });

  it('resumes cleanup after a crash immediately after the durable marker', async () => {
    await write('db/models.json', 'models');
    _setWorkspaceMigrationFaultForTests(checkpoint => {
      if (checkpoint === 'after-marker') throw new Error('simulated post-marker crash');
    });

    await expect(migrateWorkspaceLayout()).rejects.toThrow('simulated post-marker crash');
    const { marker, journal } = _workspaceMigrationPathsForTests();
    await expect(exists(marker)).resolves.toBe(true);
    await expect(exists(journal)).resolves.toBe(true);

    _resetWorkspaceMigrationState();
    await expect(migrateWorkspaceLayout()).resolves.toMatchObject({ version: 2 });
    await expect(read('workspaces/default-workspace/db/models.json')).resolves.toBe('models');
    await expect(exists(journal)).resolves.toBe(false);
    const rootEntries = await fs.readdir(dataRoot);
    expect(rootEntries.some(name => name.includes('.workspace-v2-'))).toBe(false);
  });

  it('resumes a recursive backup deletion that was interrupted halfway', async () => {
    await Promise.all([
      write('db/one.json', 'one'),
      write('db/two.json', 'two'),
    ]);
    const originalRm = fs.rm.bind(fs);
    let interrupted = false;
    const rm = jest.spyOn(fs, 'rm').mockImplementation(async (candidate, options) => {
      const value = candidate.toString();
      if (!interrupted && /[\\/]\.db\.workspace-v2-[^\\/]+\.bak$/.test(value)) {
        interrupted = true;
        await originalRm(path.join(value, 'one.json'), { force: false });
        throw new Error('simulated power loss during recursive cleanup');
      }
      return originalRm(candidate, options);
    });

    try {
      await expect(migrateWorkspaceLayout()).rejects.toThrow(
        'simulated power loss during recursive cleanup',
      );
    } finally {
      rm.mockRestore();
    }
    await expect(exists(_workspaceMigrationPathsForTests().marker)).resolves.toBe(true);
    await expect(exists(_workspaceMigrationPathsForTests().journal)).resolves.toBe(true);

    _resetWorkspaceMigrationState();
    await expect(migrateWorkspaceLayout()).resolves.toMatchObject({ version: 2 });
    await expect(read('workspaces/default-workspace/db/one.json')).resolves.toBe('one');
    await expect(read('workspaces/default-workspace/db/two.json')).resolves.toBe('two');
    await expect(exists(_workspaceMigrationPathsForTests().journal)).resolves.toBe(false);
  });

  it('reconciles legacy data that appears after an older binary wrote a v2 marker', async () => {
    await migrateWorkspaceLayout();
    const firstMarker = JSON.parse(
      await fs.readFile(_workspaceMigrationPathsForTests().marker, 'utf8'),
    ) as { transactionId: string };
    await write('db/late-model.json', 'late');

    _resetWorkspaceMigrationState();
    const secondMarker = await migrateWorkspaceLayout();

    expect(secondMarker.transactionId).not.toBe(firstMarker.transactionId);
    await expect(read('workspaces/default-workspace/db/late-model.json')).resolves.toBe('late');
    await expect(exists(path.join(dataRoot, 'db'))).resolves.toBe(false);
  });

  it('reconciles a legacy source recreated after archive before reporting readiness', async () => {
    await write('db/base.json', 'base');
    let injected = false;
    _setWorkspaceMigrationFaultForTests(async checkpoint => {
      if (checkpoint === 'after-publish:db' && !injected) {
        injected = true;
        await write('db/late.json', 'late');
      }
    });

    await expect(migrateWorkspaceLayout()).resolves.toMatchObject({ version: 2 });
    await expect(read('workspaces/default-workspace/db/base.json')).resolves.toBe('base');
    await expect(read('workspaces/default-workspace/db/late.json')).resolves.toBe('late');
    await expect(exists(path.join(dataRoot, 'db'))).resolves.toBe(false);
  });

  it('memoizes fulfilled readiness for the process lifetime', async () => {
    const first = migrateWorkspaceLayout();
    await first;

    // A lock created after readiness would make a new scan fail. Returning the
    // same fulfilled promise proves request-time barriers do no filesystem work.
    const { lock } = _workspaceMigrationPathsForTests();
    await fs.mkdir(lock, { recursive: true });
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({
      token: 'later-process',
      pid: process.pid,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    }));

    const repeated = migrateWorkspaceLayout();
    expect(repeated).toBe(first);
    await expect(repeated).resolves.toMatchObject({ version: 2 });
    await expect(exists(lock)).resolves.toBe(true);
  });

  it('rejects an in-root journal path rewrite without mutating either target', async () => {
    await Promise.all([
      write('db/models.json', 'models'),
      write('valuable/keep.txt', 'do-not-touch'),
    ]);
    _setWorkspaceMigrationFaultForTests(checkpoint => {
      if (checkpoint === 'after-preflight') throw new Error('stop after journal');
    });
    await expect(migrateWorkspaceLayout()).rejects.toThrow('stop after journal');

    const { journal } = _workspaceMigrationPathsForTests();
    const durable = JSON.parse(await fs.readFile(journal, 'utf8')) as {
      entries: Array<{ id: string; sources: Array<{ path: string }> }>;
    };
    const db = durable.entries.find(entry => entry.id === 'db');
    expect(db).toBeDefined();
    db!.sources[0].path = path.join(dataRoot, 'valuable');
    await fs.writeFile(journal, JSON.stringify(durable, null, 2), 'utf8');

    _resetWorkspaceMigrationState();
    await expect(migrateWorkspaceLayout()).rejects.toBeInstanceOf(WorkspaceMigrationMarkerError);
    await expect(read('db/models.json')).resolves.toBe('models');
    await expect(read('valuable/keep.txt')).resolves.toBe('do-not-touch');
  });

  it('moves nested runtime data out of the shipped browser package but preserves its code', async () => {
    process.env.FLUJO_APP_ROOT = dataRoot;
    _resetWorkspaceMigrationState();
    await Promise.all([
      write('mcp-servers/browser/package.json', '{"name":"shipped-browser"}'),
      write('mcp-servers/browser/src/index.ts', 'shipped-code'),
      write('mcp-servers/browser/userdata/screenshots/browser/capture.png', 'capture'),
      write('mcp-servers/browser/userdata/browser-profile/state.json', 'profile'),
      write('mcp-servers/custom-runtime/config.json', 'runtime-config'),
    ]);

    await migrateWorkspaceLayout();

    await expect(read('mcp-servers/browser/package.json')).resolves.toContain('shipped-browser');
    await expect(read('mcp-servers/browser/src/index.ts')).resolves.toBe('shipped-code');
    await expect(exists(path.join(dataRoot, 'mcp-servers', 'browser', 'userdata')))
      .resolves.toBe(false);
    await expect(read('workspaces/default-workspace/screenshots/browser/capture.png'))
      .resolves.toBe('capture');
    await expect(read('workspaces/default-workspace/browser-profile/state.json'))
      .resolves.toBe('profile');
    await expect(read('workspaces/default-workspace/mcp-servers/custom-runtime/config.json'))
      .resolves.toBe('runtime-config');
    await expect(exists(path.join(dataRoot, 'mcp-servers', 'custom-runtime')))
      .resolves.toBe(false);
  });

  it.each(['EXDEV', 'EBUSY'])(
    'recovers a copy-only mount source after %s and leaves an empty mountpoint',
    async renameError => {
      await write('db/models.json', 'mounted-models');
      const sourceRoot = path.join(dataRoot, 'db');
      const originalRename = fs.rename.bind(fs);
      const rename = jest.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
        if (path.resolve(source.toString()) === path.resolve(sourceRoot)) {
          throw Object.assign(new Error('simulated mounted filesystem'), { code: renameError });
        }
        return originalRename(source, destination);
      });
      _setWorkspaceMigrationFaultForTests(checkpoint => {
        if (checkpoint === 'after-marker') throw new Error('crash before mount cleanup');
      });

      try {
        await expect(migrateWorkspaceLayout()).rejects.toThrow('crash before mount cleanup');
      } finally {
        rename.mockRestore();
      }
      await expect(read('db/models.json')).resolves.toBe('mounted-models');
      await expect(read('workspaces/default-workspace/db/models.json'))
        .resolves.toBe('mounted-models');

      _resetWorkspaceMigrationState();
      await expect(migrateWorkspaceLayout()).resolves.toMatchObject({ version: 2 });
      expect((await fs.lstat(sourceRoot)).isDirectory()).toBe(true);
      await expect(fs.readdir(sourceRoot)).resolves.toEqual([]);
      await expect(exists(_workspaceMigrationPathsForTests().journal)).resolves.toBe(false);

      // Empty retained mount roots are not re-inventoried on later startups.
      _resetWorkspaceMigrationState();
      await expect(migrateWorkspaceLayout()).resolves.toMatchObject({ version: 2 });
      await expect(fs.readdir(sourceRoot)).resolves.toEqual([]);
    },
  );

  it('copies and durably publishes read-only source files', async () => {
    await write('db/read-only.json', 'immutable-data');
    const source = path.join(dataRoot, 'db', 'read-only.json');
    await fs.chmod(source, 0o444);

    await expect(migrateWorkspaceLayout()).resolves.toMatchObject({ version: 2 });

    const destination = path.join(workspaceRoot(), 'db', 'read-only.json');
    await expect(fs.readFile(destination, 'utf8')).resolves.toBe('immutable-data');
    if (process.platform !== 'win32') {
      expect((await fs.lstat(destination)).mode & 0o222).toBe(0);
    }
  });

  it('treats permission differences as a conflict instead of deleting executable metadata', async () => {
    if (process.platform === 'win32') return;
    await Promise.all([
      write('bash-utils/tool.sh', '#!/bin/sh\necho safe\n'),
      write('workspaces/default-workspace/bash-utils/tool.sh', '#!/bin/sh\necho safe\n'),
    ]);
    const legacy = path.join(dataRoot, 'bash-utils', 'tool.sh');
    const destination = path.join(workspaceRoot(), 'bash-utils', 'tool.sh');
    await Promise.all([fs.chmod(legacy, 0o755), fs.chmod(destination, 0o644)]);

    await expect(migrateWorkspaceLayout()).rejects.toBeInstanceOf(WorkspaceMigrationConflictError);
    expect((await fs.lstat(legacy)).mode & 0o777).toBe(0o755);
    expect((await fs.lstat(destination)).mode & 0o777).toBe(0o644);
  });

  it('migrates internal hard links as safe independent workspace files', async () => {
    await write('db/run-resources/payload.dat', 'linked-payload');
    await fs.link(
      path.join(dataRoot, 'db', 'run-resources', 'payload.dat'),
      path.join(dataRoot, 'db', 'run-resources', 'payload.json'),
    );

    await expect(migrateWorkspaceLayout()).resolves.toMatchObject({ version: 2 });
    const migratedDat = path.join(workspaceRoot(), 'db', 'run-resources', 'payload.dat');
    const migratedJson = path.join(workspaceRoot(), 'db', 'run-resources', 'payload.json');
    await expect(fs.readFile(migratedDat, 'utf8')).resolves.toBe('linked-payload');
    await expect(fs.readFile(migratedJson, 'utf8')).resolves.toBe('linked-payload');
    expect((await fs.lstat(migratedDat)).nlink).toBe(1);
    expect((await fs.lstat(migratedJson)).nlink).toBe(1);
  });

  it('copies pnpm-style external hard links without mutating the external store inode', async () => {
    const storeFile = path.join(fixtureRoot, 'pnpm-store', 'package.js');
    const managedLink = path.join(dataRoot, 'mcp-servers', 'custom', 'node_modules', 'package.js');
    await fs.mkdir(path.dirname(storeFile), { recursive: true });
    await fs.writeFile(storeFile, 'module.exports = 1;', 'utf8');
    await fs.mkdir(path.dirname(managedLink), { recursive: true });
    await fs.link(storeFile, managedLink);

    await expect(migrateWorkspaceLayout()).resolves.toMatchObject({ version: 2 });
    const migrated = path.join(
      workspaceRoot(),
      'mcp-servers',
      'custom',
      'node_modules',
      'package.js',
    );
    await expect(fs.readFile(migrated, 'utf8')).resolves.toBe('module.exports = 1;');
    await expect(fs.readFile(storeFile, 'utf8')).resolves.toBe('module.exports = 1;');
    expect((await fs.lstat(migrated)).nlink).toBe(1);
    expect((await fs.lstat(storeFile)).nlink).toBe(1);
  });

  it('rejects a legacy source reached through a symlinked ancestor', async () => {
    const externalNext = path.join(fixtureRoot, 'external-next');
    await fs.mkdir(path.join(externalNext, 'storage'), { recursive: true });
    await fs.writeFile(path.join(externalNext, 'storage', 'outside.json'), 'outside', 'utf8');
    try {
      await fs.symlink(
        externalNext,
        path.join(dataRoot, '.next'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }

    await expect(migrateWorkspaceLayout()).rejects.toBeInstanceOf(
      WorkspaceMigrationUnsafePathError,
    );
    await expect(fs.readFile(path.join(externalNext, 'storage', 'outside.json'), 'utf8'))
      .resolves.toBe('outside');
  });

  it('rejects a dynamic MCP destination beneath a symlinked workspace subtree', async () => {
    process.env.FLUJO_APP_ROOT = dataRoot;
    _resetWorkspaceMigrationState();
    const externalMcp = path.join(fixtureRoot, 'external-mcp');
    await Promise.all([
      write('mcp-servers/custom-runtime/config.json', 'runtime'),
      fs.mkdir(externalMcp, { recursive: true }),
      fs.mkdir(workspaceRoot(), { recursive: true }),
    ]);
    try {
      await fs.symlink(
        externalMcp,
        path.join(workspaceRoot(), 'mcp-servers'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }

    await expect(migrateWorkspaceLayout()).rejects.toBeInstanceOf(
      WorkspaceMigrationUnsafePathError,
    );
    await expect(read('mcp-servers/custom-runtime/config.json')).resolves.toBe('runtime');
    await expect(fs.readdir(externalMcp)).resolves.toEqual([]);
  });

  it.each([
    ['legacy source', 'userdata/nested/mounted.json'],
    ['workspace destination', 'workspaces/default-workspace/userdata/nested/mounted.json'],
  ])('rejects a nested filesystem boundary in a %s before archiving any source', async (
    _label,
    boundaryRelativePath,
  ) => {
    await Promise.all([
      write('db/models.json', 'must-stay-at-legacy-path'),
      write(boundaryRelativePath, 'mounted-data'),
    ]);
    const boundaryPath = path.join(dataRoot, ...boundaryRelativePath.split('/'));
    const originalLstat = fs.lstat.bind(fs);
    const lstat = jest.spyOn(fs, 'lstat').mockImplementation(async (candidate, options) => {
      const stat = await originalLstat(candidate, options as never);
      const resolvedCandidate = path.resolve(candidate.toString());
      const boundaryDirectory = path.dirname(boundaryPath);
      if (
        resolvedCandidate !== boundaryDirectory
        && !resolvedCandidate.startsWith(`${boundaryDirectory}${path.sep}`)
      ) return stat;
      return new Proxy(stat, {
        get(target, property, receiver) {
          if (property === 'dev') return Number(target.dev) + 1;
          return Reflect.get(target, property, receiver);
        },
      });
    });

    try {
      await expect(migrateWorkspaceLayout()).rejects.toBeInstanceOf(
        WorkspaceMigrationUnsafePathError,
      );
    } finally {
      lstat.mockRestore();
    }

    await expect(read('db/models.json')).resolves.toBe('must-stay-at-legacy-path');
    expect((await fs.readdir(dataRoot)).some(name => /^\.db\.workspace-v2-.+\.bak$/.test(name)))
      .toBe(false);
    await expect(exists(_workspaceMigrationPathsForTests().journal)).resolves.toBe(false);
  });

  it('rejects a same-device nested bind mount from the authoritative mount table', async () => {
    await Promise.all([
      write('db/models.json', 'must-stay-at-legacy-path'),
      write('userdata/nested/mounted.json', 'mounted-data'),
    ]);
    const nestedMount = path.join(dataRoot, 'userdata', 'nested');
    const encodedMount = path.resolve(nestedMount)
      .replace(/\\/g, '\\134')
      .replace(/ /g, '\\040')
      .replace(/\t/g, '\\011')
      .replace(/\n/g, '\\012');
    _setWorkspaceMigrationMountInfoForTests(
      `99 1 0:1 / ${encodedMount} rw,relatime - none none rw`,
    );

    await expect(migrateWorkspaceLayout()).rejects.toBeInstanceOf(
      WorkspaceMigrationUnsafePathError,
    );
    await expect(read('db/models.json')).resolves.toBe('must-stay-at-legacy-path');
    await expect(read('userdata/nested/mounted.json')).resolves.toBe('mounted-data');
    await expect(exists(_workspaceMigrationPathsForTests().journal)).resolves.toBe(false);
  });

  it('relocates an absolute in-tree directory junction as an opaque relative link', async () => {
    await write('userdata/packages/mcp-shared/value.json', 'shared-package');
    const legacyTarget = path.join(dataRoot, 'userdata', 'packages', 'mcp-shared');
    const legacyLink = path.join(dataRoot, 'userdata', 'node_modules', '@flujo-ai', 'mcp-shared');
    await fs.mkdir(path.dirname(legacyLink), { recursive: true });
    const targetSpelling = process.platform === 'win32' ? legacyTarget.toUpperCase() : legacyTarget;
    try {
      await fs.symlink(targetSpelling, legacyLink, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }

    await migrateWorkspaceLayout();

    const migratedTarget = path.join(workspaceRoot(), 'userdata', 'packages', 'mcp-shared');
    const migratedLink = path.join(
      workspaceRoot(),
      'userdata',
      'node_modules',
      '@flujo-ai',
      'mcp-shared',
    );
    expect((await fs.lstat(migratedLink)).isSymbolicLink()).toBe(true);
    const migratedLinkTarget = await fs.readlink(migratedLink);
    if (process.platform === 'win32') {
      expect(path.isAbsolute(migratedLinkTarget)).toBe(true);
      expect(path.resolve(migratedLinkTarget).toLowerCase())
        .toBe(path.resolve(migratedTarget).toLowerCase());
      expect(path.resolve(migratedLinkTarget).toLowerCase())
        .not.toBe(path.resolve(legacyTarget).toLowerCase());
    } else {
      expect(path.isAbsolute(migratedLinkTarget)).toBe(false);
    }
    const [actualTarget, expectedTarget] = await Promise.all([
      fs.realpath(migratedLink),
      fs.realpath(migratedTarget),
    ]);
    expect(process.platform === 'win32' ? actualTarget.toLowerCase() : actualTarget)
      .toBe(process.platform === 'win32' ? expectedTarget.toLowerCase() : expectedTarget);
    await expect(read('workspaces/default-workspace/userdata/packages/mcp-shared/value.json'))
      .resolves.toBe('shared-package');
  });

  it('rejects an absolute link whose target is outside its managed source tree', async () => {
    const external = path.join(fixtureRoot, 'external-link-target');
    const legacyLink = path.join(dataRoot, 'userdata', 'outside');
    await Promise.all([
      write('db/models.json', 'must-stay-at-legacy-path'),
      fs.mkdir(external, { recursive: true }),
      fs.mkdir(path.dirname(legacyLink), { recursive: true }),
    ]);
    try {
      await fs.symlink(external, legacyLink, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }

    await expect(migrateWorkspaceLayout()).rejects.toBeInstanceOf(
      WorkspaceMigrationUnsafePathError,
    );
    await expect(read('db/models.json')).resolves.toBe('must-stay-at-legacy-path');
    await expect(exists(_workspaceMigrationPathsForTests().journal)).resolves.toBe(false);
  });

  it('fsyncs every nested staged directory before publishing the marker', async () => {
    await write('db/nested/deep/value.json', 'durable');
    const originalOpen = fs.open.bind(fs);
    const syncedDirectories: string[] = [];
    const open = jest.spyOn(fs, 'open').mockImplementation(async (candidate, flags, mode) => {
      if (flags === 'r') {
        const stat = await fs.lstat(candidate);
        if (stat.isDirectory()) syncedDirectories.push(path.resolve(candidate.toString()));
      }
      return originalOpen(candidate, flags, mode);
    });
    try {
      await migrateWorkspaceLayout();
    } finally {
      open.mockRestore();
    }

    expect(syncedDirectories.some(candidate =>
      candidate.includes(`${path.sep}.workspace-migrations${path.sep}`)
      && candidate.endsWith(`${path.sep}nested${path.sep}deep`))).toBe(true);
    expect(syncedDirectories.some(candidate =>
      candidate.includes(`${path.sep}.workspace-migrations${path.sep}`)
      && candidate.endsWith(`${path.sep}nested`))).toBe(true);
  });

  it.each([
    ['corrupt', '{not-json'],
    ['future', JSON.stringify({
      version: WORKSPACE_LAYOUT_VERSION + 1,
      completedAt: new Date().toISOString(),
      defaultWorkspace: 'default-workspace',
      subtrees: {},
    })],
  ])('fails closed for a %s marker without touching legacy data', async (_label, contents) => {
    await write('db/models.json', 'legacy');
    const { marker } = _workspaceMigrationPathsForTests();
    await fs.mkdir(path.dirname(marker), { recursive: true });
    await fs.writeFile(marker, contents, 'utf8');

    await expect(migrateWorkspaceLayout()).rejects.toBeInstanceOf(WorkspaceMigrationMarkerError);
    await expect(read('db/models.json')).resolves.toBe('legacy');
    await expect(fs.readFile(marker, 'utf8')).resolves.toBe(contents);
  });

  it('refuses a symlinked default workspace root', async () => {
    const external = path.join(fixtureRoot, 'external-workspace');
    const workspaces = path.join(dataRoot, 'workspaces');
    await Promise.all([
      fs.mkdir(external, { recursive: true }),
      fs.mkdir(workspaces, { recursive: true }),
    ]);
    try {
      await fs.symlink(
        external,
        path.join(workspaces, 'default-workspace'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }

    await expect(migrateWorkspaceLayout()).rejects.toBeInstanceOf(
      WorkspaceMigrationUnsafePathError,
    );
  });

  it('does not reclaim an expired lock owned by a live process on this host', async () => {
    const { lock } = _workspaceMigrationPathsForTests();
    await fs.mkdir(lock, { recursive: true });
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({
      token: 'live-owner',
      pid: process.pid,
      hostname: os.hostname(),
      startedAt: old,
      heartbeatAt: old,
    }));

    await expect(migrateWorkspaceLayout()).rejects.toBeInstanceOf(WorkspaceMigrationLockedError);
    await expect(exists(lock)).resolves.toBe(true);
  });

  it('awaits an in-flight heartbeat and never recreates the lock after release', async () => {
    _setWorkspaceMigrationHeartbeatMsForTests(5);
    let releasePreflight!: () => void;
    let releaseHeartbeat!: () => void;
    let heartbeatStarted!: () => void;
    const preflightGate = new Promise<void>(resolve => { releasePreflight = resolve; });
    const heartbeatGate = new Promise<void>(resolve => { releaseHeartbeat = resolve; });
    const heartbeatSeen = new Promise<void>(resolve => { heartbeatStarted = resolve; });
    _setWorkspaceMigrationFaultForTests(async checkpoint => {
      if (checkpoint === 'after-preflight') await preflightGate;
      if (checkpoint === 'before-lock-heartbeat-write') {
        heartbeatStarted();
        await heartbeatGate;
      }
    });

    const migration = migrateWorkspaceLayout();
    await heartbeatSeen;
    releasePreflight();
    const { marker, lock } = _workspaceMigrationPathsForTests();
    // Timestamp preservation adds durable metadata flushes before publication;
    // leave enough headroom for a busy Windows CI filesystem.
    for (let attempt = 0; attempt < 600 && !(await exists(marker)); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await expect(exists(marker)).resolves.toBe(true);
    await expect(exists(lock)).resolves.toBe(true);

    releaseHeartbeat();
    await expect(migration).resolves.toMatchObject({ version: 2 });
    await expect(exists(lock)).resolves.toBe(false);
    await new Promise(resolve => setTimeout(resolve, 20));
    await expect(exists(lock)).resolves.toBe(false);
  });

  it('cannot overwrite a successor lock from a stalled heartbeat', async () => {
    // Unix permits a lock directory containing an open heartbeat file to be
    // atomically renamed, matching a shared-volume lease reclaim. Windows may
    // deny that rename while the handle is open; in that case reclaim is itself
    // blocked and the successor-overwrite race cannot occur.
    if (process.platform === 'win32') return;
    _setWorkspaceMigrationHeartbeatMsForTests(5);
    let releasePreflight!: () => void;
    let releaseHeartbeat!: () => void;
    let heartbeatStarted!: () => void;
    const preflightGate = new Promise<void>(resolve => { releasePreflight = resolve; });
    const heartbeatGate = new Promise<void>(resolve => { releaseHeartbeat = resolve; });
    const heartbeatSeen = new Promise<void>(resolve => { heartbeatStarted = resolve; });
    _setWorkspaceMigrationFaultForTests(async checkpoint => {
      if (checkpoint === 'after-preflight') await preflightGate;
      if (checkpoint === 'before-lock-heartbeat-write') {
        heartbeatStarted();
        await heartbeatGate;
      }
    });

    const migration = migrateWorkspaceLayout();
    await heartbeatSeen;
    const { lock } = _workspaceMigrationPathsForTests();
    const oldLock = `${lock}.reclaimed`;
    await fs.rename(lock, oldLock);
    await fs.mkdir(lock);
    const successor = {
      token: 'successor-token',
      pid: process.pid,
      hostname: 'successor-host',
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify(successor), 'utf8');
    await fs.writeFile(path.join(lock, 'heartbeat'), successor.token, 'utf8');

    releaseHeartbeat();
    releasePreflight();
    await expect(migration).resolves.toMatchObject({ version: 2 });
    await expect(fs.readFile(path.join(lock, 'owner.json'), 'utf8')).resolves.toBe(
      JSON.stringify(successor),
    );
    await expect(fs.readFile(path.join(lock, 'heartbeat'), 'utf8')).resolves.toBe(successor.token);
    await fs.rm(oldLock, { recursive: true, force: true });
  });

  it('reclaims an expired lock whose same-host owner is dead', async () => {
    const { lock } = _workspaceMigrationPathsForTests();
    await fs.mkdir(lock, { recursive: true });
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({
      token: 'dead-owner',
      pid: 2_147_483_647,
      hostname: os.hostname(),
      startedAt: old,
      heartbeatAt: old,
    }));

    await expect(migrateWorkspaceLayout()).resolves.toMatchObject({ version: 2 });
    await expect(exists(lock)).resolves.toBe(false);
  });
});
