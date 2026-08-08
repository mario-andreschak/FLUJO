import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  _resetWorkspaceMigrationState,
  _setWorkspaceMigrationFastFaultForTests,
  _workspaceMigrationPathsForTests,
  migrateWorkspaceLayout,
} from '@/backend/services/workspace/migration';

describe('fast workspace migration recovery', () => {
  let fixtureRoot: string;
  let dataRoot: string;
  let appRoot: string;
  let priorDataDir: string | undefined;
  let priorAppRoot: string | undefined;

  const workspaceRoot = () => path.join(dataRoot, 'workspaces', 'default-workspace');
  const exists = async (candidate: string) => {
    try {
      await fs.lstat(candidate);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
  const write = async (relativePath: string, value: string) => {
    const file = path.join(dataRoot, ...relativePath.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value, 'utf8');
  };
  const transactionArtifacts = async (root: string): Promise<string[]> => {
    if (!(await exists(root))) return [];
    const found: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name);
        if (/^\.flujo-workspace-[0-9a-f]{8}-[0-9a-f]{16}\.(?:new|old)$/.test(entry.name)) {
          found.push(candidate);
        }
        if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(candidate);
      }
    };
    await walk(root);
    return found.sort();
  };
  const createStaleWorkspaceLink = async (): Promise<{
    destinationLink: string;
    destinationTarget: string;
  } | undefined> => {
    await write(
      'workspaces/default-workspace/userdata/packages/mcp-shared/value.json',
      'workspace-package',
    );
    const legacyTarget = path.join(dataRoot, 'userdata', 'packages', 'mcp-shared');
    const destinationTarget = path.join(
      workspaceRoot(),
      'userdata',
      'packages',
      'mcp-shared',
    );
    const destinationLink = path.join(
      workspaceRoot(),
      'userdata',
      'node_modules',
      '@flujo-ai',
      'mcp-shared',
    );
    await fs.mkdir(path.dirname(destinationLink), { recursive: true });
    try {
      await fs.symlink(
        path.relative(path.dirname(destinationLink), legacyTarget),
        destinationLink,
        'dir',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return undefined;
      throw error;
    }
    return { destinationLink, destinationTarget };
  };

  beforeEach(async () => {
    priorDataDir = process.env.FLUJO_DATA_DIR;
    priorAppRoot = process.env.FLUJO_APP_ROOT;
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-fast-migration-'));
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

  it('resumes an atomic userdata move after the durable rename', async () => {
    if (!['win32', 'linux'].includes(process.platform)) return;
    const payload = 'payload-survives-fast-recovery';
    const legacyPayload = path.join(dataRoot, 'userdata', 'cache', 'payload.txt');
    const workspacePayload = path.join(
      workspaceRoot(),
      'userdata',
      'cache',
      'payload.txt',
    );
    await write('userdata/cache/payload.txt', payload);
    _setWorkspaceMigrationFastFaultForTests(checkpoint => {
      if (checkpoint === 'after-fast-move:userdata') {
        throw new Error('simulated crash after fast userdata move');
      }
    });

    await expect(migrateWorkspaceLayout()).rejects.toThrow(
      'simulated crash after fast userdata move',
    );
    const { fastJournal, marker } = _workspaceMigrationPathsForTests();
    await expect(exists(fastJournal)).resolves.toBe(true);
    await expect(exists(marker)).resolves.toBe(false);
    await expect(exists(legacyPayload)).resolves.toBe(false);
    await expect(fs.readFile(workspacePayload, 'utf8')).resolves.toBe(payload);

    _resetWorkspaceMigrationState();
    await expect(migrateWorkspaceLayout()).resolves.toMatchObject({ version: 2 });

    await expect(fs.readFile(workspacePayload, 'utf8')).resolves.toBe(payload);
    await expect(exists(legacyPayload)).resolves.toBe(false);
    await expect(exists(fastJournal)).resolves.toBe(false);
    await expect(exists(marker)).resolves.toBe(true);
    await expect(transactionArtifacts(workspaceRoot())).resolves.toEqual([]);
  });

  it('resumes a safely bound schema-2 journal without changing its marker digest', async () => {
    if (!['win32', 'linux'].includes(process.platform)) return;
    await write('userdata/cache/payload.txt', 'schema-2-payload');
    _setWorkspaceMigrationFastFaultForTests(checkpoint => {
      if (checkpoint === 'after-fast-move:userdata') {
        throw new Error('stop after schema-2-compatible move');
      }
    });
    await expect(migrateWorkspaceLayout()).rejects.toThrow('stop after schema-2-compatible move');

    const { fastJournal } = _workspaceMigrationPathsForTests();
    const durable = JSON.parse(await fs.readFile(fastJournal, 'utf8')) as { schemaVersion: number };
    durable.schemaVersion = 2;
    await fs.writeFile(fastJournal, JSON.stringify(durable, null, 2), 'utf8');

    _resetWorkspaceMigrationState();
    await expect(migrateWorkspaceLayout()).resolves.toMatchObject({ version: 2 });
    await expect(fs.readFile(
      path.join(workspaceRoot(), 'userdata', 'cache', 'payload.txt'),
      'utf8',
    )).resolves.toBe('schema-2-payload');
    await expect(exists(fastJournal)).resolves.toBe(false);
  });

  it('fails closed with preservation instructions for an unsafe schema-1 journal', async () => {
    if (!['win32', 'linux'].includes(process.platform)) return;
    const legacyPayload = path.join(dataRoot, 'userdata', 'cache', 'payload.txt');
    await write('userdata/cache/payload.txt', 'schema-1-payload');
    _setWorkspaceMigrationFastFaultForTests(checkpoint => {
      if (checkpoint === 'after-fast-preflight') throw new Error('stop before schema-1 rewrite');
    });
    await expect(migrateWorkspaceLayout()).rejects.toThrow('stop before schema-1 rewrite');

    const { fastJournal, marker } = _workspaceMigrationPathsForTests();
    const durable = JSON.parse(await fs.readFile(fastJournal, 'utf8')) as { schemaVersion: number };
    durable.schemaVersion = 1;
    await fs.writeFile(fastJournal, JSON.stringify(durable, null, 2), 'utf8');

    _resetWorkspaceMigrationState();
    await expect(migrateWorkspaceLayout()).rejects.toThrow(
      /schema 1[\s\S]*preserve[\s\S]*do not delete/i,
    );
    await expect(fs.readFile(legacyPayload, 'utf8')).resolves.toBe('schema-1-payload');
    await expect(exists(fastJournal)).resolves.toBe(true);
    await expect(exists(marker)).resolves.toBe(false);
  });

  it('uses the merge-safe transaction where native no-clobber rename is unavailable', async () => {
    if (['win32', 'linux'].includes(process.platform)) return;
    const payload = 'portable-fallback-payload';
    await write('userdata/cache/payload.txt', payload);
    const fastCheckpoints: string[] = [];
    _setWorkspaceMigrationFastFaultForTests(checkpoint => {
      fastCheckpoints.push(checkpoint);
    });

    await expect(migrateWorkspaceLayout()).resolves.toMatchObject({ version: 2 });

    expect(fastCheckpoints).toEqual([]);
    await expect(fs.readFile(
      path.join(workspaceRoot(), 'userdata', 'cache', 'payload.txt'),
      'utf8',
    )).resolves.toBe(payload);
  });

  it('never overwrites a directory that races into an atomic move destination', async () => {
    if (!['win32', 'linux'].includes(process.platform)) return;
    const legacyPayload = path.join(dataRoot, 'userdata', 'cache', 'payload.txt');
    const racedPayload = path.join(workspaceRoot(), 'userdata', 'raced.txt');
    await write('userdata/cache/payload.txt', 'legacy-data');
    _setWorkspaceMigrationFastFaultForTests(async checkpoint => {
      if (checkpoint !== 'before-fast-move-rename:userdata') return;
      await fs.mkdir(path.dirname(racedPayload), { recursive: true });
      await fs.writeFile(racedPayload, 'raced-data', 'utf8');
    });

    await expect(migrateWorkspaceLayout()).rejects.toThrow(/destination appeared|conflict/i);

    await expect(fs.readFile(legacyPayload, 'utf8')).resolves.toBe('legacy-data');
    await expect(fs.readFile(racedPayload, 'utf8')).resolves.toBe('raced-data');
    const { fastJournal, marker } = _workspaceMigrationPathsForTests();
    await expect(exists(fastJournal)).resolves.toBe(true);
    await expect(exists(marker)).resolves.toBe(false);
  });

  it('never overwrites a regular file raced in after the destination absence check', async () => {
    if (!['win32', 'linux'].includes(process.platform)) return;
    const legacyPayload = path.join(dataRoot, 'userdata', 'cache', 'payload.txt');
    const racedDestination = path.join(workspaceRoot(), 'userdata');
    await write('userdata/cache/payload.txt', 'legacy-data');
    _setWorkspaceMigrationFastFaultForTests(async checkpoint => {
      if (checkpoint !== 'after-fast-move-destination-absence-check:userdata') return;
      await fs.writeFile(racedDestination, 'raced-regular-file', 'utf8');
    });

    await expect(migrateWorkspaceLayout()).rejects.toThrow(/destination appeared|conflict/i);

    await expect(fs.readFile(legacyPayload, 'utf8')).resolves.toBe('legacy-data');
    await expect(fs.readFile(racedDestination, 'utf8')).resolves.toBe('raced-regular-file');
    const { fastJournal, marker } = _workspaceMigrationPathsForTests();
    await expect(exists(fastJournal)).resolves.toBe(true);
    await expect(exists(marker)).resolves.toBe(false);
  });

  it('rejects a source replacement after the final JavaScript identity check', async () => {
    if (process.platform !== 'win32') return;
    const legacyRoot = path.join(dataRoot, 'userdata');
    const originalRoot = path.join(fixtureRoot, 'original-legacy-userdata');
    await write('userdata/cache/payload.txt', 'bound-source-data');
    _setWorkspaceMigrationFastFaultForTests(async checkpoint => {
      if (checkpoint !== 'after-fast-move-destination-absence-check:userdata') return;
      await fs.rename(legacyRoot, originalRoot);
      await fs.mkdir(legacyRoot, { recursive: true });
      await fs.writeFile(path.join(legacyRoot, 'replacement.txt'), 'replacement-data', 'utf8');
    });

    await expect(migrateWorkspaceLayout()).rejects.toThrow(/identity changed|bound move|conflict/i);

    await expect(fs.readFile(path.join(originalRoot, 'cache', 'payload.txt'), 'utf8'))
      .resolves.toBe('bound-source-data');
    await expect(fs.readFile(path.join(legacyRoot, 'replacement.txt'), 'utf8'))
      .resolves.toBe('replacement-data');
    await expect(exists(path.join(workspaceRoot(), 'userdata'))).resolves.toBe(false);
  });

  it('rejects a destination-parent replacement after the final JavaScript identity check', async () => {
    if (process.platform !== 'win32') return;
    const legacyPayload = path.join(dataRoot, 'userdata', 'cache', 'payload.txt');
    const workspace = workspaceRoot();
    const originalWorkspace = path.join(fixtureRoot, 'original-workspace-root');
    await write('userdata/cache/payload.txt', 'bound-parent-data');
    _setWorkspaceMigrationFastFaultForTests(async checkpoint => {
      if (checkpoint !== 'after-fast-move-destination-absence-check:userdata') return;
      await fs.rename(workspace, originalWorkspace);
      await fs.mkdir(workspace, { recursive: true });
    });

    await expect(migrateWorkspaceLayout()).rejects.toThrow(/identity changed|bound move|conflict/i);

    await expect(fs.readFile(legacyPayload, 'utf8')).resolves.toBe('bound-parent-data');
    await expect(exists(path.join(workspace, 'userdata'))).resolves.toBe(false);
    await expect(exists(path.join(originalWorkspace, 'userdata'))).resolves.toBe(false);
  });

  it('rejects a junction swap immediately before an atomic directory move', async () => {
    if (process.platform !== 'win32') return;
    const legacyPayload = path.join(dataRoot, 'userdata', 'cache', 'payload.txt');
    const workspace = workspaceRoot();
    const originalWorkspace = path.join(fixtureRoot, 'original-workspace-root');
    const externalWorkspace = path.join(fixtureRoot, 'external-workspace-root');
    await write('userdata/cache/payload.txt', 'junction-race-data');
    _setWorkspaceMigrationFastFaultForTests(async checkpoint => {
      if (checkpoint !== 'before-fast-move-rename:userdata') return;
      await fs.rename(workspace, originalWorkspace);
      await fs.mkdir(externalWorkspace, { recursive: true });
      await fs.symlink(externalWorkspace, workspace, 'junction');
    });

    await expect(migrateWorkspaceLayout()).rejects.toThrow(/reparse|identity|directory|junction/i);

    await expect(fs.readFile(legacyPayload, 'utf8')).resolves.toBe('junction-race-data');
    await expect(exists(path.join(externalWorkspace, 'userdata'))).resolves.toBe(false);
  });

  it('finishes a stale relative-link swap after crashing with its old link backed up', async () => {
    if (process.platform !== 'win32') return;
    const setup = await createStaleWorkspaceLink();
    if (!setup) return;
    const relativePath = 'node_modules/@flujo-ai/mcp-shared';
    _setWorkspaceMigrationFastFaultForTests(checkpoint => {
      if (checkpoint === `after-fast-link-backup:userdata:${relativePath}`) {
        throw new Error('simulated crash after fast link backup');
      }
    });

    await expect(migrateWorkspaceLayout()).rejects.toThrow(
      'simulated crash after fast link backup',
    );
    const { fastJournal, marker } = _workspaceMigrationPathsForTests();
    await expect(exists(fastJournal)).resolves.toBe(true);
    await expect(exists(marker)).resolves.toBe(false);
    await expect(exists(setup.destinationLink)).resolves.toBe(false);
    const interruptedArtifacts = await transactionArtifacts(workspaceRoot());
    // Publication now uses no-clobber symlink creation directly at the live
    // path; only the recoverable old link needs a transaction artifact.
    expect(interruptedArtifacts.some(candidate => candidate.endsWith('.new'))).toBe(false);
    expect(interruptedArtifacts.some(candidate => candidate.endsWith('.old'))).toBe(true);

    _resetWorkspaceMigrationState();
    await expect(migrateWorkspaceLayout()).resolves.toMatchObject({ version: 2 });

    const [actualTarget, expectedTarget] = await Promise.all([
      fs.realpath(setup.destinationLink),
      fs.realpath(setup.destinationTarget),
    ]);
    expect(process.platform === 'win32' ? actualTarget.toLowerCase() : actualTarget)
      .toBe(process.platform === 'win32' ? expectedTarget.toLowerCase() : expectedTarget);
    expect(path.isAbsolute(await fs.readlink(setup.destinationLink))).toBe(false);
    await expect(fs.readFile(path.join(setup.destinationTarget, 'value.json'), 'utf8'))
      .resolves.toBe('workspace-package');
    await expect(exists(path.join(dataRoot, 'userdata'))).resolves.toBe(false);
    await expect(exists(fastJournal)).resolves.toBe(false);
    await expect(transactionArtifacts(workspaceRoot())).resolves.toEqual([]);
  });

  it('rejects substitution of the final link object before atomic archival', async () => {
    if (process.platform !== 'win32') return;
    const setup = await createStaleWorkspaceLink();
    if (!setup) return;
    const oldTarget = await fs.readlink(setup.destinationLink);
    _setWorkspaceMigrationFastFaultForTests(async checkpoint => {
      if (!checkpoint.startsWith('before-fast-link-backup:userdata:')) return;
      await fs.unlink(setup.destinationLink);
      await fs.symlink(oldTarget, setup.destinationLink, 'dir');
    });

    await expect(migrateWorkspaceLayout()).rejects.toThrow(/identity changed|conflict/i);

    await expect(fs.readlink(setup.destinationLink)).resolves.toBe(oldTarget);
    expect((await transactionArtifacts(workspaceRoot())).some(item => item.endsWith('.old'))).toBe(false);
  });

  it('never overwrites a regular file raced into a fast-link backup name', async () => {
    if (process.platform !== 'win32') return;
    const setup = await createStaleWorkspaceLink();
    if (!setup) return;
    const relativePath = 'node_modules/@flujo-ai/mcp-shared';
    let racedBackup: string | undefined;
    _setWorkspaceMigrationFastFaultForTests(async checkpoint => {
      if (checkpoint !== `after-fast-link-backup-absence-check:userdata:${relativePath}`) return;
      const { fastJournal } = _workspaceMigrationPathsForTests();
      const journal = JSON.parse(await fs.readFile(fastJournal, 'utf8')) as { transactionId: string };
      const token = createHash('sha256')
        .update(`userdata\0${relativePath}`)
        .digest('hex')
        .slice(0, 16);
      racedBackup = path.join(
        path.dirname(setup.destinationLink),
        `.flujo-workspace-${journal.transactionId.slice(0, 8)}-${token}.old`,
      );
      await fs.writeFile(racedBackup, 'raced-backup-file', 'utf8');
    });

    await expect(migrateWorkspaceLayout()).rejects.toThrow(/backup appeared|conflict/i);

    await expect(fs.lstat(setup.destinationLink)).resolves.toMatchObject({});
    expect(racedBackup).toBeDefined();
    await expect(fs.readFile(racedBackup!, 'utf8')).resolves.toBe('raced-backup-file');
    await expect(exists(_workspaceMigrationPathsForTests().marker)).resolves.toBe(false);
  });

  it('uses the heavyweight no-clobber path for stale file symlinks', async () => {
    const workspaceTarget = path.join(workspaceRoot(), 'userdata', 'files', 'target.txt');
    const legacyTarget = path.join(dataRoot, 'userdata', 'files', 'target.txt');
    const link = path.join(workspaceRoot(), 'userdata', 'links', 'target.txt');
    await write('workspaces/default-workspace/userdata/files/target.txt', 'file-link-target');
    await fs.mkdir(path.dirname(link), { recursive: true });
    try {
      await fs.symlink(path.relative(path.dirname(link), legacyTarget), link, 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    const fastCheckpoints: string[] = [];
    _setWorkspaceMigrationFastFaultForTests(checkpoint => {
      fastCheckpoints.push(checkpoint);
    });

    await expect(migrateWorkspaceLayout()).resolves.toMatchObject({ version: 2 });

    expect(fastCheckpoints).toEqual([]);
    const [actual, expected] = await Promise.all([fs.realpath(link), fs.realpath(workspaceTarget)]);
    expect(process.platform === 'win32' ? actual.toLowerCase() : actual)
      .toBe(process.platform === 'win32' ? expected.toLowerCase() : expected);
  });

  it('uses the durable fast marker to resume cleanup and remove link backups', async () => {
    if (process.platform !== 'win32') return;
    const setup = await createStaleWorkspaceLink();
    if (!setup) return;
    _setWorkspaceMigrationFastFaultForTests(checkpoint => {
      if (checkpoint === 'after-fast-marker') {
        throw new Error('simulated crash after fast marker');
      }
    });

    await expect(migrateWorkspaceLayout()).rejects.toThrow(
      'simulated crash after fast marker',
    );
    const { fastJournal, marker } = _workspaceMigrationPathsForTests();
    await expect(exists(fastJournal)).resolves.toBe(true);
    await expect(exists(marker)).resolves.toBe(true);
    const durableMarker = JSON.parse(
      await fs.readFile(marker, 'utf8'),
    ) as Record<string, unknown>;
    const interruptedArtifacts = await transactionArtifacts(workspaceRoot());
    expect(interruptedArtifacts.some(candidate => candidate.endsWith('.old'))).toBe(true);
    // Simulate a filesystem that persisted the marker but rolled back both the
    // link publication and its directory entry backup.
    await fs.unlink(setup.destinationLink);
    await Promise.all(
      interruptedArtifacts
        .filter(candidate => candidate.endsWith('.old'))
        .map(candidate => fs.unlink(candidate)),
    );

    _resetWorkspaceMigrationState();
    await expect(migrateWorkspaceLayout()).resolves.toEqual(durableMarker);

    await expect(exists(fastJournal)).resolves.toBe(false);
    await expect(exists(marker)).resolves.toBe(true);
    await expect(transactionArtifacts(workspaceRoot())).resolves.toEqual([]);
    const [actualTarget, expectedTarget] = await Promise.all([
      fs.realpath(setup.destinationLink),
      fs.realpath(setup.destinationTarget),
    ]);
    expect(process.platform === 'win32' ? actualTarget.toLowerCase() : actualTarget)
      .toBe(process.platform === 'win32' ? expectedTarget.toLowerCase() : expectedTarget);
  });

  it('recreates a rolled-back empty subtree before cleaning a durable marker', async () => {
    _setWorkspaceMigrationFastFaultForTests(checkpoint => {
      if (checkpoint === 'after-fast-marker') {
        throw new Error('simulated crash after fresh-install marker');
      }
    });
    await expect(migrateWorkspaceLayout()).rejects.toThrow(
      'simulated crash after fresh-install marker',
    );
    const screenshots = path.join(workspaceRoot(), 'screenshots');
    await fs.rmdir(screenshots);

    _resetWorkspaceMigrationState();
    await expect(migrateWorkspaceLayout()).resolves.toMatchObject({ version: 2 });

    expect((await fs.lstat(screenshots)).isDirectory()).toBe(true);
    await expect(exists(_workspaceMigrationPathsForTests().fastJournal)).resolves.toBe(false);
  });

  it('replays a rolled-back directory move before cleaning a durable marker', async () => {
    if (process.platform !== 'win32') return;
    await write('userdata/cache/payload.txt', 'marker-move-payload');
    _setWorkspaceMigrationFastFaultForTests(checkpoint => {
      if (checkpoint === 'after-fast-marker') {
        throw new Error('simulated crash after move marker');
      }
    });
    await expect(migrateWorkspaceLayout()).rejects.toThrow('simulated crash after move marker');
    const legacyUserdata = path.join(dataRoot, 'userdata');
    const workspaceUserdata = path.join(workspaceRoot(), 'userdata');
    await fs.rename(workspaceUserdata, legacyUserdata);

    _resetWorkspaceMigrationState();
    await expect(migrateWorkspaceLayout()).resolves.toMatchObject({ version: 2 });

    await expect(exists(legacyUserdata)).resolves.toBe(false);
    await expect(fs.readFile(
      path.join(workspaceUserdata, 'cache', 'payload.txt'),
      'utf8',
    )).resolves.toBe('marker-move-payload');
  });

  it('falls back from the fast transaction for a current destination containing hardlinks', async () => {
    const original = path.join(workspaceRoot(), 'userdata', 'cache', 'original.bin');
    const linked = path.join(workspaceRoot(), 'userdata', 'cache', 'linked.bin');
    await write(
      'workspaces/default-workspace/userdata/cache/original.bin',
      'hardlinked-workspace-payload',
    );
    await fs.link(original, linked);
    const fastCheckpoints: string[] = [];
    _setWorkspaceMigrationFastFaultForTests(checkpoint => {
      fastCheckpoints.push(checkpoint);
    });

    await expect(migrateWorkspaceLayout()).resolves.toMatchObject({ version: 2 });

    expect(fastCheckpoints).toEqual([]);
    expect((await fs.lstat(original)).ino).not.toBe((await fs.lstat(linked)).ino);
    await expect(fs.readFile(linked, 'utf8')).resolves.toBe('hardlinked-workspace-payload');
    await expect(exists(_workspaceMigrationPathsForTests().fastJournal)).resolves.toBe(false);
  });

  it.each(['old', 'new'] as const)(
    'rejects an orphan fast-link .%s artifact instead of adopting or deleting it',
    async kind => {
      const artifact = path.join(
        workspaceRoot(),
        'userdata',
        'node_modules',
        `.flujo-workspace-deadbeef-0123456789abcdef.${kind}`,
      );
      await fs.mkdir(path.dirname(artifact), { recursive: true });
      await fs.writeFile(artifact, 'unowned-transaction-artifact', 'utf8');

      await expect(migrateWorkspaceLayout()).rejects.toThrow(/artifact|reserved|transaction/i);

      await expect(fs.readFile(artifact, 'utf8')).resolves.toBe('unowned-transaction-artifact');
      const { fastJournal, marker } = _workspaceMigrationPathsForTests();
      await expect(exists(fastJournal)).resolves.toBe(false);
      await expect(exists(marker)).resolves.toBe(false);
    },
  );

  it('rejects replacement of a current destination root after fast preflight is durable', async () => {
    if (process.platform !== 'win32') return;
    const setup = await createStaleWorkspaceLink();
    if (!setup) return;
    _setWorkspaceMigrationFastFaultForTests(checkpoint => {
      if (checkpoint === 'after-fast-preflight') {
        throw new Error('simulated crash after durable fast preflight');
      }
    });
    await expect(migrateWorkspaceLayout()).rejects.toThrow(
      'simulated crash after durable fast preflight',
    );

    const originalRoot = path.join(fixtureRoot, 'original-userdata-root');
    await fs.rename(path.join(workspaceRoot(), 'userdata'), originalRoot);
    const replacement = await createStaleWorkspaceLink();
    if (!replacement) return;

    _resetWorkspaceMigrationState();
    await expect(migrateWorkspaceLayout()).rejects.toThrow(/changed|identity|replaced|conflict/i);

    const { fastJournal, marker } = _workspaceMigrationPathsForTests();
    await expect(exists(fastJournal)).resolves.toBe(true);
    await expect(exists(marker)).resolves.toBe(false);
    await expect(fs.readFile(path.join(originalRoot, 'packages', 'mcp-shared', 'value.json'), 'utf8'))
      .resolves.toBe('workspace-package');
    await expect(fs.readFile(path.join(replacement.destinationTarget, 'value.json'), 'utf8'))
      .resolves.toBe('workspace-package');
  });

  it('rejects replacement of a stale link parent after fast preflight is durable', async () => {
    if (process.platform !== 'win32') return;
    const setup = await createStaleWorkspaceLink();
    if (!setup) return;
    const oldTarget = await fs.readlink(setup.destinationLink);
    _setWorkspaceMigrationFastFaultForTests(checkpoint => {
      if (checkpoint === 'after-fast-preflight') {
        throw new Error('simulated crash after durable fast preflight');
      }
    });
    await expect(migrateWorkspaceLayout()).rejects.toThrow(
      'simulated crash after durable fast preflight',
    );

    const linkParent = path.dirname(setup.destinationLink);
    const originalParent = path.join(fixtureRoot, 'original-link-parent');
    await fs.rename(linkParent, originalParent);
    await fs.mkdir(linkParent, { recursive: true });
    await fs.symlink(oldTarget, setup.destinationLink, 'dir');

    _resetWorkspaceMigrationState();
    await expect(migrateWorkspaceLayout()).rejects.toThrow(/changed|identity|replaced|conflict/i);

    const { fastJournal, marker } = _workspaceMigrationPathsForTests();
    await expect(exists(fastJournal)).resolves.toBe(true);
    await expect(exists(marker)).resolves.toBe(false);
    await expect(fs.readlink(setup.destinationLink)).resolves.toBe(oldTarget);
    await expect(fs.readlink(path.join(originalParent, 'mcp-shared'))).resolves.toBe(oldTarget);
  });

  it('rejects a linked auxiliary subtree even when a current marker already exists', async () => {
    await migrateWorkspaceLayout();
    const screenshots = path.join(workspaceRoot(), 'screenshots');
    const external = path.join(fixtureRoot, 'external-screenshots');
    await Promise.all([
      fs.rmdir(screenshots),
      fs.mkdir(external, { recursive: true }),
    ]);
    try {
      await fs.symlink(
        external,
        screenshots,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }

    _resetWorkspaceMigrationState();
    await expect(migrateWorkspaceLayout()).rejects.toThrow(/real directory|symlink|junction/i);
    expect((await fs.lstat(screenshots)).isSymbolicLink()).toBe(true);
  });
});
