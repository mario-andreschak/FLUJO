import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';

interface LaunchOptions {
  shell: false;
  detached: true;
  stdio: 'ignore';
}

export type SnapshotFolderLauncher = (
  executable: string,
  args: readonly string[],
  options: LaunchOptions,
) => Promise<void>;

const folderAccessActivity = new Map<string, number>();
let launcherForTests: SnapshotFolderLauncher | null = null;
let platformForTests: NodeJS.Platform | null = null;

export class SnapshotFolderLaunchError extends Error {
  constructor() {
    super('Unable to open snapshot folder');
    this.name = 'SnapshotFolderLaunchError';
  }
}

function activityKey(root: string): string {
  const resolved = path.resolve(root);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function executableFor(platform: NodeJS.Platform): string | null {
  if (platform === 'win32') return 'explorer.exe';
  if (platform === 'darwin') return 'open';
  if (platform === 'linux') return 'xdg-open';
  return null;
}

function launchProcess(
  executable: string,
  args: readonly string[],
  options: LaunchOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], options);
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export function snapshotFolderAccessSupported(): boolean {
  return executableFor(platformForTests ?? process.platform) !== null;
}

export function snapshotFolderAccessActivity(root: string): number {
  return folderAccessActivity.get(activityKey(root)) ?? 0;
}

/** Test-only launcher/platform seam. Passing null restores production behavior. */
export function _setSnapshotFolderLauncherForTests(
  launcher: SnapshotFolderLauncher | null,
  platform: NodeJS.Platform | null = null,
): void {
  launcherForTests = launcher;
  platformForTests = platform;
  folderAccessActivity.clear();
}

/**
 * Opens a server-resolved snapshot root. Callers must obtain the root from
 * SnapshotStore; request data is intentionally absent from this contract.
 */
export async function openSnapshotFolderAtRoot(root: string): Promise<void> {
  const executable = executableFor(platformForTests ?? process.platform);
  if (!executable) throw new SnapshotFolderLaunchError();

  const key = activityKey(root);
  folderAccessActivity.set(key, (folderAccessActivity.get(key) ?? 0) + 1);
  try {
    await fs.mkdir(root, { recursive: true });
    await (launcherForTests ?? launchProcess)(
      executable,
      [root],
      { shell: false, detached: true, stdio: 'ignore' },
    );
  } catch {
    throw new SnapshotFolderLaunchError();
  } finally {
    const remaining = (folderAccessActivity.get(key) ?? 1) - 1;
    if (remaining > 0) folderAccessActivity.set(key, remaining);
    else folderAccessActivity.delete(key);
  }
}
