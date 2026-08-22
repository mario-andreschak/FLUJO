import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { v4 as uuid } from 'uuid';
import {
  SnapshotStore,
  _setSnapshotStoreDirForTests,
} from '@/backend/services/snapshot/SnapshotStore';
import {
  SnapshotFolderLaunchError,
  _setSnapshotFolderLauncherForTests,
  snapshotFolderAccessActivity,
  snapshotFolderAccessSupported,
  type SnapshotFolderLauncher,
} from '@/backend/services/snapshot/openSnapshotFolder';

describe('openSnapshotFolder', () => {
  let root: string;
  let store: SnapshotStore;

  beforeEach(() => {
    root = path.join(tmpdir(), `flujo-open-snapshot-${uuid()}`);
    _setSnapshotStoreDirForTests(root);
    store = new SnapshotStore();
  });

  afterEach(async () => {
    _setSnapshotFolderLauncherForTests(null);
    _setSnapshotStoreDirForTests(null);
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each([
    ['win32', 'explorer.exe'],
    ['darwin', 'open'],
    ['linux', 'xdg-open'],
  ] as const)('uses a fixed shell-free launcher on %s', async (platform, executable) => {
    const launch = jest.fn(async () => undefined);
    _setSnapshotFolderLauncherForTests(
      launch as unknown as SnapshotFolderLauncher,
      platform,
    );

    await store.openFolder();

    expect(launch).toHaveBeenCalledWith(
      executable,
      [root],
      { shell: false, detached: true, stdio: 'ignore' },
    );
    expect((await fs.stat(root)).isDirectory()).toBe(true);
    expect(snapshotFolderAccessSupported()).toBe(true);
  });

  it('tracks concurrent dispatches and clears activity after every outcome', async () => {
    const releases: Array<() => void> = [];
    const launch = jest.fn(() => new Promise<void>((resolve) => {
      releases.push(resolve);
    }));
    _setSnapshotFolderLauncherForTests(
      launch as unknown as SnapshotFolderLauncher,
      'linux',
    );

    const first = store.openFolder();
    const second = store.openFolder();
    while (launch.mock.calls.length < 2) {
      await new Promise(resolve => setImmediate(resolve));
    }

    expect(snapshotFolderAccessActivity(root)).toBe(2);
    releases[0]();
    await first;
    expect(snapshotFolderAccessActivity(root)).toBe(1);
    releases[1]();
    await second;
    expect(snapshotFolderAccessActivity(root)).toBe(0);
  });

  it('returns a sanitized error and clears activity when launching fails', async () => {
    _setSnapshotFolderLauncherForTests(
      jest.fn(async () => {
        throw new Error(`${root} private launcher detail`);
      }) as unknown as SnapshotFolderLauncher,
      'linux',
    );

    await expect(store.openFolder()).rejects.toEqual(
      expect.objectContaining({
        name: 'SnapshotFolderLaunchError',
        message: 'Unable to open snapshot folder',
      }),
    );
    expect(snapshotFolderAccessActivity(root)).toBe(0);
  });

  it('fails closed on unsupported platforms without invoking a launcher', async () => {
    const launch = jest.fn(async () => undefined);
    _setSnapshotFolderLauncherForTests(
      launch as unknown as SnapshotFolderLauncher,
      'aix',
    );

    expect(snapshotFolderAccessSupported()).toBe(false);
    await expect(store.openFolder()).rejects.toBeInstanceOf(SnapshotFolderLaunchError);
    expect(launch).not.toHaveBeenCalled();
  });
});
