import path from 'node:path';
import { promises as fs } from 'node:fs';
import simpleGit, { type SimpleGit } from 'simple-git';
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
import {
  SnapshotLeaseBusyError,
  snapshotOperationActivity,
  withSnapshotMigrationLeases,
  withSnapshotStoreLease,
  type SnapshotOperationKind,
} from './snapshotLock';

const log = createLogger('backend/services/snapshot/SnapshotStore');
const REPOSITORY_ID = /^[a-f0-9]{16}$/i;
const MIN_CAPTURE_FREE_BYTES = 64 * 1024 * 1024;

let snapshotRootForTests: string | null = null;
let lastCleanupAt: string | undefined;

export class SnapshotStoreBusyError extends SnapshotLeaseBusyError {
  constructor() {
    super();
    this.name = 'SnapshotStoreBusyError';
  }
}

/** Test seam for an isolated workspace snapshot store. */
export function _setSnapshotStoreDirForTests(dir: string | null): string | null {
  const previous = snapshotRootForTests;
  snapshotRootForTests = dir;
  lastCleanupAt = undefined;
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

function parseCountObjects(output: string, fallback: number): number {
  let logical = 0;
  for (const line of output.split(/\r?\n/)) {
    const [key, raw] = line.split(':').map(part => part.trim());
    const value = Number.parseInt(raw ?? '', 10);
    if (!Number.isFinite(value)) continue;
    if (key === 'size' || key === 'size-pack' || key === 'size-garbage') {
      logical += value * 1024;
    }
  }
  return logical || fallback;
}

function gitForSnapshot(gitDir: string): SimpleGit {
  return simpleGit(path.dirname(gitDir)).env('GIT_DIR', gitDir);
}

async function usageFor(root: string, id: string): Promise<SnapshotRepositoryUsage> {
  const gitDir = path.join(root, id, 'git');
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
    const git = gitForSnapshot(gitDir);
    // Reject stores with broken refs, missing reachable objects, or invalid
    // packs before presenting them as usable snapshot history.
    await git.raw(['fsck', '--full', '--no-dangling']);
    const count = (await git.raw(['rev-list', '--count', '--all'])).trim();
    base.commitCount = Number.parseInt(count, 10) || 0;
    const dates = (await git.raw([
      'log',
      '--all',
      '--format=%ct',
      '--reverse',
    ])).trim().split(/\s+/).filter(Boolean);
    if (dates[0]) base.oldestCaptureAt = new Date(Number(dates[0]) * 1000).toISOString();
    if (dates.length) {
      base.newestCaptureAt = new Date(Number(dates[dates.length - 1]) * 1000).toISOString();
    }
    base.logicalBytes = parseCountObjects(
      await git.raw(['count-objects', '-v']),
      base.onDiskBytes,
    );
  } catch (error) {
    base.health = 'corrupt';
    log.warn('Could not validate shadow repository', { id, error });
  }
  return base;
}

interface CaptureRef {
  ref: string;
  sha: string;
  createdAt: number;
}

async function captureRefs(gitDir: string): Promise<CaptureRef[]> {
  const output = await gitForSnapshot(gitDir).raw([
    'for-each-ref',
    '--sort=creatordate',
    '--format=%(refname)%00%(objectname)%00%(creatordate:unix)',
    'refs/flujo',
  ]);
  return output.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    const [ref, sha, timestamp] = line.split('\0');
    const createdAt = Number(timestamp) * 1000;
    return ref && /^[a-f0-9]{40,64}$/i.test(sha ?? '') && Number.isFinite(createdAt)
      ? [{ ref, sha, createdAt }]
      : [];
  });
}

async function compactRepository(gitDir: string): Promise<void> {
  const git = gitForSnapshot(gitDir);
  await git.raw(['reflog', 'expire', '--expire=now', '--all']);
  await git.raw(['gc', '--prune=now']);
}

async function availableBytes(candidate: string): Promise<number | undefined> {
  try {
    let current = candidate;
    while (true) {
      try {
        const stats = await fs.statfs(current);
        return Number(stats.bavail) * Number(stats.bsize);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = path.dirname(current);
        if (parent === current) throw error;
        current = parent;
      }
    }
  } catch (error) {
    log.debug('Filesystem free-space accounting unavailable', { error });
    return undefined;
  }
}

export class SnapshotStore {
  rootPath(): string {
    return snapshotRoot();
  }

  async policy(): Promise<SnapshotRetentionPolicy> {
    try {
      const saved = await loadItem<unknown>(StorageKey.SNAPSHOT_RETENTION_POLICY, undefined);
      return isSnapshotRetentionPolicy(saved)
        ? saved
        : { ...DEFAULT_SNAPSHOT_RETENTION_POLICY };
    } catch (error: unknown) {
      log.warn('Could not load snapshot retention policy', { error });
      return { ...DEFAULT_SNAPSHOT_RETENTION_POLICY };
    }
  }

  async updatePolicy(policy: SnapshotRetentionPolicy): Promise<SnapshotRetentionPolicy> {
    if (!isSnapshotRetentionPolicy(policy)) throw new Error('Invalid snapshot retention policy');
    await saveItem(StorageKey.SNAPSHOT_RETENTION_POLICY, policy);
    return policy;
  }

  async withAccess<T>(
    operation: SnapshotOperationKind,
    task: () => Promise<T>,
    options?: { failIfBusy?: boolean },
  ): Promise<T> {
    try {
      return await withSnapshotStoreLease(snapshotRoot(), operation, task, options);
    } catch (error) {
      if (error instanceof SnapshotLeaseBusyError) throw new SnapshotStoreBusyError();
      throw error;
    }
  }

  /** Compatibility alias for capture callers. */
  async withExclusiveAccess<T>(operation: () => Promise<T>): Promise<T> {
    return this.withAccess('capture', operation);
  }

  async withMigrationAccess<T>(
    roots: readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await withSnapshotMigrationLeases(roots, operation);
    } catch (error) {
      if (error instanceof SnapshotLeaseBusyError) throw new SnapshotStoreBusyError();
      throw error;
    }
  }

  async usageAt(root: string = snapshotRoot()): Promise<SnapshotUsage> {
    let ids: string[] = [];
    try {
      ids = (await fs.readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && REPOSITORY_ID.test(entry.name))
        .map((entry) => entry.name);
    } catch (error: unknown) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code !== 'ENOENT') log.warn('Could not enumerate snapshot store', { root, error });
    }
    // Keep Git subprocess lifetime bounded. A large workspace may contain many
    // repositories; serial inventory avoids process spikes and makes every child
    // settle before the status request returns.
    const repositories: SnapshotRepositoryUsage[] = [];
    for (const id of ids.sort()) repositories.push(await usageFor(root, id));
    return {
      logicalBytes: repositories.reduce((sum, repository) => sum + repository.logicalBytes, 0),
      onDiskBytes: repositories.reduce((sum, repository) => sum + repository.onDiskBytes, 0),
      repositoryCount: repositories.length,
      repositories,
      ...(root === snapshotRoot() && lastCleanupAt ? { lastCleanupAt } : {}),
    };
  }

  async usage(): Promise<SnapshotUsage> {
    return this.withAccess('read', () => this.usageAt());
  }

  async status(): Promise<SnapshotStatus> {
    const activityBeforeInventory = snapshotOperationActivity(snapshotRoot());
    const [policy, usage, settings] = await Promise.all([
      this.policy(),
      this.usage(),
      loadItem<Settings | undefined>(StorageKey.SPEECH_SETTINGS, undefined).catch(() => undefined),
    ]);
    const activityAfterInventory = snapshotOperationActivity(snapshotRoot());
    const operationWasActive = (operation: SnapshotOperationKind): boolean => (
      activityBeforeInventory[operation] > 0 || activityAfterInventory[operation] > 0
    );
    const operatorDisabled = ['0', 'false', 'off'].includes(
      (process.env.FLUJO_SNAPSHOTS || '').trim().toLowerCase(),
    ) || settings?.experimental?.snapshotsEnabled === false;
    const overBudget = policy.enabled && usage.onDiskBytes > policy.maxBytes;
    const activity: SnapshotActivity = {
      capture: operationWasActive('capture'),
      cleanup: operationWasActive('cleanup'),
      revert: operationWasActive('revert'),
      migration: operationWasActive('migration'),
      operatorDisabled,
      captureSuspended: overBudget,
      localFolderAccess: false,
    };
    return { policy, usage, activity, overBudget };
  }

  /**
   * Reclaim expired capture refs, expire reflogs, and compact packs. New-format
   * captures are parentless commits held by retention-owned refs, so pruning an
   * old ref can reclaim its objects without invalidating retained SHAs.
   */
  async cleanup(manual = false): Promise<{ deletedRepositoryIds: string[]; reclaimedBytes: number }> {
    return this.withAccess('cleanup', async () => {
      const policy = await this.policy();
      if (!manual && !policy.enabled) {
        return { deletedRepositoryIds: [], reclaimedBytes: 0 };
      }

      const before = await this.usage();
      const now = Date.now();
      const deletedRepositoryIds: string[] = [];
      for (const repository of before.repositories) {
        if (!REPOSITORY_ID.test(repository.id)) continue;
        const repositoryRoot = path.join(snapshotRoot(), repository.id);
        const gitDir = path.join(repositoryRoot, 'git');

        if (repository.health !== 'healthy') continue;
        const refs = await captureRefs(gitDir).catch(() => []);
        if (refs.length === 0) {
          // Legacy linear repositories have no independently expirable refs.
          // Remove them only when the whole repository is outside policy.
          const expired = Boolean(repository.newestCaptureAt)
            && now - Date.parse(repository.newestCaptureAt!) > policy.maxAgeMs;
          if (
            expired
            || repository.commitCount > policy.maxCapturesPerRoot
            || before.onDiskBytes > policy.maxBytes
          ) {
            await fs.rm(repositoryRoot, { recursive: true, force: true });
            deletedRepositoryIds.push(repository.id);
          }
          continue;
        }

        const keepByCount = new Set(
          policy.maxCapturesPerRoot === 0
            ? []
            : refs.slice(-policy.maxCapturesPerRoot).map(item => item.ref),
        );
        const remove = refs.filter(item => (
          !keepByCount.has(item.ref)
          || now - item.createdAt > policy.maxAgeMs
          || (repository.commitCount > policy.maxCapturesPerRoot
            && item.ref.startsWith('refs/flujo/legacy/'))
        ));
        const git = gitForSnapshot(gitDir);
        for (const item of remove) await git.raw(['update-ref', '-d', item.ref]);

        const remaining = refs.filter(item => !remove.some(removed => removed.ref === item.ref));
        if (remaining.length === 0) {
          await fs.rm(repositoryRoot, { recursive: true, force: true });
          deletedRepositoryIds.push(repository.id);
        } else if (remove.length > 0) {
          await git.raw(['update-ref', 'HEAD', remaining[remaining.length - 1].sha]);
          await compactRepository(gitDir);
        }
      }

      // Enforce the workspace byte ceiling by expiring oldest remaining refs one
      // at a time. Each pass compacts before re-accounting actual on-disk bytes.
      let current = await this.usage();
      while (policy.enabled && current.onDiskBytes > policy.maxBytes) {
        let oldest: { repository: SnapshotRepositoryUsage; capture: CaptureRef } | undefined;
        for (const repository of current.repositories) {
          if (repository.health !== 'healthy' || !REPOSITORY_ID.test(repository.id)) continue;
          const refs = await captureRefs(
            path.join(snapshotRoot(), repository.id, 'git'),
          ).catch(() => []);
          if (refs.length <= 1) continue;
          const capture = refs[0];
          if (!oldest || capture.createdAt < oldest.capture.createdAt) {
            oldest = { repository, capture };
          }
        }
        if (!oldest) {
          const victim = [...current.repositories]
            .filter(repository => REPOSITORY_ID.test(repository.id))
            .sort((left, right) => (
              (left.oldestCaptureAt ?? '').localeCompare(right.oldestCaptureAt ?? '')
            ))[0];
          if (!victim) break;
          await fs.rm(path.join(snapshotRoot(), victim.id), { recursive: true, force: true });
          if (!deletedRepositoryIds.includes(victim.id)) deletedRepositoryIds.push(victim.id);
        } else {
          const gitDir = path.join(snapshotRoot(), oldest.repository.id, 'git');
          await gitForSnapshot(gitDir).raw(['update-ref', '-d', oldest.capture.ref]);
          await compactRepository(gitDir);
        }
        current = await this.usage();
      }

      lastCleanupAt = new Date().toISOString();
      const after = await this.usage();
      return {
        deletedRepositoryIds,
        reclaimedBytes: Math.max(0, before.onDiskBytes - after.onDiskBytes),
      };
    }, { failIfBusy: true });
  }

  /** Delete only the derived workspace snapshot store; never a project path or .git. */
  async deleteAll(): Promise<{ deleted: boolean; reclaimedBytes: number }> {
    return this.withAccess('cleanup', async () => {
      const reclaimedBytes = (await this.usage()).onDiskBytes;
      await fs.rm(snapshotRoot(), { recursive: true, force: true });
      lastCleanupAt = new Date().toISOString();
      return { deleted: true, reclaimedBytes };
    }, { failIfBusy: true });
  }

  /**
   * Make a bounded best effort before a new capture. ENOSPC/low-free-space
   * conditions disable this capture only; project files and project Git remain
   * untouched.
   */
  async ensureCaptureCapacity(): Promise<boolean> {
    const policy = await this.policy();
    if (!policy.enabled) return true;

    let usage = await this.usage();
    let free = await availableBytes(snapshotRoot());
    if (usage.onDiskBytes <= policy.maxBytes && (free === undefined || free >= MIN_CAPTURE_FREE_BYTES)) {
      return true;
    }

    await this.cleanup().catch((error) => {
      if (!(error instanceof SnapshotStoreBusyError)) {
        log.warn('Pre-capture snapshot cleanup failed', { error });
      }
    });
    usage = await this.usage();
    free = await availableBytes(snapshotRoot());
    return usage.onDiskBytes <= policy.maxBytes
      && (free === undefined || free >= MIN_CAPTURE_FREE_BYTES);
  }
}

export const snapshotStore = new SnapshotStore();
