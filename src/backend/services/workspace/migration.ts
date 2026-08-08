import path from 'node:path';
import os from 'node:os';
import { constants as fsConstants, type Stats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { getAppDir, getDataDir } from '@/utils/paths';
import {
  DEFAULT_WORKSPACE,
  WORKSPACE_SUBTREES,
  ensureWorkspaceDirs,
  getWorkspaceDir,
  getWorkspacesDir,
} from '@/utils/workspace';
import { createLogger } from '@/utils/logger';
import {
  getWorkspaceLayoutPreparation,
  setWorkspaceLayoutPreparation,
} from './layoutReadiness';
import { WORKSPACE_LAYOUT_VERSION } from './layoutVersion';

export { WORKSPACE_LAYOUT_VERSION } from './layoutVersion';

const log = createLogger('backend/services/workspace/migration');

/**
 * Workspace layout bootstrap + legacy migration (#406).
 *
 * Before #406 the three writable subtrees lived directly under the data root:
 *
 *   <data root>/db, <data root>/mcp-servers, <data root>/userdata
 *
 * They now live one level deeper, inside a workspace:
 *
 *   <data root>/workspaces/default-workspace/{db,mcp-servers,userdata}
 *
 * This module runs BEFORE storage verification, MCP startup and the scheduler,
 * so nothing ever opens a legacy path after the move has started. It follows the
 * conventions already used by the shipped-server migration: one in-flight promise
 * shared by concurrent callers, cleared in `finally` so a failure is retryable,
 * and a durable marker so a completed migration is a cheap no-op forever after.
 *
 * The cardinal rule is **never merge and never overwrite**. Each subtree is
 * migrated independently and one of five things is true for it:
 *
 *   - no source            -> create the destination (fresh install)
 *   - source, empty dest   -> move it (rename, or verified copy across volumes)
 *   - empty source, dest   -> already migrated, drop the empty leftover
 *   - no source, dest      -> already migrated
 *   - both have content    -> preserve both copies; use the workspace copy
 *
 * That makes a fresh install, a legacy install, an already-migrated install, an
 * interrupted migration and two racing startups all deterministic.
 */

/** Bump when the on-disk layout changes again; older markers then re-run. */
export const WORKSPACE_LAYOUT_VERSION = 1;

const MARKER_FILE = '.workspace-layout.json';
const JOURNAL_FILE = '.workspace-layout.transaction.json';
const LOCK_DIR = '.workspace-layout.lock';
const TRANSACTIONS_DIR = '.workspace-migrations';
const OWNER_FILE = 'owner.json';
const HEARTBEAT_FILE = 'heartbeat';
const JOURNAL_SCHEMA_VERSION = 3;
const LOCK_HEARTBEAT_MS = 30_000;
const LOCK_LEASE_MS = 5 * 60_000;
const METADATA_RENAME_ATTEMPTS = 8;
const MAX_RECONCILIATION_PASSES = 8;

/** These are application source/runtime packages, not workspace-installed MCPs. */
const APP_OWNED_MCP_ENTRIES = new Set([
  'readme.md',
  'embed-shared.mjs',
  'bash',
  'browser',
  'filesystem',
  'flujo',
  'shared',
]);
const TRANSACTION_BACKUP_NAME = /^\..+\.workspace-v2-[0-9a-f-]+(?:\.destination)?\.bak$/i;

const LEGACY_DB_CANDIDATES = [
  ['db'],
  ['.next', 'storage'],
  ['storage'],
] as const;

const EXTRA_WORKSPACE_ROOTS = [
  'userdata',
  'snapshots',
  'screenshots',
  'recordings',
  'browser-profile',
  'bash-utils',
  'artifacts',
] as const;

export interface WorkspaceLayoutMarker {
  version: number;
  completedAt: string;
  defaultWorkspace: string;
  subtrees: Record<string, SubtreeOutcome>;
  transactionId?: string;
  manifestDigest?: string;
}

export type SubtreeOutcome =
  | 'created'
  | 'moved'
  | 'copied'
  | 'already-migrated'
  | 'recovered-identical'
  | 'reconciled'
  | 'skipped';

const SUBTREE_OUTCOMES = new Set<SubtreeOutcome>([
  'created',
  'moved',
  'copied',
  'already-migrated',
  'recovered-identical',
  'reconciled',
  'skipped',
]);
const JOURNAL_STATES = new Set<JournalEntry['state']>([
  'planned',
  'staged',
  'sources-archived',
  'destination-archived',
  'published',
]);
const JOURNAL_PHASES = new Set<MigrationJournal['phase']>([
  'planned',
  'staging',
  'committing',
  'marker',
  'cleanup',
  'committed',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

type ManifestEntry = {
  relativePath: string;
  type: 'directory' | 'file' | 'symlink';
  /** Portable permission bits. File type bits are represented by `type`. */
  mode?: number;
  size?: number;
  sha256?: string;
  /** File access time is preserved but intentionally excluded from content identity. */
  atimeMs?: number;
  /** File modification time is preserved but not treated as content identity. */
  mtimeMs?: number;
  linkTarget?: string;
  linkType?: 'file' | 'directory' | 'junction';
};

type PathManifest = {
  entries: ManifestEntry[];
  digest: string;
  emptyDirectory: boolean;
};

type JournalSource = {
  path: string;
  backup: string;
  initialDigest?: string;
  retainedMount?: boolean;
  /** Preflight inventory used for idempotent, post-marker mount cleanup. */
  retainedEntries?: ManifestEntry[];
  /** Durable deletion intent: a partial recursive delete is safe to resume. */
  cleanupStarted?: boolean;
};

type JournalEntry = {
  id: string;
  subtree: string;
  sources: JournalSource[];
  destination: string;
  destinationBackup: string;
  initialDestinationDigest?: string;
  stage: string;
  expectedDigest: string;
  /** Durable merged metadata; recovery must not rediscover timestamps after a crash. */
  expectedEntries: ManifestEntry[];
  state: 'planned' | 'staged' | 'sources-archived' | 'destination-archived' | 'published';
  outcome: SubtreeOutcome;
  requireDirectory: boolean;
  /** Durable deletion intents for transaction-owned post-marker artifacts. */
  destinationBackupCleanupStarted?: boolean;
  stageCleanupStarted?: boolean;
};

type MigrationJournal = {
  schemaVersion: number;
  targetVersion: number;
  transactionId: string;
  createdAt: string;
  phase: 'planned' | 'staging' | 'committing' | 'marker' | 'cleanup' | 'committed';
  entries: JournalEntry[];
};

type CandidateEntry = {
  id: string;
  subtree: string;
  sources: string[];
  destination: string;
  requireDirectory: boolean;
};

type LockOwner = {
  token: string;
  pid: number;
  hostname: string;
  startedAt: string;
  heartbeatAt: string;
};

export class WorkspaceMigrationConflictError extends Error {
  readonly code = 'WORKSPACE_MIGRATION_CONFLICT';

  constructor(subtree: string, source: string, destination: string, detail?: string) {
    super(
      `Cannot migrate "${subtree}" into the default workspace because managed ` +
        `copies disagree.\n  legacy:    ${source}\n  workspace: ${destination}\n` +
        `${detail ? `  detail:     ${detail}\n` : ''}` +
        `FLUJO did not overwrite either copy. Back up both locations and resolve ` +
        `the conflicting path before retrying.`,
    );
    this.name = 'WorkspaceMigrationConflictError';
  }
}

export class WorkspaceMigrationMarkerError extends Error {
  readonly code = 'WORKSPACE_MIGRATION_MARKER_INVALID';
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkspaceMigrationMarkerError';
  }
}

export class WorkspaceMigrationLockedError extends Error {
  readonly code = 'WORKSPACE_MIGRATION_LOCKED';
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceMigrationLockedError';
  }
}

export class WorkspaceMigrationUnsafePathError extends Error {
  readonly code = 'WORKSPACE_MIGRATION_UNSAFE_PATH';
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceMigrationUnsafePathError';
  }
}

type FaultHook = (checkpoint: string) => void | Promise<void>;
let faultHook: FaultHook | undefined;
let lockHeartbeatIntervalMs = LOCK_HEARTBEAT_MS;
let mountInfoForTests: string | undefined;

/** Test-only fault injection seam. FLUJO_DATA_DIR must point at a temp fixture. */
export function _setWorkspaceMigrationFaultForTests(hook?: FaultHook): void {
  faultHook = hook;
}

export function _setWorkspaceMigrationHeartbeatMsForTests(value?: number): void {
  lockHeartbeatIntervalMs = value ?? LOCK_HEARTBEAT_MS;
}

/** Test-only Linux mount-table injection; avoids requiring mount privileges. */
export function _setWorkspaceMigrationMountInfoForTests(value?: string): void {
  mountInfoForTests = value;
}

export function _resetWorkspaceMigrationState(): void {
  setWorkspaceLayoutPreparation(undefined);
  faultHook = undefined;
  lockHeartbeatIntervalMs = LOCK_HEARTBEAT_MS;
  mountInfoForTests = undefined;
}

export function _workspaceMigrationPathsForTests(): {
  marker: string;
  journal: string;
  lock: string;
  transactions: string;
} {
  return {
    marker: markerPath(),
    journal: journalPath(),
    lock: lockPath(),
    transactions: transactionsPath(),
  };
}

async function checkpoint(name: string): Promise<void> {
  await faultHook?.(name);
}

export function migrateWorkspaceLayout(): Promise<WorkspaceLayoutMarker> {
  const existing = getWorkspaceLayoutPreparation<WorkspaceLayoutMarker>();
  if (existing) return existing;
  const promise = runMigration().catch(error => {
    if (getWorkspaceLayoutPreparation() === promise) {
      setWorkspaceLayoutPreparation(undefined);
    }
    throw error;
  });
  setWorkspaceLayoutPreparation(promise);
  return promise;
}

export const ensureWorkspaceLayoutReady = migrateWorkspaceLayout;

function markerPath(): string {
  return path.join(getWorkspacesDir(), MARKER_FILE);
}

function journalPath(): string {
  return path.join(getWorkspacesDir(), JOURNAL_FILE);
}

function lockPath(): string {
  return path.join(getWorkspacesDir(), LOCK_DIR);
}

function transactionsPath(): string {
  return path.join(getWorkspacesDir(), TRANSACTIONS_DIR);
}

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isContainedOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isStrictlyContained(root: string, candidate: string): boolean {
  return !samePath(root, candidate) && isContainedOrEqual(root, candidate);
}

async function lstatOptional(candidate: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(candidate) as Stats;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function assertNotSymlink(candidate: string, label: string): Promise<void> {
  const stat = await lstatOptional(candidate);
  if (stat?.isSymbolicLink()) {
    throw new WorkspaceMigrationUnsafePathError(`${label} must not be a symlink or junction: ${candidate}`);
  }
}

async function assertRealDirectory(candidate: string, label: string): Promise<void> {
  const stat = await lstatOptional(candidate);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new WorkspaceMigrationUnsafePathError(
      `${label} must be a real directory, not a file, symlink, or junction: ${candidate}`,
    );
  }
}

async function prepareRoots(): Promise<void> {
  const dataRoot = getDataDir();
  const workspacesRoot = getWorkspacesDir();
  await fs.mkdir(dataRoot, { recursive: true });
  await assertRealDirectory(dataRoot, 'FLUJO data root');
  await assertNotSymlink(workspacesRoot, 'Workspaces root');
  await fs.mkdir(workspacesRoot, { recursive: true });
  await assertRealDirectory(workspacesRoot, 'Workspaces root');

  const diskEntries = await fs.readdir(workspacesRoot);
  const aliases = diskEntries.filter(name => name.toLowerCase() === DEFAULT_WORKSPACE.toLowerCase());
  if (aliases.some(name => name !== DEFAULT_WORKSPACE) || aliases.length > 1) {
    throw new WorkspaceMigrationUnsafePathError(
      `Default workspace has a case-alias collision: ${aliases.join(', ')}`,
    );
  }

  const workspaceRoot = getWorkspaceDir(DEFAULT_WORKSPACE);
  await assertNotSymlink(workspaceRoot, 'Default workspace root');
  await fs.mkdir(workspaceRoot, { recursive: true });
  await assertRealDirectory(workspaceRoot, 'Default workspace root');
  const canonicalWorkspaces = await fs.realpath(workspacesRoot);
  const canonicalWorkspace = await fs.realpath(workspaceRoot);
  if (!isStrictlyContained(canonicalWorkspaces, canonicalWorkspace)) {
    throw new WorkspaceMigrationUnsafePathError(
      `Default workspace escapes the workspaces root: ${workspaceRoot}`,
    );
  }
  await assertNotSymlink(markerPath(), 'Workspace layout marker');
  await assertNotSymlink(journalPath(), 'Workspace migration journal');
}

async function migrateSubtree(
  subtree: WorkspaceSubtree,
  source: string,
  destination: string,
): Promise<SubtreeOutcome> {
  const sourceState = await inspect(source);
  const destinationState = await inspect(destination);

  // Fresh install (or a subtree this install never used): just create it.
  if (sourceState === 'missing') {
    await fs.mkdir(destination, { recursive: true });
    return destinationState === 'missing' ? 'created' : 'already-migrated';
  }

  // Something that isn't a directory is not ours to move.
  if (sourceState === 'other') {
    log.warn(`Legacy "${subtree}" is not a directory — leaving it untouched`, { source });
    await fs.mkdir(destination, { recursive: true });
    return 'skipped';
  }

  if (destinationState === 'other') {
    throw new WorkspaceMigrationConflictError(subtree, source, destination);
  }

  if (sourceState === 'empty') {
    // Nothing to preserve. Remove the empty leftover so a half-finished run
    // doesn't look like a legacy install forever.
    await fs.mkdir(destination, { recursive: true });
    await fs.rmdir(source).catch(() => {
      /* still in use / not empty any more — harmless */
    });
    return destinationState === 'missing' ? 'created' : 'already-migrated';
  }

  // Source and destination both have data. This is a normal upgrade state when
  // an operator has already created (or restored) the default workspace before
  // upgrading. Never merge or overwrite: the workspace copy is authoritative
  // and the legacy copy remains available for explicit recovery.
  if (destinationState === 'populated') {
    log.warn(
      `Both legacy and default-workspace \"${subtree}\" contain data; leaving both copies untouched`,
      { source, destination },
    );
    return 'skipped';
  }

  // Destination missing or empty: safe to move the whole subtree.
  if (destinationState === 'empty') {
    // rename() onto an existing directory is portable only when the target is
    // absent, so clear the empty placeholder first.
    await fs.rmdir(destination).catch(() => undefined);
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
}

async function syncDirectory(candidate: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;

  try {
    handle = await fs.open(candidate, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR', 'EBADF'].includes(
      (error as NodeJS.ErrnoException).code ?? '',
    )) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function renameWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        attempt >= METADATA_RENAME_ATTEMPTS
        || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')
      ) throw error;
      await new Promise(resolve => setTimeout(resolve, attempt * 25));
    }
  }
}

async function writeJsonAtomic(
  file: string,
  value: unknown,
  options: { createParent?: boolean } = {},
): Promise<void> {
  await assertNotSymlink(file, 'Migration metadata file');
  const parent = path.dirname(file);
  if (options.createParent === false) {
    await assertRealDirectory(parent, 'Migration metadata parent');
  } else {
    await fs.mkdir(parent, { recursive: true });
  }
  const temp = path.join(parent, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameWithRetry(temp, file);
    await syncDirectory(parent);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temp).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}

async function readLockOwner(dir: string): Promise<LockOwner | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, OWNER_FILE), 'utf8')) as LockOwner;
    if (
      typeof parsed?.token === 'string'
      && Number.isInteger(parsed.pid)
      && typeof parsed.hostname === 'string'
      && typeof parsed.startedAt === 'string'
      && typeof parsed.heartbeatAt === 'string'
    ) return parsed;
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function lockHeartbeatTime(dir: string, owner: LockOwner): Promise<number> {
  const file = path.join(dir, HEARTBEAT_FILE);
  const stat = await lstatOptional(file);
  if (!stat) return Date.parse(owner.heartbeatAt);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new WorkspaceMigrationUnsafePathError(`Migration heartbeat is not a regular file: ${file}`);
  }
  const token = await fs.readFile(file, 'utf8');
  if (token !== owner.token) {
    throw new WorkspaceMigrationUnsafePathError(`Migration heartbeat token does not match its owner: ${file}`);
  }
  return stat.mtimeMs;
}

async function pidIsAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function removeStaleLockIfSafe(dir: string): Promise<boolean> {
  const stat = await lstatOptional(dir);
  if (!stat) return true;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new WorkspaceMigrationUnsafePathError(`Migration lock is not a real directory: ${dir}`);
  }
  const owner = await readLockOwner(dir);
  if (owner) {
    const heartbeat = await lockHeartbeatTime(dir, owner);
    const expired = !Number.isFinite(heartbeat) || Date.now() - heartbeat > LOCK_LEASE_MS;
    if (owner.hostname === os.hostname()) {
      if (await pidIsAlive(owner.pid)) return false;
    } else if (!expired) {
      return false;
    }
  } else if (Date.now() - stat.mtimeMs <= LOCK_LEASE_MS) {
    return false;
  }
  // Atomically move the stale lock out of the acquisition path before deleting
  // it. A second reclaimer may observe ENOENT, while a new owner can safely mkdir
  // the original path without its lock being removed by our cleanup.
  const quarantine = path.join(
    path.dirname(dir),
    `.${path.basename(dir)}.stale-${process.pid}-${randomUUID()}`,
  );
  try {
    await renameWithRetry(dir, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  await fs.rm(quarantine, { recursive: true, force: false });
  return true;
}

async function acquireMigrationLock(): Promise<{ release(): Promise<void> }> {
  const dir = lockPath();
  const owner: LockOwner = {
    token: randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.mkdir(dir);
      let heartbeatHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        await writeJsonAtomic(path.join(dir, OWNER_FILE), owner);
        heartbeatHandle = await fs.open(path.join(dir, HEARTBEAT_FILE), 'wx+', 0o600);
        await heartbeatHandle.writeFile(owner.token, 'utf8');
        await heartbeatHandle.sync();
        await syncDirectory(dir);
      } catch (error) {
        // mkdir is the lock acquisition. If publishing our owner record fails,
        // do not strand an unreadable lock that would block every later start.
        await heartbeatHandle?.close().catch(() => undefined);
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      let released = false;
      let heartbeatTask: Promise<void> | undefined;
      const heartbeat = setInterval(() => {
        if (released || heartbeatTask) return;
        heartbeatTask = (async () => {
          const current = await readLockOwner(dir);
          if (released || current?.token !== owner.token) return;
          owner.heartbeatAt = new Date().toISOString();
          await checkpoint('before-lock-heartbeat-write');
          if (released) return;
          // Update the file opened when this lock was acquired. If another host
          // has reclaimed/renamed our expired directory, this handle still
          // points at the old inode and can never overwrite the successor's
          // owner metadata at the reused path.
          const now = new Date();
          await heartbeatHandle!.utimes(now, now);
          await heartbeatHandle!.sync();
        })().catch(error => log.warn('Workspace migration lock heartbeat failed', error))
          .finally(() => { heartbeatTask = undefined; });
      }, lockHeartbeatIntervalMs);
      heartbeat.unref?.();
      return {
        async release() {
          released = true;
          clearInterval(heartbeat);
          await heartbeatTask;
          await heartbeatHandle?.close();
          const current = await readLockOwner(dir).catch(() => undefined);
          if (current?.token === owner.token) await fs.rm(dir, { recursive: true, force: false });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (attempt === 0 && await removeStaleLockIfSafe(dir)) continue;
      const current = await readLockOwner(dir).catch(() => undefined);
      throw new WorkspaceMigrationLockedError(
        `Another FLUJO process is migrating the workspace layout` +
        `${current ? ` (pid ${current.pid} on ${current.hostname})` : ''}.`,
      );
    }
  }
  throw new WorkspaceMigrationLockedError('Could not acquire the workspace migration lock.');
}

async function readMarker(): Promise<WorkspaceLayoutMarker | undefined> {
  const file = markerPath();
  const stat = await lstatOptional(file);
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new WorkspaceMigrationMarkerError(`Workspace layout marker is not a regular file: ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    throw new WorkspaceMigrationMarkerError(`Workspace layout marker is corrupt or unreadable: ${file}`, {
      cause: error,
    });
  }
  const marker = parsed as Partial<WorkspaceLayoutMarker>;
  if (!Number.isInteger(marker.version) || (marker.version ?? 0) < 1) {
    throw new WorkspaceMigrationMarkerError(`Workspace layout marker has an invalid version: ${file}`);
  }
  if ((marker.version ?? 0) > WORKSPACE_LAYOUT_VERSION) {
    throw new WorkspaceMigrationMarkerError(
      `Workspace layout version ${marker.version} is newer than this FLUJO build supports ` +
      `(maximum ${WORKSPACE_LAYOUT_VERSION}). Refusing to modify it.`,
    );
  }
  if (
    typeof marker.completedAt !== 'string'
    || !Number.isFinite(Date.parse(marker.completedAt))
    || marker.defaultWorkspace !== DEFAULT_WORKSPACE
    || !marker.subtrees
    || typeof marker.subtrees !== 'object'
  ) {
    throw new WorkspaceMigrationMarkerError(`Workspace layout marker has an invalid schema: ${file}`);
  }
  if (marker.version === WORKSPACE_LAYOUT_VERSION) {
    if (
      typeof marker.transactionId !== 'string'
      || !UUID_PATTERN.test(marker.transactionId)
      || typeof marker.manifestDigest !== 'string'
      || !SHA256_PATTERN.test(marker.manifestDigest)
      || WORKSPACE_SUBTREES.some(subtree => !SUBTREE_OUTCOMES.has(
        (marker.subtrees as Record<string, SubtreeOutcome>)[subtree],
      ))
    ) {
      throw new WorkspaceMigrationMarkerError(`Workspace layout v2 marker is incomplete: ${file}`);
    }
  }
  return marker as WorkspaceLayoutMarker;
}

async function readJournal(): Promise<MigrationJournal | undefined> {
  const file = journalPath();
  const stat = await lstatOptional(file);
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new WorkspaceMigrationMarkerError(`Workspace migration journal is not a regular file: ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    throw new WorkspaceMigrationMarkerError(`Workspace migration journal is corrupt or unreadable: ${file}`, {
      cause: error,
    });
  }
  const journal = parsed as Partial<MigrationJournal>;
  if (
    journal.schemaVersion !== JOURNAL_SCHEMA_VERSION
    || journal.targetVersion !== WORKSPACE_LAYOUT_VERSION
    || typeof journal.transactionId !== 'string'
    || !Array.isArray(journal.entries)
  ) {
    throw new WorkspaceMigrationMarkerError(`Workspace migration journal has an unsupported schema: ${file}`);
  }
  validateJournalPaths(journal as MigrationJournal);
  await validateJournalDiskCandidates(journal as MigrationJournal);
  return journal as MigrationJournal;
}

function pathExactlyMatches(actual: unknown, expected: string): actual is string {
  return typeof actual === 'string'
    && path.isAbsolute(actual)
    && path.normalize(actual) === path.normalize(expected);
}

function isDigest(value: unknown, optional = false): value is string | undefined {
  return (optional && value === undefined)
    || (typeof value === 'string' && SHA256_PATTERN.test(value));
}

function isMode(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0o777;
}

function validateRetainedManifest(entries: unknown, digest: string | undefined): entries is ManifestEntry[] {
  if (!Array.isArray(entries) || !digest || entries.length === 0) return false;
  const seen = new Set<string>();
  for (const value of entries) {
    const entry = value as Partial<ManifestEntry>;
    if (
      !entry
      || typeof entry.relativePath !== 'string'
      || entry.relativePath.includes('\0')
      || entry.relativePath.includes('\\')
      || path.posix.isAbsolute(entry.relativePath)
      || (
        entry.relativePath !== ''
        && entry.relativePath.split('/').some(part => part === '.' || part === '..' || part === '')
      )
      || seen.has(entry.relativePath)
      || !['directory', 'file', 'symlink'].includes(entry.type ?? '')
    ) return false;
    seen.add(entry.relativePath);
    if (
      entry.type === 'file'
      && (
        !isMode(entry.mode)
        || !Number.isSafeInteger(entry.size)
        || (entry.size ?? -1) < 0
        || !isDigest(entry.sha256)
        || !Number.isFinite(entry.atimeMs)
        || !Number.isFinite(entry.mtimeMs)
      )
    ) return false;
    if (entry.type === 'directory' && !isMode(entry.mode)) return false;
    if (
      entry.type === 'symlink'
      && (
        typeof entry.linkTarget !== 'string'
        || path.isAbsolute(entry.linkTarget)
        || !['file', 'directory', 'junction'].includes(entry.linkType ?? '')
      )
    ) return false;
  }
  if (!seen.has('') || entries.find(entry => entry.relativePath === '')?.type !== 'directory') return false;
  return manifestFromEntries(entries as ManifestEntry[]).digest === digest;
}

function validateJournalPaths(journal: MigrationJournal): void {
  const transactionRoot = path.join(transactionsPath(), journal.transactionId);
  if (!UUID_PATTERN.test(journal.transactionId)) {
    throw new WorkspaceMigrationMarkerError('Workspace migration journal has an invalid transaction id.');
  }
  if (
    typeof journal.createdAt !== 'string'
    || !Number.isFinite(Date.parse(journal.createdAt))
    || !JOURNAL_PHASES.has(journal.phase)
  ) {
    throw new WorkspaceMigrationMarkerError('Workspace migration journal has invalid lifecycle metadata.');
  }
  const ids = new Set<string>();
  for (const entry of journal.entries) {
    if (!entry || typeof entry.id !== 'string' || ids.has(entry.id)) {
      throw new WorkspaceMigrationMarkerError('Workspace migration journal contains duplicate/invalid entries.');
    }
    ids.add(entry.id);
    const expected = candidateForJournalId(entry.id);
    if (!expected) {
      throw new WorkspaceMigrationMarkerError(`Workspace migration journal has an unknown entry: ${entry.id}`);
    }
    if (
      entry.subtree !== expected.subtree
      || entry.requireDirectory !== expected.requireDirectory
      || !Array.isArray(entry.sources)
      || entry.sources.length !== expected.sources.length
      || !pathExactlyMatches(entry.destination, expected.destination)
      || !pathExactlyMatches(
        entry.destinationBackup,
        backupPath(expected.destination, journal.transactionId, true),
      )
      || !pathExactlyMatches(
        entry.stage,
        path.join(transactionRoot, 'stage', safeStageName(entry.id)),
      )
      || !isDigest(entry.expectedDigest)
      || !validateRetainedManifest(entry.expectedEntries, entry.expectedDigest)
      || !isDigest(entry.initialDestinationDigest, true)
      || !JOURNAL_STATES.has(entry.state)
      || !SUBTREE_OUTCOMES.has(entry.outcome)
    ) {
      throw new WorkspaceMigrationMarkerError(
        `Workspace migration journal entry does not match the derived plan: ${entry.id}`,
      );
    }
    if (
      entry.sources.some(source => {
        if (!source || typeof source !== 'object') return true;
        return source.retainedMount === true
          ? !validateRetainedManifest(source.retainedEntries, source.initialDigest)
          : source.retainedMount !== undefined || source.retainedEntries !== undefined;
      })
    ) {
      throw new WorkspaceMigrationMarkerError(
        `Workspace migration journal has invalid retained-mount metadata: ${entry.id}`,
      );
    }
    if (
      entry.sources.some(source => source.cleanupStarted !== undefined && typeof source.cleanupStarted !== 'boolean')
      || (
        entry.destinationBackupCleanupStarted !== undefined
        && typeof entry.destinationBackupCleanupStarted !== 'boolean'
      )
      || (entry.stageCleanupStarted !== undefined && typeof entry.stageCleanupStarted !== 'boolean')
    ) {
      throw new WorkspaceMigrationMarkerError(
        `Workspace migration journal has invalid cleanup metadata: ${entry.id}`,
      );
    }
    for (let index = 0; index < expected.sources.length; index++) {
      const source = entry.sources[index];
      const expectedSource = expected.sources[index];
      if (
        !source
        || !pathExactlyMatches(source.path, expectedSource)
        || !pathExactlyMatches(source.backup, backupPath(expectedSource, journal.transactionId))
        || !isDigest(source.initialDigest, true)
      ) {
        throw new WorkspaceMigrationMarkerError(
          `Workspace migration journal source does not match the derived plan: ${entry.id}`,
        );
      }
    }
    if (entry.id.startsWith('mcp-servers/') && !entry.sources[0]?.initialDigest) {
      throw new WorkspaceMigrationMarkerError(
        `Dynamic MCP journal entry has no preflight digest: ${entry.id}`,
      );
    }
  }

  for (const required of baseCandidates()) {
    if (!ids.has(required.id)) {
      throw new WorkspaceMigrationMarkerError(
        `Workspace migration journal is missing required entry: ${required.id}`,
      );
    }
  }
}

async function validateJournalDiskCandidates(journal: MigrationJournal): Promise<void> {
  if (!applicationSharesDataRoot()) return;
  const mcpRoot = path.join(getDataDir(), 'mcp-servers');
  const stat = await lstatOptional(mcpRoot);
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new WorkspaceMigrationMarkerError(`Journal MCP root is unsafe: ${mcpRoot}`);
  }
  const journalIds = new Set(journal.entries.map(entry => entry.id));
  const sourceBackupSuffix = `.workspace-v2-${journal.transactionId}.bak`;
  for (const entry of await fs.readdir(mcpRoot, { withFileTypes: true })) {
    if (APP_OWNED_MCP_ENTRIES.has(entry.name.toLowerCase())) continue;
    let runtimeName = entry.name;
    if (TRANSACTION_BACKUP_NAME.test(entry.name)) {
      if (!entry.name.startsWith('.') || !entry.name.endsWith(sourceBackupSuffix)) {
        throw new WorkspaceMigrationMarkerError(
          `Unrelated/orphaned migration backup exists beside the journal: ${path.join(mcpRoot, entry.name)}`,
        );
      }
      runtimeName = entry.name.slice(1, -sourceBackupSuffix.length);
    }
    const id = `mcp-servers/${runtimeName}`;
    if (!candidateForJournalId(id) || !journalIds.has(id)) {
      throw new WorkspaceMigrationMarkerError(
        `Workspace migration journal omits runtime MCP data: ${path.join(mcpRoot, entry.name)}`,
      );
    }
  }
}

async function writeJournal(journal: MigrationJournal): Promise<void> {
  validateJournalPaths(journal);
  await writeJsonAtomic(journalPath(), journal);
}

function permissionMode(stat: Stats): number {
  return stat.mode & 0o777;
}

function defaultDirectoryMode(): number {
  // Node reports Windows directory permissions as 0666 even after chmod(0777).
  // Use the platform's observable value so a freshly staged empty directory
  // hashes exactly like the directory that was materialized.
  return process.platform === 'win32' ? 0o666 : 0o777 & ~process.umask();
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function assertManagedPathAncestors(candidate: string): Promise<void> {
  const dataRoot = path.resolve(getDataDir());
  const resolved = path.resolve(candidate);
  if (!isContainedOrEqual(dataRoot, resolved)) {
    throw new WorkspaceMigrationUnsafePathError(`Managed path escapes the FLUJO data root: ${candidate}`);
  }
  const relative = path.relative(dataRoot, resolved);
  let cursor = dataRoot;
  const segments = relative ? relative.split(path.sep).filter(Boolean) : [];
  for (let index = 0; index < segments.length; index++) {
    cursor = path.join(cursor, segments[index]);
    const stat = await lstatOptional(cursor);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw new WorkspaceMigrationUnsafePathError(
        `Managed path has a symlink or junction ancestor: ${cursor}`,
      );
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new WorkspaceMigrationUnsafePathError(`Managed path ancestor is not a directory: ${cursor}`);
    }
  }
  const stat = await lstatOptional(resolved);
  if (!stat) return;
  const [canonicalDataRoot, canonicalCandidate] = await Promise.all([
    fs.realpath(dataRoot),
    fs.realpath(resolved),
  ]);
  if (!isContainedOrEqual(canonicalDataRoot, canonicalCandidate)) {
    throw new WorkspaceMigrationUnsafePathError(`Managed path resolves outside FLUJO data: ${candidate}`);
  }
}

async function hashFile(file: string): Promise<{
  mode: number;
  size: number;
  sha256: string;
  atimeMs: number;
  mtimeMs: number;
}> {
  const before = await fs.lstat(file) as Stats;
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new WorkspaceMigrationUnsafePathError(`Expected a regular file while hashing: ${file}`);
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(file, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat() as Stats;
    if (
      !opened.isFile()
      || opened.nlink !== before.nlink
      || !sameFileIdentity(before, opened)
      || opened.size !== before.size
      || permissionMode(opened) !== permissionMode(before)
    ) {
      throw new WorkspaceMigrationUnsafePathError(`File changed or escaped while being opened: ${file}`);
    }
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk as Buffer);
    }
    const [afterHandle, afterPath] = await Promise.all([
      handle.stat() as Promise<Stats>,
      fs.lstat(file) as Promise<Stats>,
    ]);
    if (
      !afterHandle.isFile()
      || !afterPath.isFile()
      || afterHandle.nlink !== opened.nlink
      || afterPath.nlink !== opened.nlink
      || !sameFileIdentity(opened, afterHandle)
      || !sameFileIdentity(opened, afterPath)
      || afterHandle.size !== opened.size
      || afterPath.size !== opened.size
      || afterHandle.mtimeMs !== opened.mtimeMs
      || afterPath.mtimeMs !== opened.mtimeMs
      || afterHandle.ctimeMs !== opened.ctimeMs
      || afterPath.ctimeMs !== opened.ctimeMs
      || permissionMode(afterHandle) !== permissionMode(opened)
      || permissionMode(afterPath) !== permissionMode(opened)
    ) throw new Error(`Workspace migration source changed while it was being read: ${file}`);
    return {
      mode: permissionMode(afterHandle),
      size: afterHandle.size,
      sha256: hash.digest('hex'),
      // Reading a file can itself advance atime. Capture the pre-read value so
      // the migration preserves user metadata rather than its own observation.
      atimeMs: before.atimeMs,
      mtimeMs: afterHandle.mtimeMs,
    };
  } finally {
    await handle.close();
  }
}

function manifestFromEntries(entries: ManifestEntry[]): PathManifest {
  const sorted = [...entries].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  // Timestamps are durable metadata, but they cannot be part of merge/content
  // identity: inventory reads can advance atime, and two byte-identical legacy
  // copies commonly have distinct mtimes. The journal and completion-marker
  // digest still authenticate the full expectedEntries chosen at preflight.
  const identityEntries = sorted.map(({
    atimeMs: _atimeMs,
    mtimeMs: _mtimeMs,
    ...entry
  }) => entry);
  return {
    entries: sorted,
    digest: createHash('sha256').update(JSON.stringify(identityEntries)).digest('hex'),
    emptyDirectory: sorted.length === 1 && sorted[0].relativePath === '' && sorted[0].type === 'directory',
  };
}

function manifestEntryEqual(a: ManifestEntry, b: ManifestEntry): boolean {
  return a.type === b.type
    && a.mode === b.mode
    && a.size === b.size
    && a.sha256 === b.sha256
    && a.linkTarget === b.linkTarget
    && a.linkType === b.linkType;
}

function mergeManifests(
  manifests: Array<{ label: string; manifest: PathManifest }>,
  subtree: string,
  destination: string,
): PathManifest {
  const merged = new Map<string, { entry: ManifestEntry; label: string }>();
  for (const { label, manifest } of manifests) {
    for (const entry of manifest.entries) {
      const prior = merged.get(entry.relativePath);
      if (!prior) {
        merged.set(entry.relativePath, { entry, label });
        continue;
      }
      if (!manifestEntryEqual(prior.entry, entry)) {
        throw new WorkspaceMigrationConflictError(
          subtree,
          prior.label,
          destination,
          `overlapping path ${JSON.stringify(entry.relativePath || '.')} differs in ${label}`,
        );
      }
    }
  }
  if (merged.size === 0) {
    return manifestFromEntries([{
      relativePath: '',
      type: 'directory',
      mode: defaultDirectoryMode(),
    }]);
  }
  return manifestFromEntries([...merged.values()].map(value => value.entry));
}

async function validateSymlink(
  root: string,
  link: string,
  target: string,
  relocatedRootAliases: string[] = [],
): Promise<{ linkTarget: string; linkType: 'file' | 'directory' | 'junction' }> {
  const originalLexicalTarget = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(path.dirname(link), target);
  let lexicalTarget = originalLexicalTarget;
  if (!isStrictlyContained(root, lexicalTarget)) {
    const alias = relocatedRootAliases.find(candidate =>
      isStrictlyContained(candidate, originalLexicalTarget));
    if (alias) {
      lexicalTarget = path.join(root, path.relative(alias, originalLexicalTarget));
    }
  }
  if (!isStrictlyContained(root, lexicalTarget)) {
    throw new WorkspaceMigrationUnsafePathError(`Symlink escapes its managed root: ${link} -> ${target}`);
  }
  let canonicalRoot: string;
  let canonicalTarget: string;
  try {
    [canonicalRoot, canonicalTarget] = await Promise.all([fs.realpath(root), fs.realpath(lexicalTarget)]);
  } catch (error) {
    throw new WorkspaceMigrationUnsafePathError(
      `Broken, cyclic, or unreadable symlink is not allowed in managed data: ${link} -> ${target} ` +
      `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!isStrictlyContained(canonicalRoot, canonicalTarget)) {
    throw new WorkspaceMigrationUnsafePathError(`Symlink resolves outside its managed root: ${link} -> ${target}`);
  }
  // Persist a relocatable target in the manifest. Windows junctions commonly
  // report an absolute target even when both endpoints live in the same tree;
  // carrying that string into the stage would keep the link attached to the
  // legacy root after publish. The target has been proven both lexically and
  // canonically internal, so the equivalent relative spelling is safe.
  const targetStat = await fs.stat(lexicalTarget);
  if (!targetStat.isFile() && !targetStat.isDirectory()) {
    throw new WorkspaceMigrationUnsafePathError(
      `Symlink target is not a regular file or directory: ${link} -> ${target}`,
    );
  }
  const linkRelativePath = path.relative(root, link);
  const canonicalLinkParent = path.join(canonicalRoot, path.dirname(linkRelativePath));
  return {
    // Compare and persist the canonical in-tree relationship, not the raw
    // absolute spelling returned by readlink(). This removes Windows case/long
    // path aliases and makes a source junction and its relocated copy hash to
    // the same logical target.
    linkTarget: path.relative(canonicalLinkParent, canonicalTarget) || '.',
    // Node exposes Windows junctions through isSymbolicLink(), but not their
    // reparse tag. A directory reparse link with an absolute target is the safe
    // junction-compatible case: recreating it as `dir` would unexpectedly
    // require Developer Mode/admin, while relative directory links remain real
    // directory symlinks.
    linkType: targetStat.isDirectory()
      ? process.platform === 'win32' && path.isAbsolute(target) ? 'junction' : 'directory'
      : 'file',
  };
}

function decodeLinuxMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)));
}

function parseLinuxMountPoints(contents: string): Set<string> {
  const mounts = new Set<string>();
  for (const line of contents.split('\n')) {
    if (!line.trim()) continue;
    const separator = line.indexOf(' - ');
    const fields = (separator >= 0 ? line.slice(0, separator) : line).split(' ');
    if (separator < 0 || fields.length < 6 || !fields[4]) {
      throw new WorkspaceMigrationUnsafePathError('Linux mount table is malformed; migration cannot inventory safely.');
    }
    const mountPoint = decodeLinuxMountInfoPath(fields[4]);
    if (!path.isAbsolute(mountPoint)) {
      throw new WorkspaceMigrationUnsafePathError(
        `Linux mount table contains a non-absolute mount point: ${mountPoint}`,
      );
    }
    mounts.add(path.resolve(mountPoint));
  }
  if (mounts.size === 0) {
    throw new WorkspaceMigrationUnsafePathError('Linux mount table is empty; migration cannot inventory safely.');
  }
  return mounts;
}

async function nestedLinuxMountPoints(canonicalRoot: string): Promise<Set<string>> {
  if (process.platform !== 'linux' && mountInfoForTests === undefined) return new Set();
  let contents: string;
  if (mountInfoForTests !== undefined) {
    contents = mountInfoForTests;
  } else {
    try {
      contents = await fs.readFile('/proc/self/mountinfo', 'utf8');
    } catch (error) {
      throw new WorkspaceMigrationUnsafePathError(
        `Cannot read /proc/self/mountinfo; migration cannot exclude nested bind mounts ` +
        `(${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  }
  const mounts = parseLinuxMountPoints(contents);
  return new Set([...mounts].filter(mount => isStrictlyContained(canonicalRoot, mount)));
}

/**
 * A managed tree may itself be a Docker volume/bind-mount root, but recursively
 * walking across another filesystem below that root is unsafe.  The later
 * archive/cleanup steps operate on whole trees; treating a nested mount as an
 * ordinary directory could therefore copy and then delete data owned by a
 * different mount.  `dev` catches normal POSIX volume transitions, while the
 * canonical-path comparison catches directory reparse points that Node reports
 * as directories rather than symbolic links on some Windows filesystems.
 */
async function assertSameManagedFilesystem(
  root: string,
  canonicalRoot: string,
  rootStat: Stats,
  candidate: string,
  relativePath: string,
  stat: Stats,
  nestedMountPoints: Set<string>,
): Promise<void> {
  if (!relativePath || stat.isSymbolicLink()) return;
  if (stat.dev !== rootStat.dev) {
    throw new WorkspaceMigrationUnsafePathError(
      `Managed data crosses a nested filesystem boundary: ${candidate} (root ${root})`,
    );
  }

  const canonicalCandidate = await fs.realpath(candidate);
  const expectedCanonical = nativePath(canonicalRoot, relativePath);
  if (nestedMountPoints.has(path.resolve(canonicalCandidate))) {
    throw new WorkspaceMigrationUnsafePathError(
      `Managed data crosses a nested mount point: ${candidate} (root ${root})`,
    );
  }
  if (!samePath(canonicalCandidate, expectedCanonical)) {
    throw new WorkspaceMigrationUnsafePathError(
      `Managed data crosses a nested reparse boundary: ${candidate} -> ${canonicalCandidate}`,
    );
  }
}

async function buildManifest(
  root: string,
  relocatedRootAliases: string[] = [],
): Promise<PathManifest | undefined> {
  await assertManagedPathAncestors(root);
  const rootStat = await lstatOptional(root);
  if (!rootStat) return undefined;
  if (rootStat.isSymbolicLink()) {
    throw new WorkspaceMigrationUnsafePathError(`Managed root must not be a symlink or junction: ${root}`);
  }
  const canonicalRoot = await fs.realpath(root);
  const nestedMountPoints = await nestedLinuxMountPoints(canonicalRoot);
  const entries: ManifestEntry[] = [];
  const walk = async (candidate: string, relativePath: string): Promise<void> => {
    const stat = await fs.lstat(candidate) as Stats;
    await assertSameManagedFilesystem(
      root,
      canonicalRoot,
      rootStat,
      candidate,
      relativePath,
      stat,
      nestedMountPoints,
    );
    if (stat.isSymbolicLink()) {
      const linkTarget = await fs.readlink(candidate);
      const normalizedLink = await validateSymlink(
        root,
        candidate,
        linkTarget,
        relocatedRootAliases,
      );
      const after = await fs.lstat(candidate) as Stats;
      if (!after.isSymbolicLink() || !sameFileIdentity(stat, after) || await fs.readlink(candidate) !== linkTarget) {
        throw new Error(`Workspace migration symlink changed while it was inventoried: ${candidate}`);
      }
      entries.push({ relativePath, type: 'symlink', ...normalizedLink });
      return;
    }
    if (stat.isFile()) {
      entries.push({ relativePath, type: 'file', ...await hashFile(candidate) });
      return;
    }
    if (!stat.isDirectory()) {
      throw new WorkspaceMigrationUnsafePathError(
        `Managed data contains an unsupported filesystem object: ${candidate}`,
      );
    }
    entries.push({ relativePath, type: 'directory', mode: permissionMode(stat) });
    const before = (await fs.readdir(candidate)).sort((a, b) => a.localeCompare(b));
    for (const name of before) {
      await walk(path.join(candidate, name), relativePath ? `${relativePath}/${name}` : name);
    }
    const after = (await fs.readdir(candidate)).sort((a, b) => a.localeCompare(b));
    if (before.length !== after.length || before.some((name, index) => name !== after[index])) {
      throw new Error(`Workspace migration source changed while it was inventoried: ${candidate}`);
    }
    const afterStat = await fs.lstat(candidate) as Stats;
    if (
      !afterStat.isDirectory()
      || afterStat.isSymbolicLink()
      || !sameFileIdentity(stat, afterStat)
      || permissionMode(afterStat) !== permissionMode(stat)
      || afterStat.mtimeMs !== stat.mtimeMs
      || afterStat.ctimeMs !== stat.ctimeMs
    ) throw new Error(`Workspace migration directory changed while it was inventoried: ${candidate}`);
  };
  await walk(root, '');
  return manifestFromEntries(entries);
}

async function requireDigest(
  candidate: string,
  digest: string,
  label: string,
  relocatedRootAliases: string[] = [],
): Promise<PathManifest> {
  const manifest = await buildManifest(candidate, relocatedRootAliases);
  if (!manifest || manifest.digest !== digest) {
    throw new WorkspaceMigrationConflictError(label, candidate, candidate, 'content changed during migration');
  }
  return manifest;
}

function backupPath(source: string, transactionId: string, destination = false): string {
  return path.join(
    path.dirname(source),
    `.${path.basename(source)}.workspace-v2-${transactionId}${destination ? '.destination' : ''}.bak`,
  );
}

function safeStageName(id: string): string {
  return `${id.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80) || 'entry'}-` +
    createHash('sha256').update(id).digest('hex').slice(0, 12);
}

function applicationSharesDataRoot(): boolean {
  const appRoot = path.resolve(process.env.FLUJO_APP_ROOT?.trim() || getAppDir());
  return samePath(appRoot, getDataDir());
}

function legacyBrowserUserdataRoot(): string {
  return path.join(getDataDir(), 'mcp-servers', 'browser', 'userdata');
}

function baseCandidates(): CandidateEntry[] {
  const dataRoot = getDataDir();
  const workspaceRoot = getWorkspaceDir(DEFAULT_WORKSPACE);
  const entries: CandidateEntry[] = [{
    id: 'db',
    subtree: 'db',
    sources: LEGACY_DB_CANDIDATES.map(parts => path.join(dataRoot, ...parts)),
    destination: path.join(workspaceRoot, 'db'),
    requireDirectory: true,
  }];

  for (const subtree of EXTRA_WORKSPACE_ROOTS) {
    const sources = [path.join(dataRoot, subtree)];
    if (
      applicationSharesDataRoot()
      && ['screenshots', 'recordings', 'browser-profile'].includes(subtree)
    ) {
      // Older shipped browser builds wrote beneath their package cwd. Preserve
      // the package itself but merge its runtime data into the modern roots.
      sources.push(path.join(legacyBrowserUserdataRoot(), subtree));
    }
    entries.push({
      id: subtree,
      subtree,
      sources,
      destination: path.join(workspaceRoot, subtree),
      requireDirectory: true,
    });
  }

  const sourceMcpRoot = path.join(dataRoot, 'mcp-servers');
  const destinationMcpRoot = path.join(workspaceRoot, 'mcp-servers');
  if (!applicationSharesDataRoot()) {
    entries.push({
      id: 'mcp-servers',
      subtree: 'mcp-servers',
      sources: [sourceMcpRoot],
      destination: destinationMcpRoot,
      requireDirectory: true,
    });
  }
  return entries;
}

function candidateForJournalId(id: string): CandidateEntry | undefined {
  const staticEntry = baseCandidates().find(candidate => candidate.id === id);
  if (staticEntry) return staticEntry;
  if (!applicationSharesDataRoot() || !id.startsWith('mcp-servers/')) return undefined;
  const name = id.slice('mcp-servers/'.length);
  if (
    !name
    || name === '.'
    || name === '..'
    || name.includes('\0')
    || path.basename(name) !== name
    || APP_OWNED_MCP_ENTRIES.has(name.toLowerCase())
    || TRANSACTION_BACKUP_NAME.test(name)
  ) return undefined;
  return {
    id,
    subtree: 'mcp-servers',
    sources: [path.join(getDataDir(), 'mcp-servers', name)],
    destination: path.join(getWorkspaceDir(DEFAULT_WORKSPACE), 'mcp-servers', name),
    requireDirectory: false,
  };
}

async function validateLegacyBrowserUserdataRoot(): Promise<void> {
  if (!applicationSharesDataRoot()) return;
  const root = legacyBrowserUserdataRoot();
  const stat = await lstatOptional(root);
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new WorkspaceMigrationUnsafePathError(`Legacy browser userdata root is unsafe: ${root}`);
  }
  const supported = new Set(['screenshots', 'recordings', 'browser-profile']);
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (TRANSACTION_BACKUP_NAME.test(entry.name)) {
      throw new WorkspaceMigrationUnsafePathError(
        `Orphaned workspace migration backup requires recovery before startup: ${path.join(root, entry.name)}`,
      );
    }
    if (!supported.has(entry.name)) {
      throw new WorkspaceMigrationUnsafePathError(
        `Unrecognized legacy browser runtime data cannot be mapped safely: ${path.join(root, entry.name)}`,
      );
    }
  }
}

async function discoverCandidates(): Promise<CandidateEntry[]> {
  const dataRoot = getDataDir();
  const workspaceRoot = getWorkspaceDir(DEFAULT_WORKSPACE);
  const entries = baseCandidates();

  if (applicationSharesDataRoot()) {
    await validateLegacyBrowserUserdataRoot();
    const sourceMcpRoot = path.join(dataRoot, 'mcp-servers');
    const destinationMcpRoot = path.join(workspaceRoot, 'mcp-servers');
    const stat = await lstatOptional(sourceMcpRoot);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new WorkspaceMigrationUnsafePathError(`Application MCP root is unsafe: ${sourceMcpRoot}`);
    }
    if (stat) {
      const dirents = await fs.readdir(sourceMcpRoot, { withFileTypes: true });
      const aliases = new Map<string, string[]>();
      for (const entry of dirents) {
        if (TRANSACTION_BACKUP_NAME.test(entry.name)) {
          throw new WorkspaceMigrationUnsafePathError(
            `Orphaned workspace migration backup requires recovery before startup: ` +
            path.join(sourceMcpRoot, entry.name),
          );
        }
        const folded = entry.name.toLowerCase();
        const group = aliases.get(folded) ?? [];
        group.push(entry.name);
        aliases.set(folded, group);
      }
      const collision = [...aliases.values()].find(group => group.length > 1);
      if (collision) {
        throw new WorkspaceMigrationUnsafePathError(`MCP entries have a case alias: ${collision.join(', ')}`);
      }
      for (const entry of dirents) {
        if (
          APP_OWNED_MCP_ENTRIES.has(entry.name.toLowerCase())
        ) continue;
        entries.push({
          id: `mcp-servers/${entry.name}`,
          subtree: 'mcp-servers',
          sources: [path.join(sourceMcpRoot, entry.name)],
          destination: path.join(destinationMcpRoot, entry.name),
          requireDirectory: false,
        });
      }
    }
  }

  const destinations = new Map<string, string>();
  for (const entry of entries) {
    const key = process.platform === 'win32'
      ? path.resolve(entry.destination).toLowerCase()
      : path.resolve(entry.destination);
    const prior = destinations.get(key);
    if (prior) {
      throw new WorkspaceMigrationUnsafePathError(
        `Migration entries ${prior} and ${entry.id} target the same destination.`,
      );
    }
    destinations.set(key, entry.id);
  }
  return entries;
}

async function preflight(transactionId: string): Promise<MigrationJournal> {
  const candidates = await discoverCandidates();
  const transactionRoot = path.join(transactionsPath(), transactionId);
  const entries: JournalEntry[] = [];

  // Inventory every source and destination before the first user-data rename.
  for (const candidate of candidates) {
    const sourceManifests = await Promise.all(candidate.sources.map(async source => ({
      source,
      manifest: await buildManifest(source),
    })));
    const destinationManifest = await buildManifest(candidate.destination);
    if (candidate.requireDirectory) {
      for (const source of sourceManifests) {
        if (source.manifest && source.manifest.entries[0]?.type !== 'directory') {
          throw new WorkspaceMigrationUnsafePathError(
            `Legacy ${candidate.subtree} root is not a directory: ${source.source}`,
          );
        }
      }
      if (destinationManifest && destinationManifest.entries[0]?.type !== 'directory') {
        throw new WorkspaceMigrationConflictError(
          candidate.subtree,
          candidate.sources.join(', '),
          candidate.destination,
          'workspace destination is not a directory',
        );
      }
    }

    const mergeInputs = sourceManifests
      .filter((item): item is { source: string; manifest: PathManifest } => Boolean(item.manifest))
      .map(item => ({ label: item.source, manifest: item.manifest }));
    if (destinationManifest) {
      mergeInputs.push({ label: candidate.destination, manifest: destinationManifest });
    }
    const merged = mergeManifests(mergeInputs, candidate.subtree, candidate.destination);
    const populatedSources = sourceManifests.filter(item => item.manifest && !item.manifest.emptyDirectory);
    let outcome: SubtreeOutcome;
    if (sourceManifests.every(item => !item.manifest)) {
      outcome = destinationManifest ? 'already-migrated' : 'created';
    } else if (destinationManifest?.digest === merged.digest) {
      outcome = populatedSources.length > 0 ? 'recovered-identical' : 'already-migrated';
    } else if (destinationManifest && !destinationManifest.emptyDirectory) {
      outcome = 'reconciled';
    } else {
      outcome = 'copied';
    }

    entries.push({
      id: candidate.id,
      subtree: candidate.subtree,
      sources: sourceManifests.map(item => ({
        path: item.source,
        backup: backupPath(item.source, transactionId),
        initialDigest: item.manifest?.digest,
      })),
      destination: candidate.destination,
      destinationBackup: backupPath(candidate.destination, transactionId, true),
      initialDestinationDigest: destinationManifest?.digest,
      stage: path.join(transactionRoot, 'stage', safeStageName(candidate.id)),
      expectedDigest: merged.digest,
      expectedEntries: merged.entries,
      state: 'planned',
      outcome,
      requireDirectory: candidate.requireDirectory,
    });
  }

  const journal: MigrationJournal = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    targetVersion: WORKSPACE_LAYOUT_VERSION,
    transactionId,
    createdAt: new Date().toISOString(),
    phase: 'planned',
    entries,
  };
  validateJournalPaths(journal);
  return journal;
}

function nativePath(root: string, relativePath: string): string {
  return relativePath ? path.join(root, ...relativePath.split('/')) : root;
}

async function materializeManifest(
  destination: string,
  merged: PathManifest,
  inputs: Array<{ root: string; manifest: PathManifest }>,
  publishedDestination: string,
): Promise<void> {
  const records = inputs.map(input => ({
    root: input.root,
    entries: new Map(input.manifest.entries.map(entry => [entry.relativePath, entry])),
  }));
  const rootRecord = merged.entries.find(entry => entry.relativePath === '');
  if (!rootRecord) throw new Error('Merged workspace manifest has no root record.');

  const copyRecord = async (entry: ManifestEntry): Promise<void> => {
    const source = records.find(record => record.entries.has(entry.relativePath));
    if (!source) throw new Error(`No migration input supplies ${entry.relativePath || '.'}.`);
    const from = nativePath(source.root, entry.relativePath);
    const to = nativePath(destination, entry.relativePath);
    if (entry.type === 'directory') {
      // Keep transaction-owned directories traversable while descendants are
      // populated. Their original modes are restored bottom-up afterwards.
      await fs.mkdir(to, { recursive: false, mode: 0o700 });
    } else if (entry.type === 'file') {
      await fs.copyFile(from, to, fsConstants.COPYFILE_EXCL);
      await fs.chmod(to, entry.mode!);
    } else {
      if (entry.linkType === 'junction') {
        const stagedTarget = path.resolve(path.dirname(to), entry.linkTarget!);
        if (!isStrictlyContained(destination, stagedTarget)) {
          throw new WorkspaceMigrationUnsafePathError(
            `Staged junction target escapes its managed root: ${to} -> ${entry.linkTarget}`,
          );
        }
        const publishedTarget = path.join(
          publishedDestination,
          path.relative(destination, stagedTarget),
        );
        // Junctions store an absolute target. Point directly at the final
        // workspace location so the subsequent atomic stage rename cannot
        // strand the link on the transient transaction directory.
        await fs.symlink(publishedTarget, to, 'junction');
      } else {
        await fs.symlink(entry.linkTarget!, to, entry.linkType === 'directory' ? 'dir' : 'file');
      }
    }
  };

  await copyRecord(rootRecord);
  const rest = merged.entries
    .filter(entry => entry.relativePath !== '')
    .sort((a, b) => {
      const depth = (value: string) => value.split('/').length;
      return depth(a.relativePath) - depth(b.relativePath)
        || a.relativePath.localeCompare(b.relativePath);
    });
  // Materialize links only after every real directory/file, so their logical
  // in-tree targets exist for semantic validation. We never traverse a link
  // while copying its entry.
  for (const entry of rest.filter(item => item.type !== 'symlink')) await copyRecord(entry);
  for (const entry of rest.filter(item => item.type === 'symlink')) await copyRecord(entry);
  const directories = merged.entries
    .filter(entry => entry.type === 'directory')
    .sort((a, b) => {
      const depth = (value: string) => value ? value.split('/').length : 0;
      return depth(b.relativePath) - depth(a.relativePath)
        || b.relativePath.localeCompare(a.relativePath);
    });
  for (const entry of directories) {
    await fs.chmod(nativePath(destination, entry.relativePath), entry.mode!);
  }
  await applyManifestFileTimes(destination, merged);
}

async function applyManifestFileTimes(root: string, manifest: PathManifest): Promise<void> {
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  for (const entry of manifest.entries) {
    if (entry.type !== 'file') continue;
    if (!Number.isFinite(entry.atimeMs) || !Number.isFinite(entry.mtimeMs)) {
      throw new WorkspaceMigrationMarkerError(
        `Workspace migration manifest is missing file timestamps: ${entry.relativePath}`,
      );
    }
    const file = nativePath(root, entry.relativePath);
    const before = await fs.lstat(file) as Stats;
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new WorkspaceMigrationUnsafePathError(`Expected a regular file while restoring timestamps: ${file}`);
    }
    let originalMode: number | undefined;
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      // Windows rejects futime on a read-only handle even for writable files.
      handle = await fs.open(file, fsConstants.O_RDWR | noFollow);
    } catch (error) {
      if (!['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      originalMode = before.mode;
      await fs.chmod(file, originalMode | 0o200);
      handle = await fs.open(file, fsConstants.O_RDWR | noFollow);
    }
    try {
      const opened = await handle.stat() as Stats;
      if (!opened.isFile() || !sameFileIdentity(before, opened)) {
        throw new WorkspaceMigrationUnsafePathError(`File changed or escaped while restoring timestamps: ${file}`);
      }
      await handle.utimes(entry.atimeMs! / 1_000, entry.mtimeMs! / 1_000);
    } finally {
      await handle.close();
      if (originalMode !== undefined) await fs.chmod(file, originalMode);
    }
  }
}

async function fsyncManifest(root: string, manifest: PathManifest): Promise<void> {
  for (const entry of manifest.entries) {
    if (entry.type !== 'file') continue;
    const file = nativePath(root, entry.relativePath);
    let originalMode: number | undefined;
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      // Windows' FlushFileBuffers rejects a read-only handle with EPERM.
      handle = await fs.open(file, 'r+');
    } catch (error) {
      if (!['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      // copyFile can preserve a read-only mode. Temporarily make only the
      // transaction-owned staged copy writable, fsync it, then restore its mode.
      originalMode = (await fs.lstat(file)).mode;
      await fs.chmod(file, originalMode | 0o200);
      handle = await fs.open(file, 'r+');
    }
    try {
      await handle.sync();
    } finally {
      await handle.close();
      if (originalMode !== undefined) await fs.chmod(file, originalMode);
    }
  }
  // Persist every directory entry bottom-up. Syncing only the stage root does
  // not make a nested file name durable: each containing directory must reach
  // disk before the completion marker can safely be published.
  const directories = manifest.entries
    .filter(entry => entry.type === 'directory')
    .sort((a, b) => {
      const depth = (value: string) => value ? value.split('/').length : 0;
      return depth(b.relativePath) - depth(a.relativePath)
        || b.relativePath.localeCompare(a.relativePath);
    });
  for (const entry of directories) {
    await syncDirectory(nativePath(root, entry.relativePath));
  }
}

async function collectEntryInputs(entry: JournalEntry): Promise<{
  inputs: Array<{ root: string; manifest: PathManifest }>;
  destination?: PathManifest;
  destinationBackup?: PathManifest;
}> {
  const inputs: Array<{ root: string; manifest: PathManifest }> = [];
  for (const source of entry.sources) {
    const [original, backup] = await Promise.all([
      buildManifest(source.path),
      buildManifest(source.backup, [source.path]),
    ]);
    if (original && backup) {
      throw new WorkspaceMigrationConflictError(
        entry.subtree,
        source.path,
        source.backup,
        'both original source and transaction backup exist',
      );
    }
    const available = original ?? backup;
    if (source.initialDigest) {
      if (!available || available.digest !== source.initialDigest) {
        throw new WorkspaceMigrationConflictError(
          entry.subtree,
          source.path,
          entry.destination,
          'source/backup differs from its preflight manifest',
        );
      }
      inputs.push({ root: original ? source.path : source.backup, manifest: available });
    } else if (available) {
      throw new WorkspaceMigrationConflictError(
        entry.subtree,
        source.path,
        entry.destination,
        'a formerly missing source appeared during migration',
      );
    }
  }

  const [destination, destinationBackup] = await Promise.all([
    buildManifest(entry.destination),
    buildManifest(entry.destinationBackup, [entry.destination]),
  ]);
  if (destinationBackup) {
    if (
      !entry.initialDestinationDigest
      || destinationBackup.digest !== entry.initialDestinationDigest
    ) {
      throw new WorkspaceMigrationConflictError(
        entry.subtree,
        entry.destinationBackup,
        entry.destination,
        'destination backup differs from preflight',
      );
    }
    inputs.push({ root: entry.destinationBackup, manifest: destinationBackup });
  } else if (destination && destination.digest !== entry.expectedDigest) {
    if (!entry.initialDestinationDigest || destination.digest !== entry.initialDestinationDigest) {
      throw new WorkspaceMigrationConflictError(
        entry.subtree,
        entry.sources.map(source => source.path).join(', '),
        entry.destination,
        'destination changed after preflight',
      );
    }
    inputs.push({ root: entry.destination, manifest: destination });
  } else if (destination && destination.digest === entry.expectedDigest) {
    inputs.push({ root: entry.destination, manifest: destination });
  } else if (entry.initialDestinationDigest) {
    throw new WorkspaceMigrationConflictError(
      entry.subtree,
      entry.destinationBackup,
      entry.destination,
      'preflight destination disappeared without a transaction backup',
    );
  }
  return { inputs, destination, destinationBackup };
}

async function ensureStage(entry: JournalEntry): Promise<void> {
  let stage = await buildManifest(entry.stage, [entry.destination]);
  if (stage?.digest === entry.expectedDigest) return;
  if (stage) await fs.rm(entry.stage, { recursive: true, force: false });
  const { inputs } = await collectEntryInputs(entry);
  const expected = manifestFromEntries(entry.expectedEntries);
  const merged = mergeManifests(
    inputs.map(input => ({ label: input.root, manifest: input.manifest })),
    entry.subtree,
    entry.destination,
  );
  if (merged.digest !== entry.expectedDigest || expected.digest !== entry.expectedDigest) {
    throw new WorkspaceMigrationConflictError(
      entry.subtree,
      entry.sources.map(source => source.path).join(', '),
      entry.destination,
      'recoverable inputs no longer produce the preflight manifest',
    );
  }
  await fs.mkdir(path.dirname(entry.stage), { recursive: true });
  if (inputs.length === 0 && expected.emptyDirectory) {
    await fs.mkdir(entry.stage);
  } else {
    // Use the durable preflight metadata, not a recovery-time re-inventory:
    // source reads after a crash may have advanced atime.
    await materializeManifest(entry.stage, expected, inputs, entry.destination);
  }
  stage = await requireDigest(entry.stage, entry.expectedDigest, entry.subtree, [entry.destination]);
  await fsyncManifest(entry.stage, stage);
  await syncDirectory(path.dirname(entry.stage));
}

async function archiveSources(entry: JournalEntry): Promise<void> {
  for (const source of entry.sources) {
    const [original, backup] = await Promise.all([
      buildManifest(source.path),
      buildManifest(source.backup, [source.path]),
    ]);
    if (!source.initialDigest) {
      if (original || backup) {
        throw new WorkspaceMigrationConflictError(
          entry.subtree,
          source.path,
          entry.destination,
          'a missing source appeared during commit',
        );
      }
      continue;
    }
    if (original && backup) {
      throw new WorkspaceMigrationConflictError(entry.subtree, source.path, source.backup);
    }
    if (source.retainedMount) {
      if (
        backup
        || !original
        || original.digest !== source.initialDigest
        || !validateRetainedManifest(source.retainedEntries, source.initialDigest)
      ) {
        throw new WorkspaceMigrationConflictError(
          entry.subtree,
          source.path,
          entry.destination,
          'retained mount source differs from its preflight inventory',
        );
      }
      continue;
    }
    if (backup) {
      if (backup.digest !== source.initialDigest) {
        throw new WorkspaceMigrationConflictError(entry.subtree, source.path, source.backup);
      }
      continue;
    }
    if (!original || original.digest !== source.initialDigest) {
      throw new WorkspaceMigrationConflictError(
        entry.subtree,
        source.path,
        entry.destination,
        'source changed before it could be archived',
      );
    }
    try {
      await renameWithRetry(source.path, source.backup);
      await syncDirectory(path.dirname(source.path));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EXDEV', 'EBUSY'].includes(code ?? '') || original.entries[0]?.type !== 'directory') {
        throw error;
      }
      // Docker/bind mount roots cannot be renamed out of their mount point.
      // Keep the verified source untouched through marker commit, then remove
      // only its inventoried children during the resumable cleanup phase.
      source.retainedMount = true;
      source.retainedEntries = original.entries;
      log.warn(`Workspace migration will retain and empty mount root ${source.path}`, { code });
    }
  }
}

async function archiveDestination(entry: JournalEntry): Promise<void> {
  if (!entry.initialDestinationDigest || entry.initialDestinationDigest === entry.expectedDigest) return;
  const [destination, backup] = await Promise.all([
    buildManifest(entry.destination),
    buildManifest(entry.destinationBackup, [entry.destination]),
  ]);
  if (backup) {
    if (backup.digest !== entry.initialDestinationDigest) {
      throw new WorkspaceMigrationConflictError(entry.subtree, entry.destinationBackup, entry.destination);
    }
    if (destination && destination.digest !== entry.expectedDigest) {
      throw new WorkspaceMigrationConflictError(entry.subtree, entry.destinationBackup, entry.destination);
    }
    return;
  }
  if (!destination || destination.digest !== entry.initialDestinationDigest) {
    if (destination?.digest === entry.expectedDigest) return;
    throw new WorkspaceMigrationConflictError(
      entry.subtree,
      entry.destination,
      entry.destination,
      'destination changed before publish',
    );
  }
  await renameWithRetry(entry.destination, entry.destinationBackup);
  await syncDirectory(path.dirname(entry.destination));
}

async function publishEntry(entry: JournalEntry): Promise<void> {
  const destination = await buildManifest(entry.destination);
  if (destination?.digest === entry.expectedDigest) return;
  if (destination) {
    // An empty preflight destination is still archived instead of deleted so
    // every filesystem mutation remains recoverable until marker commit.
    if (entry.initialDestinationDigest !== destination.digest) {
      throw new WorkspaceMigrationConflictError(entry.subtree, entry.destination, entry.destination);
    }
    await archiveDestination(entry);
  }
  await requireDigest(entry.stage, entry.expectedDigest, entry.subtree, [entry.destination]);
  await fs.mkdir(path.dirname(entry.destination), { recursive: true });
  try {
    await renameWithRetry(entry.stage, entry.destination);
  } catch (error) {
    const raced = await buildManifest(entry.destination);
    if (!raced || raced.digest !== entry.expectedDigest) throw error;
  }
  await syncDirectory(path.dirname(entry.destination));
  await requireDigest(entry.destination, entry.expectedDigest, entry.subtree);
}

async function executeEntry(entry: JournalEntry, journal: MigrationJournal): Promise<void> {
  const currentDestination = await buildManifest(entry.destination);
  if (currentDestination?.digest !== entry.expectedDigest) {
    await ensureStage(entry);
    entry.state = 'staged';
    await writeJournal(journal);
    await checkpoint(`after-stage:${entry.id}`);
  }

  await archiveSources(entry);
  entry.state = 'sources-archived';
  await writeJournal(journal);
  await checkpoint(`after-archive:${entry.id}`);

  const afterSources = await buildManifest(entry.destination);
  if (afterSources?.digest !== entry.expectedDigest) {
    await archiveDestination(entry);
    entry.state = 'destination-archived';
    await writeJournal(journal);
    await checkpoint(`after-destination-archive:${entry.id}`);
    await publishEntry(entry);
  }
  entry.state = 'published';
  await writeJournal(journal);
  await checkpoint(`after-publish:${entry.id}`);
}

const OUTCOME_RANK: Record<SubtreeOutcome, number> = {
  skipped: 0,
  'already-migrated': 1,
  created: 2,
  'recovered-identical': 3,
  moved: 4,
  copied: 5,
  reconciled: 6,
};

function aggregateOutcomes(entries: JournalEntry[]): Record<string, SubtreeOutcome> {
  const result: Record<string, SubtreeOutcome> = {};
  for (const subtree of WORKSPACE_SUBTREES) result[subtree] = 'created';
  for (const entry of entries) {
    const prior = result[entry.subtree];
    if (!prior || OUTCOME_RANK[entry.outcome] > OUTCOME_RANK[prior]) result[entry.subtree] = entry.outcome;
  }
  return result;
}

function journalDigest(journal: MigrationJournal): string {
  const dataRoot = getDataDir();
  const workspaceRoot = getWorkspaceDir(DEFAULT_WORKSPACE);
  return createHash('sha256').update(JSON.stringify(journal.entries.map(entry => ({
    id: entry.id,
    subtree: entry.subtree,
    sources: entry.sources.map(source => ({
      path: path.relative(dataRoot, source.path),
      backup: path.relative(dataRoot, source.backup),
      initialDigest: source.initialDigest,
      retainedMount: source.retainedMount,
      retainedEntries: source.retainedEntries,
    })),
    destination: path.relative(workspaceRoot, entry.destination),
    destinationBackup: path.relative(workspaceRoot, entry.destinationBackup),
    initialDestinationDigest: entry.initialDestinationDigest,
    stage: path.relative(transactionsPath(), entry.stage),
    expectedDigest: entry.expectedDigest,
    expectedEntries: entry.expectedEntries,
    outcome: entry.outcome,
    requireDirectory: entry.requireDirectory,
  })))).digest('hex');
}

async function cleanupRetainedMountSource(
  source: JournalSource,
  subtree: string,
  destination: string,
): Promise<void> {
  if (!source.initialDigest || !validateRetainedManifest(source.retainedEntries, source.initialDigest)) {
    throw new WorkspaceMigrationMarkerError(`Retained mount metadata is invalid: ${source.path}`);
  }
  const rootStat = await lstatOptional(source.path);
  if (!rootStat) return;
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new WorkspaceMigrationConflictError(
      subtree,
      source.path,
      destination,
      'retained mount root is no longer a real directory',
    );
  }

  const entries = source.retainedEntries
    .filter(entry => entry.relativePath !== '')
    .sort((a, b) => {
      const depth = (value: string) => value.split('/').length;
      return depth(b.relativePath) - depth(a.relativePath)
        || b.relativePath.localeCompare(a.relativePath);
    });
  for (const expected of entries) {
    const candidate = nativePath(source.path, expected.relativePath);
    const stat = await lstatOptional(candidate);
    if (!stat) continue; // A prior cleanup attempt already removed it.
    if (expected.type === 'file') {
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new WorkspaceMigrationConflictError(subtree, candidate, destination);
      }
      const actual = await hashFile(candidate);
      if (
        actual.mode !== expected.mode
        || actual.size !== expected.size
        || actual.sha256 !== expected.sha256
      ) {
        throw new WorkspaceMigrationConflictError(
          subtree,
          candidate,
          destination,
          'retained source file changed after marker commit',
        );
      }
      await fs.unlink(candidate);
      continue;
    }
    if (expected.type === 'symlink') {
      const actualTarget = stat.isSymbolicLink() ? await fs.readlink(candidate) : undefined;
      const normalizedTarget = actualTarget === undefined
        ? undefined
        : await validateSymlink(source.path, candidate, actualTarget);
      if (
        !stat.isSymbolicLink()
        || normalizedTarget?.linkTarget !== expected.linkTarget
        || normalizedTarget?.linkType !== expected.linkType
      ) {
        throw new WorkspaceMigrationConflictError(subtree, candidate, destination);
      }
      await fs.unlink(candidate);
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new WorkspaceMigrationConflictError(subtree, candidate, destination);
    }
    if (permissionMode(stat) !== expected.mode) {
      throw new WorkspaceMigrationConflictError(
        subtree,
        candidate,
        destination,
        'retained source directory permissions changed after marker commit',
      );
    }
    try {
      await fs.rmdir(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      if (['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw new WorkspaceMigrationConflictError(
          subtree,
          candidate,
          destination,
          'unrecognized data appeared in a retained mount during cleanup',
        );
      }
      throw error;
    }
  }
  const remaining = await fs.readdir(source.path);
  if (remaining.length > 0) {
    throw new WorkspaceMigrationConflictError(
      subtree,
      source.path,
      destination,
      'retained mount contains data that was not present at preflight',
    );
  }
  await syncDirectory(source.path);
}

async function removeTransactionArtifact(
  journal: MigrationJournal,
  candidate: string,
  expectedDigest: string,
  cleanupStarted: boolean | undefined,
  markCleanupStarted: () => void,
  subtree: string,
  destination: string,
  relocatedRootAliases: string[] = [],
): Promise<void> {
  const stat = await lstatOptional(candidate);
  if (!stat) return;
  await assertManagedPathAncestors(candidate);
  if (stat.isSymbolicLink()) {
    throw new WorkspaceMigrationUnsafePathError(
      `Transaction cleanup target became a symlink or junction: ${candidate}`,
    );
  }
  if (!cleanupStarted) {
    const manifest = await buildManifest(candidate, relocatedRootAliases);
    if (!manifest || manifest.digest !== expectedDigest) {
      throw new WorkspaceMigrationConflictError(subtree, candidate, destination);
    }
    // This intent is fsynced before the first recursive unlink. If power is
    // lost halfway through, the exact transaction-derived path can be resumed
    // without demanding the now-partial tree still have its original digest.
    markCleanupStarted();
    await writeJournal(journal);
  }
  await fs.rm(candidate, { recursive: true, force: false });
  await syncDirectory(path.dirname(candidate));
}

async function cleanupTransaction(journal: MigrationJournal): Promise<void> {
  journal.phase = 'cleanup';
  await writeJournal(journal);
  for (const entry of journal.entries) {
    await requireDigest(entry.destination, entry.expectedDigest, entry.subtree);
    const expected = manifestFromEntries(entry.expectedEntries);
    // requireDigest hashes file contents and can advance atime. Reapply both
    // timestamps after that final verification read, then durably flush the
    // metadata before deleting the last recoverable source/backup copy.
    await applyManifestFileTimes(entry.destination, expected);
    await fsyncManifest(entry.destination, expected);
    for (const source of entry.sources) {
      if (source.retainedMount) {
        await cleanupRetainedMountSource(source, entry.subtree, entry.destination);
        await writeJournal(journal);
        continue;
      }
      if (source.initialDigest) {
        await removeTransactionArtifact(
          journal,
          source.backup,
          source.initialDigest,
          source.cleanupStarted,
          () => { source.cleanupStarted = true; },
          entry.subtree,
          entry.destination,
          [source.path],
        );
      } else if (await lstatOptional(source.backup)) {
        throw new WorkspaceMigrationConflictError(entry.subtree, source.backup, entry.destination);
      }
    }
    if (entry.initialDestinationDigest) {
      await removeTransactionArtifact(
        journal,
        entry.destinationBackup,
        entry.initialDestinationDigest,
        entry.destinationBackupCleanupStarted,
        () => { entry.destinationBackupCleanupStarted = true; },
        entry.subtree,
        entry.destination,
        [entry.destination],
      );
    } else if (await lstatOptional(entry.destinationBackup)) {
      throw new WorkspaceMigrationConflictError(
        entry.subtree,
        entry.destinationBackup,
        entry.destination,
      );
    }
    await removeTransactionArtifact(
      journal,
      entry.stage,
      entry.expectedDigest,
      entry.stageCleanupStarted,
      () => { entry.stageCleanupStarted = true; },
      entry.subtree,
      entry.destination,
      [entry.destination],
    );
    await writeJournal(journal);
    await checkpoint(`after-cleanup:${entry.id}`);
  }
  if (applicationSharesDataRoot()) {
    try {
      // Known children were archived above. Remove only the now-empty legacy
      // runtime container; never recurse into the shipped browser package.
      await fs.rmdir(legacyBrowserUserdataRoot());
      await syncDirectory(path.dirname(legacyBrowserUserdataRoot()));
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )) throw error;
    }
  }
  journal.phase = 'committed';
  await writeJournal(journal);
  const transactionRoot = path.join(transactionsPath(), journal.transactionId);
  if (isStrictlyContained(transactionsPath(), transactionRoot)) {
    await fs.rm(transactionRoot, { recursive: true, force: true });
  }
  await fs.unlink(journalPath());
  await syncDirectory(getWorkspacesDir());
}

async function finishTransaction(journal: MigrationJournal): Promise<WorkspaceLayoutMarker> {
  const existingMarker = await readMarker();
  if (
    existingMarker?.version === WORKSPACE_LAYOUT_VERSION
    && existingMarker.transactionId === journal.transactionId
  ) {
    if (existingMarker.manifestDigest !== journalDigest(journal)) {
      throw new WorkspaceMigrationMarkerError(
        'Workspace migration journal no longer matches its durable completion marker.',
      );
    }
    await cleanupTransaction(journal);
    return existingMarker;
  }

  journal.phase = 'committing';
  await writeJournal(journal);
  for (const entry of journal.entries) await executeEntry(entry, journal);
  await ensureWorkspaceDirs(DEFAULT_WORKSPACE);
  await checkpoint('before-marker');
  journal.phase = 'marker';
  await writeJournal(journal);
  const marker: WorkspaceLayoutMarker = {
    version: WORKSPACE_LAYOUT_VERSION,
    completedAt: new Date().toISOString(),
    defaultWorkspace: DEFAULT_WORKSPACE,
    subtrees: aggregateOutcomes(journal.entries),
    transactionId: journal.transactionId,
    manifestDigest: journalDigest(journal),
  };
  await writeJsonAtomic(markerPath(), marker);
  await checkpoint('after-marker');
  await cleanupTransaction(journal);
  log.info('Workspace layout v2 ready', {
    workspaceRoot: getWorkspaceDir(DEFAULT_WORKSPACE),
    transactionId: journal.transactionId,
    subtrees: marker.subtrees,
  });
  return marker;
}

async function hasLegacyRoots(): Promise<boolean> {
  const candidates = await discoverCandidates();
  for (const candidate of candidates) {
    for (const source of candidate.sources) {
      const manifest = await buildManifest(source);
      if (manifest && !manifest.emptyDirectory) return true;
    }
  }
  return false;
}

async function validateCompletedLayout(): Promise<void> {
  await assertRealDirectory(getWorkspaceDir(DEFAULT_WORKSPACE), 'Default workspace root');
  for (const subtree of WORKSPACE_SUBTREES) {
    await assertRealDirectory(
      path.join(getWorkspaceDir(DEFAULT_WORKSPACE), subtree),
      `Default workspace ${subtree} subtree`,
    );
  }
}

async function runMigration(): Promise<WorkspaceLayoutMarker> {
  await prepareRoots();
  const lock = await acquireMigrationLock();
  try {
    await prepareRoots();
    let [existing, durableJournal] = await Promise.all([readMarker(), readJournal()]);
    for (let pass = 1; pass <= MAX_RECONCILIATION_PASSES; pass++) {
      if (durableJournal) {
        existing = await finishTransaction(durableJournal);
        durableJournal = undefined;
      } else if (existing?.version === WORKSPACE_LAYOUT_VERSION && !(await hasLegacyRoots())) {
        await validateCompletedLayout();
        return existing;
      } else {
        const journal = await preflight(randomUUID());
        await fs.mkdir(path.join(transactionsPath(), journal.transactionId, 'stage'), { recursive: true });
        await writeJournal(journal);
        await checkpoint('after-preflight');
        existing = await finishTransaction(journal);
      }

      // A pre-workspace process can recreate a legacy root after we atomically
      // archived it. Do not memoize readiness with that late data invisible:
      // reconcile it in a fresh transaction while this process still owns the
      // installation lock.
      if (!(await hasLegacyRoots())) {
        await validateCompletedLayout();
        return existing;
      }
      log.warn('Legacy workspace data reappeared during migration; reconciling another pass', { pass });
    }
    throw new WorkspaceMigrationConflictError(
      'workspace layout',
      getDataDir(),
      getWorkspaceDir(DEFAULT_WORKSPACE),
      `legacy data kept reappearing across ${MAX_RECONCILIATION_PASSES} reconciliation passes`,
    );
  } finally {
    await lock.release().catch(error => log.error('Failed to release workspace migration lock', error));
  }
}
