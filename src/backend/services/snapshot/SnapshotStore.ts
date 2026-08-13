import path from 'path';
import { promises as fs } from 'fs';
import simpleGit from 'simple-git';
import { createLogger } from '@/utils/logger';
import { loadItem, saveItem } from '@/utils/storage/backend';
import { StorageKey, type Settings } from '@/shared/types/storage/storage';
import {
  DEFAULT_SNAPSHOT_RETENTION_POLICY,
  isSnapshotRetentionPolicy,
  type SnapshotActivity,
  type SnapshotRepositoryUsage,
  type SnapshotRetentionPolicy,
  type SnapshotStatus,
  type SnapshotUsage,
} from '@/shared/types/snapshot';

const log = createLogger('backend/services/snapshot/SnapshotStore');

let snapshotRootForTests: string | null = null;
let cleanupInProgress = false;

/** Test seam for an isolated workspace snapshot store. */
export function _setSnapshotStoreDirForTests(dir: string | null): string | null {
  const previous = snapshotRootForTests;
  snapshotRootForTests = dir;
  return previous;
}

function snapshotRoot(): string {
  if (snapshotRootForTests) return snapshotRootForTests;
  // Lazy to keep this service safe to import during client-side module analysis.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getWorkspaceDataDir } = require('@/utils/workspace');
  return path.join(getWorkspaceDataDir(), 'snapshots');
}

async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(child);
    else if (entry.isFile()) total += (await fs.stat(child)).size;
  }
  return total;
}

async function usageFor(id: string): Promise<SnapshotRepositoryUsage> {
  const gitDir = path.join(snapshotRoot(), id, 'git');
  const base: SnapshotRepositoryUsage = {
    id,
    label: `Snapshot repository ${id.slice(0, 8)}`,
    logicalBytes: 0,
    onDiskBytes: 0,
    commitCount: 0,
    health: 'healthy',
  };
  try {
    base.onDiskBytes = await directoryBytes(gitDir);
    // Git metadata only; this never points at or mutates a project worktree.
    const git = simpleGit(gitDir);
    const count = (await git.raw(['rev-list', '--count', '--all'])).trim();
    base.commitCount = Number.parseInt(count, 10) || 0;
    const dates = (await git.raw(['log', '--all', '--format=%ct', '--reverse'])).trim().split(/\s+/).filter(Boolean);
    if (dates[0]) base.oldestCaptureAt = new Date(Number(dates[0]) * 1000).toISOString();
    if (dates.length) base.newestCaptureAt = new Date(Number(dates[dates.length - 1]) * 1000).toISOString();
    // Git's packed object payload is the most portable logical-byte measure available
    // without reading project files. Directory footprint is reported separately.
    const objects = await git.raw(['count-objects', '-v']).catch(() => '');
    const sizePack = /^size-pack:\s*(\d+)/m.exec(objects);
    base.logicalBytes = sizePack ? Number(sizePack[1]) * 1024 : base.onDiskBytes;
  } catch (error) {
    base.health = 'corrupt';
    log.warn('Could not inventory shadow repository', { id, error });
  }
  return base;
}

export class SnapshotStore {
  async policy(): Promise<SnapshotRetentionPolicy> {
    try {
      const saved = await loadItem<unknown>(StorageKey.SNAPSHOT_RETENTION_POLICY, undefined);
      return isSnapshotRetentionPolicy(saved) ? saved : { ...DEFAULT_SNAPSHOT_RETENTION_POLICY };
    } catch (error) {
      log.warn('Could not load snapshot retention policy', error);
      return { ...DEFAULT_SNAPSHOT_RETENTION_POLICY };
    }
  }

  async updatePolicy(policy: SnapshotRetentionPolicy): Promise<SnapshotRetentionPolicy> {
    if (!isSnapshotRetentionPolicy(policy)) throw new Error('Invalid snapshot retention policy');
    await saveItem(StorageKey.SNAPSHOT_RETENTION_POLICY, policy);
    return policy;
  }

  async usage(): Promise<SnapshotUsage> {
    let ids: string[] = [];
    try {
      ids = (await fs.readdir(snapshotRoot(), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && /^[a-f0-9]{16}$/i.test(entry.name))
        .map((entry) => entry.name);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('Could not enumerate snapshot store', error);
    }
    const repositories = await Promise.all(ids.sort().map(usageFor));
    return {
      logicalBytes: repositories.reduce((sum, repository) => sum + repository.logicalBytes, 0),
      onDiskBytes: repositories.reduce((sum, repository) => sum + repository.onDiskBytes, 0),
      repositoryCount: repositories.length,
      repositories,
    };
  }

  async status(): Promise<SnapshotStatus> {
    const [policy, usage, settings] = await Promise.all([
      this.policy(),
      this.usage(),
      loadItem<Settings | undefined>(StorageKey.SPEECH_SETTINGS, undefined).catch(() => undefined),
    ]);
    const activity: SnapshotActivity = {
      capture: false,
      cleanup: cleanupInProgress,
      revert: false,
      migration: false,
      operatorDisabled: ['0', 'false', 'off'].includes((process.env.FLUJO_SNAPSHOTS || '').trim().toLowerCase())
        || settings?.experimental?.snapshotsEnabled === false,
      localFolderAccess: false,
    };
    return { policy, usage, activity };
  }

  /**
   * Safely reclaim derived history. Shadow repositories are deliberately removed
   * as whole units: their current linear commit topology keeps ancestor objects
   * reachable, so deleting individual refs would not reliably reclaim disk.
   */
  async cleanup(manual = false): Promise<{ deletedRepositoryIds: string[]; reclaimedBytes: number }> {
    if (cleanupInProgress) throw new Error('Snapshot cleanup is already in progress');
    cleanupInProgress = true;
    try {
      const policy = await this.policy();
      if (!manual && !policy.enabled) return { deletedRepositoryIds: [], reclaimedBytes: 0 };
      const usage = await this.usage();
      const now = Date.now();
      let remaining = usage.onDiskBytes;
      let reclaimedBytes = 0;
      const deletedRepositoryIds: string[] = [];
      const candidates = [...usage.repositories].sort((a, b) =>
        (a.oldestCaptureAt || '').localeCompare(b.oldestCaptureAt || ''));
      for (const repository of candidates) {
        const expired = !!repository.newestCaptureAt
          && now - Date.parse(repository.newestCaptureAt) > policy.maxAgeMs;
        const overCount = repository.commitCount > policy.maxCapturesPerRoot;
        const overBudget = remaining > policy.maxBytes;
        if (!expired && !overCount && !overBudget) continue;
        await fs.rm(path.join(snapshotRoot(), repository.id), { recursive: true, force: true });
        deletedRepositoryIds.push(repository.id);
        reclaimedBytes += repository.onDiskBytes;
        remaining -= repository.onDiskBytes;
      }
      return { deletedRepositoryIds, reclaimedBytes };
    } finally {
      cleanupInProgress = false;
    }
  }

  /** Delete only the derived workspace snapshot store; never a project path or .git. */
  async deleteAll(): Promise<{ deleted: boolean; reclaimedBytes: number }> {
    if (cleanupInProgress) throw new Error('Snapshot cleanup is already in progress');
    cleanupInProgress = true;
    try {
      const reclaimedBytes = (await this.usage()).onDiskBytes;
      await fs.rm(snapshotRoot(), { recursive: true, force: true });
      return { deleted: true, reclaimedBytes };
    } finally {
      cleanupInProgress = false;
    }
  }
}

export const snapshotStore = new SnapshotStore();
