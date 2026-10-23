import fs from 'node:fs/promises';
import path from 'node:path';
import { getAppDir, getDataDir } from '@/utils/paths';
import {
  DEFAULT_WORKSPACE,
  WORKSPACE_SUBTREES,
  ensureWorkspaceDirs,
  getWorkspaceDir,
  getWorkspacesDir,
  remapLegacyDefaultWorkspaceReference,
  runWithWorkspace,
} from '@/utils/workspace';
import { createLogger } from '@/utils/logger';
import { writeFileAtomic } from '@/utils/storage/backend';
import { readPlainFile } from '@/utils/readPlainFile';
import { atomicWriteWithoutLinks, assertLinkFreeFileParent } from './backupRestoreFs';
import { snapshotStore } from '@/backend/services/snapshot/SnapshotStore';
import {
  failWorkspaceLayoutPreparation,
  getWorkspaceLayoutPreparation,
  setWorkspaceLayoutPreparation,
} from './layoutReadiness';
import { WORKSPACE_LAYOUT_VERSION } from './layoutVersion';
import { isWorkerMode } from './workerMode';
import {
  reportWorkspaceMigration as migrationConsole,
  resetWorkspaceMigrationProgress,
} from './migrationProgress';

export { WORKSPACE_LAYOUT_VERSION } from './layoutVersion';

const log = createLogger('backend/services/workspace/migration');
const MARKER_FILE = '.workspace-layout.json';
const LOCK_DIR = '.workspace-layout.lock';
const JOURNAL_FILE = '.workspace-layout.transaction.json';
const FAST_JOURNAL_FILE = '.workspace-layout.fast-transaction.json';
const TRANSACTIONS_DIR = '.workspace-migrations';
const LINK_RECOVERY_FILE = '.workspace-layout.links.json';
const LINK_RECOVERY_MAX_BYTES = 8 * 1024 * 1024;
const APP_OWNED_MCP_ENTRIES = new Set([
  'readme.md',
  'embed-shared.mjs',
  'embed-runtime.mjs',
  'bash',
  'browser',
  'filesystem',
  'flujo',
  'shared',
]);

const LEGACY_DB_ROOTS = ['db', path.join('.next', 'storage'), 'storage'];
const DIRECT_ROOTS = [
  'userdata',
  // Keep the legacy snapshot store intact as one top-level migration candidate.
  // The direct mover prefers an atomic directory rename, preserving metadata
  // without adding individual Git objects to a migration journal.
  'snapshots',
  'screenshots',
  'recordings',
  'browser-profile',
  'bash-utils',
  'artifacts',
] as const;

export type SubtreeOutcome =
  | 'created'
  | 'moved'
  | 'copied'
  | 'already-migrated'
  | 'reconciled'
  | 'skipped';

export interface WorkspaceLayoutMarker {
  version: number;
  completedAt: string;
  defaultWorkspace: string;
  subtrees: Record<string, SubtreeOutcome>;
  errors?: string[];
}

type MoveCandidate = {
  subtree: string;
  source: string;
  destination: string;
  requireDirectory?: boolean;
};

type PathMapping = {
  source: string;
  destination: string;
  excludeAppOwned?: boolean;
};

type SavedLink = {
  source: string;
  destination: string;
  originalTarget: string;
  target: string;
  directory: boolean;
  dev: string;
  ino: string;
};

type MigrationNarration = {
  status: 'MOVED' | 'MERGED' | 'UPDATED' | 'SKIPPED' | 'CLEANED';
  subject: string;
  source?: string;
  destination?: string;
  reason: string;
};

let lastNarration: MigrationNarration[] = [];

type FaultHook = (checkpoint: string) => void | Promise<void>;
type MoveFaultHook = (checkpoint: string, source: string, destination: string) => void | Promise<void>;

// Kept as compatibility exports for downstream tests/extensions. The direct
// mover deliberately has no transactional checkpoints to inject faults into.
export function _setWorkspaceMigrationFaultForTests(_hook?: FaultHook): void {}
export function _setWorkspaceMigrationFastFaultForTests(_hook?: FaultHook): void {}
export function _setWorkspaceMigrationMoveFaultForTests(_hook?: MoveFaultHook): void {}
export function _setWorkspaceMigrationHeartbeatMsForTests(_value?: number): void {}
export function _setWorkspaceMigrationMountInfoForTests(_value?: string): void {}

export class WorkspaceMigrationConflictError extends Error {
  readonly code = 'WORKSPACE_MIGRATION_CONFLICT';
}

export class WorkspaceMigrationMarkerError extends Error {
  readonly code = 'WORKSPACE_MIGRATION_MARKER';
}

export class WorkspaceMigrationLockedError extends Error {
  readonly code = 'WORKSPACE_MIGRATION_LOCKED';
}

export class WorkspaceMigrationUnsafePathError extends Error {
  readonly code = 'WORKSPACE_MIGRATION_UNSAFE_PATH';
}

export class WorkspaceMigrationIncompleteError extends Error {
  readonly code = 'WORKSPACE_MIGRATION_INCOMPLETE';

  constructor() {
    super('Workspace migration is incomplete. Free disk space or fix storage access, then restart FLUJO. Existing files and recovery records were kept.');
  }
}

function markerPath(): string {
  return path.join(getWorkspacesDir(), MARKER_FILE);
}

function lockPath(): string {
  return path.join(getWorkspacesDir(), LOCK_DIR);
}

function journalPath(): string {
  return path.join(getWorkspacesDir(), JOURNAL_FILE);
}

function fastJournalPath(): string {
  return path.join(getWorkspacesDir(), FAST_JOURNAL_FILE);
}

function transactionsPath(): string {
  return path.join(getWorkspacesDir(), TRANSACTIONS_DIR);
}

function linkRecoveryPath(): string {
  return path.join(getWorkspacesDir(), LINK_RECOVERY_FILE);
}

export function _workspaceMigrationPathsForTests(): {
  marker: string;
  journal: string;
  fastJournal: string;
  lock: string;
  transactions: string;
  links: string;
} {
  return {
    marker: markerPath(),
    journal: journalPath(),
    fastJournal: fastJournalPath(),
    lock: lockPath(),
    transactions: transactionsPath(),
    links: linkRecoveryPath(),
  };
}

export function _resetWorkspaceMigrationState(): void {
  setWorkspaceLayoutPreparation(undefined);
  resetWorkspaceMigrationProgress();
  lastNarration = [];
}

async function lstatOptional(candidate: string) {
  try {
    return await fs.lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function mappingContains(mapping: PathMapping, candidate: string): boolean {
  const relative = path.relative(mapping.source, candidate);
  return contained(mapping.source, candidate)
    && !(mapping.excludeAppOwned && (!relative
      || APP_OWNED_MCP_ENTRIES.has(relative.split(path.sep)[0].toLowerCase())));
}

function mapPath(candidate: string, mappings: PathMapping[]): string {
  const mapping = mappings
    .filter(item => mappingContains(item, candidate))
    .sort((left, right) => right.source.length - left.source.length)[0];
  if (!mapping) return candidate;
  return path.join(mapping.destination, path.relative(mapping.source, candidate));
}

async function readMarker(): Promise<WorkspaceLayoutMarker | undefined> {
  try {
    const marker = JSON.parse(await fs.readFile(markerPath(), 'utf8')) as WorkspaceLayoutMarker;
    if (
      marker?.version === WORKSPACE_LAYOUT_VERSION
      && marker.defaultWorkspace === DEFAULT_WORKSPACE
      && typeof marker.completedAt === 'string'
      && marker.subtrees
    ) return marker;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('Ignoring an unreadable workspace marker and running the direct mover', error);
    }
  }
  return undefined;
}

async function writeMarker(marker: WorkspaceLayoutMarker): Promise<void> {
  await atomicWriteWithoutLinks(getWorkspacesDir(), markerPath(), Buffer.from(JSON.stringify(marker, null, 2)));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(): Promise<() => Promise<void>> {
  await fs.mkdir(getWorkspacesDir(), { recursive: true });
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await fs.mkdir(lockPath());
      await fs.writeFile(path.join(lockPath(), 'pid'), String(process.pid), 'utf8');
      return async () => {
        const owner = Number.parseInt(
          await fs.readFile(path.join(lockPath(), 'pid'), 'utf8').catch(() => ''),
          10,
        );
        if (owner === process.pid) await fs.rm(lockPath(), { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = Number.parseInt(
        await fs.readFile(path.join(lockPath(), 'pid'), 'utf8').catch(() => ''),
        10,
      );
      if (!Number.isInteger(owner) || !processAlive(owner)) {
        await fs.rm(lockPath(), { recursive: true, force: true });
        continue;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new WorkspaceMigrationLockedError('Another FLUJO process is moving the workspace folders.');
}

async function clearOldTransactionArtifacts(
  errors: string[],
  narration: MigrationNarration[],
): Promise<void> {
  // Retired journals can still accompany the only remaining copy of a payload.
  // Only empty staging directories are obsolete; recovery belongs to the old
  // artifact/instructions when bytes remain, rather than deleting their record.
  const containsPayload = async (directory: string): Promise<boolean> => {
    const stat = await lstatOptional(directory);
    if (!stat) return false;
    if (!stat.isDirectory() || stat.isSymbolicLink()) return true;
    for (const entry of await fs.readdir(directory)) {
      if (await containsPayload(path.join(directory, entry))) return true;
    }
    return false;
  };
  if (await containsPayload(transactionsPath())) {
    throw new Error('Previous workspace migration staging contains data. Keep it and its journals, and recover with the previous application before upgrading.');
  }
  for (const artifact of [journalPath(), fastJournalPath(), transactionsPath()]) {
    try {
      const existed = Boolean(await lstatOptional(artifact));
      await fs.rm(artifact, { recursive: true, force: true });
      if (existed) narration.push({
        status: 'CLEANED',
        subject: path.basename(artifact),
        source: artifact,
        reason: 'removed obsolete state from the retired transactional migration engine',
      });
    } catch (error) {
      errors.push(`Could not remove obsolete migration artifact ${artifact}: ${String(error)}`);
    }
  }
}

async function collectLinks(
  root: string,
  destinationRoot: string,
  mappings: PathMapping[],
  saved: SavedLink[],
  errors: string[],
  pending: ReadonlyArray<SavedLink> = [],
): Promise<void> {
  let entries: Array<{
    name: string;
    isSymbolicLink(): boolean;
    isDirectory(): boolean;
  }>;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    errors.push(`Could not scan ${root} for links: ${String(error)}`);
    return;
  }

  for (const entry of entries) {
    const source = path.join(root, entry.name);
    const relative = path.relative(root, source);
    const destination = path.join(destinationRoot, relative);
    if (entry.isSymbolicLink()) {
      try {
        const rawTarget = await fs.readlink(source);
        const absoluteTarget = path.isAbsolute(rawTarget)
          ? path.resolve(rawTarget)
          : path.resolve(path.dirname(source), rawTarget);
        const mappedTarget = mapPath(absoluteTarget, mappings);
        const target = path.isAbsolute(rawTarget)
          ? mappedTarget : path.relative(path.dirname(destination), mappedTarget) || '.';
        // Relative links entirely within one moved tree remain valid without
        // replacing them. Only changed link text needs a durable remap record.
        if (rawTarget === target) continue;
        const identity = await fs.lstat(source, { bigint: true });
        const recorded = pending.find(link => link.source === source && link.destination === destination
          && link.originalTarget === rawTarget && link.dev === String(identity.dev) && link.ino === String(identity.ino));
        // Another subtree may already have moved, making the original junction
        // temporarily dangling. A matching durable witness retains its known
        // kind; a fresh or changed junction still needs target inspection.
        const targetStat = recorded ? undefined : await fs.stat(source).catch(error => {
          // POSIX recreates a dangling link without needing its target kind.
          // Windows needs the junction/directory kind before replacing it;
          // retain an unknown reparse point and require target recovery first.
          if ((error as NodeJS.ErrnoException).code === 'ENOENT' && process.platform !== 'win32') return undefined;
          throw error;
        });
        saved.push({
          source,
          destination,
          originalTarget: rawTarget,
          target,
          directory: recorded ? recorded.directory : Boolean(targetStat?.isDirectory()),
          dev: String(identity.dev),
          ino: String(identity.ino),
        });
      } catch (error) {
        errors.push(`Could not relocate link ${source}: ${String(error)}`);
      }
    } else if (entry.isDirectory()) {
      await collectLinks(source, destination, mappings, saved, errors, pending);
    }
  }
}

async function moveMerge(
  source: string,
  destination: string,
  errors: string[],
  replaceEmptyDestination = true,
): Promise<'moved' | 'merged' | undefined> {
  const sourceStat = await lstatOptional(source);
  if (!sourceStat) return undefined;
  const destinationStat = await lstatOptional(destination);

  try {
    if (!destinationStat) {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.rename(source, destination);
      return 'moved';
    }

    if (
      sourceStat.isDirectory()
      && !sourceStat.isSymbolicLink()
      && destinationStat.isDirectory()
      && !destinationStat.isSymbolicLink()
    ) {
      // Workspace setup (and Docker volume mounts in particular) can leave an
      // empty directory with the same name as a legacy tree. Prefer replacing
      // that empty shell and renaming the source directory as one unit. Besides
      // being substantially cheaper for MCP repositories, this preserves the
      // directory identity and avoids one rename per payload entry.
      if (replaceEmptyDestination && (await fs.readdir(destination)).length === 0) {
        await fs.rmdir(destination);
        try {
          await fs.rename(source, destination);
          return 'moved';
        } catch (error) {
          // Restore the empty destination before falling back to the recursive
          // merge. A failed optimization must not change merge semantics.
          await fs.mkdir(destination, { recursive: true });
          log.debug('Could not replace an empty migration target directly; merging instead', {
            source,
            destination,
            error,
          });
        }
      }
      for (const entry of await fs.readdir(source)) {
        await moveMerge(path.join(source, entry), path.join(destination, entry), errors);
      }
      await fs.rmdir(source).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error;
      });
      return 'merged';
    }

    // rename atomically replaces an ordinary file on supported hosts. Never
    // erase the target first: ENOSPC, EXDEV or a crash must retain both copies.
    // Incompatible kinds require an operator decision, rather than recursive
    // deletion of an existing destination tree or following a link collision.
    if (!sourceStat.isFile() || !destinationStat.isFile()
        || sourceStat.isSymbolicLink() || destinationStat.isSymbolicLink()) {
      throw new WorkspaceMigrationConflictError('Migration destination has an incompatible entry type. Keep both entries and resolve the collision before restarting.');
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(source, destination);
    return 'moved';
  } catch (error) {
    errors.push(`Could not move ${source} to ${destination}: ${String(error)}`);
    return undefined;
  }
}

async function readLinkRecovery(mappings: PathMapping[]): Promise<SavedLink[]> {
  const file = linkRecoveryPath();
  const stat = await fs.lstat(file, { bigint: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!stat) return [];
  const value: unknown = JSON.parse((await readPlainFile(file, {
    expected: stat, maxBytes: LINK_RECOVERY_MAX_BYTES,
    verifyPath: () => assertLinkFreeFileParent(getWorkspacesDir(), file),
  })).toString('utf8'));
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.links)) {
    throw new Error('Workspace link recovery record is invalid. Keep it for recovery.');
  }
  const destinations = new Set<string>();
  for (const link of value.links) {
    if (!isRecord(link) || typeof link.source !== 'string' || typeof link.destination !== 'string'
        || typeof link.originalTarget !== 'string' || typeof link.target !== 'string'
        || typeof link.directory !== 'boolean' || typeof link.dev !== 'string' || typeof link.ino !== 'string'
        || !/^\d+$/.test(link.dev) || !/^\d+$/.test(link.ino)
        || !path.isAbsolute(link.source) || !path.isAbsolute(link.destination)
        || !mappings.some(mapping => mappingContains(mapping, link.source as string)
          && link.destination === path.join(mapping.destination, path.relative(mapping.source, link.source as string)))
        || destinations.has(link.destination) || link.originalTarget.includes('\0') || link.target.includes('\0')) {
      throw new Error('Workspace link recovery record has an unsafe entry. Keep it for recovery.');
    }
    // Derive the intended target from the recorded raw link, never trust an
    // arbitrary replacement target supplied in the journal.
    const absolute = path.resolve(path.dirname(link.source), link.originalTarget);
    const mapped = mapPath(absolute, mappings);
    const expected = path.isAbsolute(link.originalTarget) ? mapped : path.relative(path.dirname(link.destination), mapped) || '.';
    if (link.target !== expected) throw new Error('Workspace link recovery target does not match its mapping.');
    destinations.add(link.destination);
  }
  return value.links as SavedLink[];
}

async function writeLinkRecovery(links: SavedLink[]): Promise<void> {
  if (!links.length) return;
  const bytes = Buffer.from(JSON.stringify({ version: 1, links }));
  if (bytes.length > LINK_RECOVERY_MAX_BYTES) throw new Error('Workspace link recovery record exceeds its size limit.');
  await atomicWriteWithoutLinks(getWorkspacesDir(), linkRecoveryPath(), bytes);
}

async function restoreLinks(saved: SavedLink[], errors: string[]): Promise<number> {
  let restored = 0;
  for (const link of saved) {
    try {
      // A failed move leaves the original link in place. Do not duplicate it at
      // a destination that has not been published yet.
      if (await lstatOptional(link.source)) throw new Error('Original migration link has not moved.');
      await assertLinkFreeFileParent(getWorkspaceDir(DEFAULT_WORKSPACE), link.destination);
      const current = await fs.lstat(link.destination, { bigint: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      const expected = process.platform === 'win32' && link.directory
        ? path.resolve(path.dirname(link.destination), link.target) : link.target;
      if (current) {
        if (!current.isSymbolicLink()) throw new Error('Migration link was replaced by a different entry.');
        const raw = await fs.readlink(link.destination);
        if (raw === link.target || raw === expected) { restored++; continue; }
        if (raw !== link.originalTarget || String(current.dev) !== link.dev || String(current.ino) !== link.ino) {
          throw new Error('Migration link identity changed. Keep the recovery record.');
        }
        // The synced journal survives the unlink/recreate window, including a
        // SIGKILL here. Restart can recreate an absent link without rescanning
        // moved payload trees, and never removes an unrelated replacement.
        await fs.unlink(link.destination);
      }
      await fs.symlink(
        link.target,
        link.destination,
        process.platform === 'win32' ? (link.directory ? 'junction' : 'file') : undefined,
      );
      const created = await fs.readlink(link.destination);
      if (created !== expected && created !== link.target) throw new Error('Recreated migration link target differs.');
      restored++;
    } catch (error) {
      errors.push(`Could not recreate link ${link.destination}: ${String(error)}`);
    }
  }
  return restored;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rewriteConfigReference(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'string') return 0;
  const remapped = remapLegacyDefaultWorkspaceReference(value, 'mcp-servers');
  if (remapped === value) return 0;
  record[key] = remapped;
  return 1;
}

function rewriteConfigReferenceArray(record: Record<string, unknown>, key: string): number {
  const values = record[key];
  if (!Array.isArray(values)) return 0;
  let changed = 0;
  record[key] = values.map(value => {
    if (typeof value !== 'string') return value;
    const remapped = remapLegacyDefaultWorkspaceReference(value, 'mcp-servers');
    if (remapped !== value) changed++;
    return remapped;
  });
  return changed;
}

function rewriteConfigEnvironment(record: Record<string, unknown>, key: string): number {
  const environment = record[key];
  if (!isRecord(environment)) return 0;
  let changed = 0;
  for (const [name, entry] of Object.entries(environment)) {
    if (typeof entry === 'string') {
      const remapped = remapLegacyDefaultWorkspaceReference(entry, 'mcp-servers');
      if (remapped !== entry) {
        environment[name] = remapped;
        changed++;
      }
    } else if (isRecord(entry) && typeof entry.value === 'string') {
      const remapped = remapLegacyDefaultWorkspaceReference(entry.value, 'mcp-servers');
      if (remapped !== entry.value) {
        entry.value = remapped;
        changed++;
      }
    }
  }
  return changed;
}

function rewriteStoredMcpServer(server: Record<string, unknown>): number {
  let changed = 0;
  for (const key of ['rootPath', 'cwd', 'command']) {
    changed += rewriteConfigReference(server, key);
  }
  for (const key of ['args', 'roots']) {
    changed += rewriteConfigReferenceArray(server, key);
  }
  changed += rewriteConfigEnvironment(server, 'env');

  if (isRecord(server.launch)) {
    for (const key of ['command', 'cwd']) {
      changed += rewriteConfigReference(server.launch, key);
    }
    changed += rewriteConfigReferenceArray(server.launch, 'args');
    changed += rewriteConfigEnvironment(server.launch, 'env');
  }
  return changed;
}

async function rewritePersistedMcpServerPaths(
  errors: string[],
  narration: MigrationNarration[],
): Promise<number> {
  return runWithWorkspace(DEFAULT_WORKSPACE, async () => {
    const configPath = path.join(getWorkspaceDir(DEFAULT_WORKSPACE), 'db', 'mcp_servers.json');
    let raw: string;
    try {
      raw = await fs.readFile(configPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      errors.push(`Could not read MCP server configuration ${configPath}: ${String(error)}`);
      return 0;
    }

    try {
      const stored = JSON.parse(raw) as unknown;
      if (!isRecord(stored)) {
        errors.push(`Could not rewrite MCP server paths in ${configPath}: configuration root is not an object`);
        return 0;
      }

      let changed = 0;
      for (const server of Object.values(stored)) {
        if (isRecord(server)) changed += rewriteStoredMcpServer(server);
      }
      if (changed === 0) return 0;

      await writeFileAtomic(configPath, JSON.stringify(stored, null, 2));
      narration.push({
        status: 'UPDATED',
        subject: 'MCP server configuration',
        destination: configPath,
        reason: `rewrote ${changed} legacy path reference${changed === 1 ? '' : 's'} to the default workspace`,
      });
      return changed;
    } catch (error) {
      errors.push(`Could not rewrite MCP server paths in ${configPath}: ${String(error)}`);
      return 0;
    }
  });
}

async function applicationSharesDataRoot(): Promise<boolean> {
  const appRoot = path.resolve(process.env.FLUJO_APP_ROOT?.trim() || getAppDir());
  const dataRoot = path.resolve(getDataDir());
  const canonicalRoot = async (root: string): Promise<string> => {
    try {
      return await fs.realpath(root);
    } catch (error) {
      // Fresh installations can name a root that does not exist yet. Other
      // failures must stop discovery rather than permit moving app sources.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return root;
      throw error;
    }
  };
  // Junctions/symlinks can give one installation two different path spellings.
  // Compare filesystem-resolved paths, retaining case on case-sensitive hosts.
  const [canonicalApp, canonicalData] = await Promise.all([
    canonicalRoot(appRoot), canonicalRoot(dataRoot),
  ]);
  if (canonicalApp === canonicalData) return true;
  // A new installation/worktree may deliberately reuse an older checkout's
  // data directory. Its bundled packages are still application source, even
  // though they do not belong to the process currently performing migration.
  try {
    const manifestPath = path.join(canonicalData, 'package.json');
    const stat = await fs.stat(manifestPath);
    if (!stat.isFile() || stat.size > 1024 * 1024) return false;
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    return manifest.name === 'flujo-ai' && Array.isArray(manifest.workspaces)
      && manifest.workspaces.some((workspace: unknown) => typeof workspace === 'string' && workspace.startsWith('mcp-servers/'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return false;
    throw error;
  }
}

async function candidates(
  errors: string[],
  narration: MigrationNarration[],
): Promise<MoveCandidate[]> {
  const dataRoot = getDataDir();
  const workspaceRoot = getWorkspaceDir(DEFAULT_WORKSPACE);
  const result: MoveCandidate[] = [];

  for (const source of LEGACY_DB_ROOTS) {
    result.push({
      subtree: 'db',
      source: path.join(dataRoot, source),
      destination: path.join(workspaceRoot, 'db'),
    });
  }
  for (const subtree of DIRECT_ROOTS) {
    result.push({
      subtree,
      source: path.join(dataRoot, subtree),
      destination: path.join(workspaceRoot, subtree),
    });
  }

  const legacyMcp = path.join(dataRoot, 'mcp-servers');
  const workspaceMcp = path.join(workspaceRoot, 'mcp-servers');
  if (!await applicationSharesDataRoot()) {
    result.push({ subtree: 'mcp-servers', source: legacyMcp, destination: workspaceMcp });
  } else {
    try {
      for (const entry of await fs.readdir(legacyMcp)) {
        if (APP_OWNED_MCP_ENTRIES.has(entry.toLowerCase())) {
          narration.push({
            status: 'SKIPPED',
            subject: `mcp-servers/${entry}`,
            source: path.join(legacyMcp, entry),
            reason: 'bundled application MCP package; it belongs in the application root',
          });
          continue;
        }
        result.push({
          subtree: 'mcp-servers',
          source: path.join(legacyMcp, entry),
          destination: path.join(workspaceMcp, entry),
          // Runtime MCP roots normally contain repositories, but installers
          // may also leave useful top-level metadata/config files. Those files
          // are migration entries, not unsafe workspace roots.
          requireDirectory: false,
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        errors.push(`Could not list legacy MCP servers: ${String(error)}`);
      }
    }
  }
  return result;
}

async function runDirectMigration(): Promise<WorkspaceLayoutMarker> {
  await fs.mkdir(getDataDir(), { recursive: true });
  await fs.mkdir(getWorkspacesDir(), { recursive: true });
  const release = await acquireLock();
  migrationConsole('exclusive lock acquired', { pid: process.pid, lock: lockPath() });
  try {
  // Mutation admission prepares workspace directories for its process locks.
  // Observe the starting layout before admission so those internal creations
  // cannot label a fresh or skipped subtree as previously migrated.
  const targetExisting = new Set<string>();
  for (const subtree of WORKSPACE_SUBTREES) {
    if (await lstatOptional(path.join(getWorkspaceDir(DEFAULT_WORKSPACE), subtree))) {
      targetExisting.add(subtree);
    }
  }
  // Acquire snapshot store lease to coordinate with capture/cleanup operations
  // that may be in progress. This prevents concurrent mutations of the snapshot
  // store during migration (issue #414).
  const snapshotRoots = [snapshotStore.rootPath()];
  return await snapshotStore.withMigrationAccess(snapshotRoots, async () => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const narration: MigrationNarration[] = [];
    lastNarration = narration;
    const planned = await candidates(errors, narration);
    const mappings: PathMapping[] = planned.map(({ source, destination }) => ({ source, destination }));
    // A per-server legacy entry may already have moved before an interruption.
    // Keep its root mapping available without scanning moved payload trees.
    mappings.push({ source: path.join(getDataDir(), 'mcp-servers'),
      destination: path.join(getWorkspaceDir(DEFAULT_WORKSPACE), 'mcp-servers'),
      excludeAppOwned: await applicationSharesDataRoot() });
    const pendingLinks = await readLinkRecovery(mappings);
    await clearOldTransactionArtifacts(errors, narration);
    const requireComplete = () => {
      if (errors.length) {
        log.error('Workspace migration requires recovery', errors);
        throw new WorkspaceMigrationIncompleteError();
      }
    };
    const current = await readMarker();
    const legacySourcesPresent = (await Promise.all(planned.map(async candidate => ({
      candidate,
      present: Boolean(await lstatOptional(candidate.source).catch(error => {
        errors.push(`Could not inspect ${candidate.source}: ${String(error)}`);
        return undefined;
      })),
    })))).filter(item => item.present);
    requireComplete();
    if (current && legacySourcesPresent.length === 0 && pendingLinks.length === 0) {
      await rewritePersistedMcpServerPaths(errors, narration);
      requireComplete();
      narration.push({
        status: 'SKIPPED',
        subject: 'workspace layout',
        destination: getWorkspaceDir(DEFAULT_WORKSPACE),
        reason: 'completion marker already exists; no folders needed to move',
      });
      migrationConsole('existing layout marker found', { version: current.version });
      migrationConsole('layout already current; no data move required', {
        workspaceRoot: getWorkspaceDir(DEFAULT_WORKSPACE),
      });
      return current;
    }
    if (current && legacySourcesPresent.length > 0) {
      migrationConsole('legacy workspace data found after completion marker', {
        sources: legacySourcesPresent.length,
        strategy: 'direct rename/merge',
      });
    }

    await fs.mkdir(getWorkspaceDir(DEFAULT_WORKSPACE), { recursive: true });

    migrationConsole('preflight started', {
      candidates: planned.length,
      strategy: 'direct rename/merge',
    });
    const collectedLinks: SavedLink[] = [];
    for (const candidate of planned) {
      const stat = await lstatOptional(candidate.source);
      if (stat?.isDirectory() && !stat.isSymbolicLink()) {
        await collectLinks(candidate.source, candidate.destination, mappings, collectedLinks, errors, pendingLinks);
      }
    }
    requireComplete();
    const linkByDestination = new Map(pendingLinks.map(link => [link.destination, link]));
    for (const link of collectedLinks) {
      const pending = linkByDestination.get(link.destination);
      if (pending && (pending.source !== link.source || pending.originalTarget !== link.originalTarget
          || pending.dev !== link.dev || pending.ino !== link.ino)) {
        throw new Error('Original migration link changed while recovery was pending. Keep both the link and recovery record.');
      }
      linkByDestination.set(link.destination, pending ?? link);
    }
    const savedLinks = [...linkByDestination.values()];
    // Persist and sync every required remap before the first directory rename.
    await writeLinkRecovery(savedLinks);
    const moved = new Set<string>();
    const merged = new Set<string>();
    const present = new Set<string>();

    for (const candidate of planned) {
      migrationConsole('preflight candidate', {
        subtree: candidate.subtree,
        sources: 1,
        destination: candidate.destination,
        strategy: 'direct rename/merge',
      });
      const stat = await lstatOptional(candidate.source).catch(error => {
        errors.push(`Could not inspect ${candidate.source}: ${String(error)}`);
        return undefined;
      });
      if (!stat) {
        narration.push({
          status: 'SKIPPED',
          subject: candidate.subtree,
          source: candidate.source,
          destination: candidate.destination,
          reason: 'legacy source does not exist',
        });
        migrationConsole('preflight candidate ready', {
          subtree: candidate.subtree,
          outcome: 'skipped',
          strategy: 'source absent',
        });
        continue;
      }
      present.add(candidate.subtree);
      if (stat.isSymbolicLink() || (candidate.requireDirectory !== false && !stat.isDirectory())) {
        warnings.push(`Skipped unsafe legacy root ${candidate.source}`);
        narration.push({
          status: 'SKIPPED',
          subject: candidate.subtree,
          source: candidate.source,
          destination: candidate.destination,
          reason: 'legacy root is not a real directory',
        });
        continue;
      }
      migrationConsole('commit entry started', {
        subtree: candidate.subtree,
        outcome: 'moved',
        strategy: 'direct rename/merge',
      });
      // Keep the workspace mcp-servers container in place, but prefer moving
      // each server folder below it wholesale. This matters for pre-created
      // workspace/volume roots and still lets populated name collisions use the
      // lossless recursive merge below.
      const preserveMcpContainer = candidate.subtree === 'mcp-servers'
        && path.basename(candidate.source).toLowerCase() === 'mcp-servers';
      const outcome = await moveMerge(
        candidate.source,
        candidate.destination,
        errors,
        !preserveMcpContainer,
      );
      if (outcome) {
        moved.add(candidate.subtree);
        if (outcome === 'merged') merged.add(candidate.subtree);
        narration.push({
          status: outcome === 'merged' ? 'MERGED' : 'MOVED',
          subject: candidate.subtree,
          source: candidate.source,
          destination: candidate.destination,
          reason: outcome === 'merged'
            ? 'target already existed; moved whole source directories where possible and recursively merged populated name collisions'
            : 'renamed the legacy directory directly into the workspace',
        });
        migrationConsole('commit entry published', {
          subtree: candidate.subtree,
          strategy: outcome === 'merged' ? 'top-level directory rename/merge' : 'atomic directory rename',
        });
      }
    }

    const restoredLinks = await restoreLinks(savedLinks, errors);
    if (savedLinks.length > 0) narration.push({
      status: restoredLinks === savedLinks.length ? 'MOVED' : 'SKIPPED',
      subject: `${restoredLinks}/${savedLinks.length} symbolic links`,
      reason: restoredLinks === savedLinks.length
        ? 'retained during folder moves and remapped from durable recovery records'
        : 'some links remain pending in the durable recovery record',
    });
    requireComplete();
    await ensureWorkspaceDirs(DEFAULT_WORKSPACE);
    await rewritePersistedMcpServerPaths(errors, narration);
    requireComplete();

    const subtrees = Object.fromEntries(WORKSPACE_SUBTREES.map(subtree => [
      subtree,
      moved.has(subtree)
        ? merged.has(subtree) ? 'reconciled' : 'moved'
        : targetExisting.has(subtree)
          ? 'already-migrated'
        : present.has(subtree)
          ? 'skipped'
          : 'created',
    ])) as Record<string, SubtreeOutcome>;
    const marker: WorkspaceLayoutMarker = {
      version: WORKSPACE_LAYOUT_VERSION,
      completedAt: new Date().toISOString(),
      defaultWorkspace: DEFAULT_WORKSPACE,
      subtrees,
      ...(warnings.length > 0 ? { errors: warnings } : {}),
    };
    await writeMarker(marker);
    if (savedLinks.length) {
      await assertLinkFreeFileParent(getWorkspacesDir(), linkRecoveryPath());
      await fs.unlink(linkRecoveryPath());
    }
    migrationConsole('completion marker published', {
      marker: markerPath(),
      strategy: 'direct rename/merge',
    });
    if (warnings.length > 0) log.warn('Workspace move completed with unsafe roots left untouched', warnings);
    else log.info('Workspace folders moved directly', { workspace: getWorkspaceDir(DEFAULT_WORKSPACE) });
    return marker;
  });
  } finally {
    await release();
    migrationConsole('exclusive lock released', { lock: lockPath() });
  }
}

export function migrateWorkspaceLayout(): Promise<WorkspaceLayoutMarker> {
  const existing = getWorkspaceLayoutPreparation<WorkspaceLayoutMarker>();
  if (existing) return existing;
  const startedAt = Date.now();
  migrationConsole('started', {
    version: WORKSPACE_LAYOUT_VERSION,
    pid: process.pid,
    dataRoot: getDataDir(),
    workspaceRoot: getWorkspaceDir(DEFAULT_WORKSPACE),
    strategy: 'direct rename/merge',
  });
  const preparation = isWorkerMode()
    ? import('./snapshotRestore').then(async ({ restoreConfiguredWorkerSnapshot }) => {
      await restoreConfiguredWorkerSnapshot();
      return runDirectMigration();
    })
    : runDirectMigration();
  const promise = preparation.catch(error => {
    migrationConsole('FAILED - migration incomplete; recovery data retained', {
      elapsed: `${((Date.now() - startedAt) / 1_000).toFixed(1)}s`,
      error: error instanceof Error ? error.message : String(error),
    }, 'error');
    failWorkspaceLayoutPreparation(promise, error);
    throw error;
  });
  void promise.then(marker => {
    const elapsed = `${((Date.now() - startedAt) / 1_000).toFixed(1)}s`;
    migrationConsole('finished successfully', {
      elapsed,
      workspaceRoot: getWorkspaceDir(DEFAULT_WORKSPACE),
      errors: marker.errors?.length ?? 0,
    });
    printCompletionSummary(marker, elapsed);
  }, () => undefined);
  setWorkspaceLayoutPreparation(promise);
  return promise;
}

export const ensureWorkspaceLayoutReady = migrateWorkspaceLayout;

function browserStartUrl(): string {
  const configured = process.env.FLUJO_BROWSER_URL?.trim()
    || process.env.FLUJO_BASE_URL?.trim();
  const fallbackPort = /^\d+$/.test(process.env.FLUJO_PORT?.trim() || '')
    ? process.env.FLUJO_PORT!.trim()
    : '4200';
  try {
    const url = new URL(configured || `http://localhost:${fallbackPort}`);
    if (['127.0.0.1', '[::1]', '::1', '0.0.0.0', '[::]', '::'].includes(url.hostname)) {
      url.hostname = 'localhost';
    }
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return `http://localhost:${fallbackPort}`;
  }
}

function printCompletionSummary(marker: WorkspaceLayoutMarker, elapsed: string): void {
  const moved = lastNarration.filter(item => item.status === 'MOVED').length;
  const merged = lastNarration.filter(item => item.status === 'MERGED').length;
  const updated = lastNarration.filter(item => item.status === 'UPDATED').length;
  const skipped = lastNarration.filter(item => item.status === 'SKIPPED').length;
  const cleaned = lastNarration.filter(item => item.status === 'CLEANED').length;
  const errorCount = marker.errors?.length ?? 0;
  const browserUrl = browserStartUrl();
  const onlySkipped = errorCount === 0
    && lastNarration.length > 0
    && lastNarration.every(item => item.status === 'SKIPPED');

  if (onlySkipped) {
    console.info([
      '',
      `[FLUJO] Workspace migration: nothing to do (${skipped} skipped, ${elapsed})`,
      `[FLUJO] Start FLUJO in the browser: [${browserUrl}](${browserUrl})`,
      '',
    ].join('\n'));
    return;
  }

  const lines = [''];
  for (const item of lastNarration) {
    const route = item.source && item.destination
      ? `${item.source} -> ${item.destination}`
      : item.source ?? item.destination ?? item.subject;
    lines.push(`[FLUJO] ${item.status.padEnd(7)} ${item.subject}: ${route}`);
    lines.push(`[FLUJO]         Why: ${item.reason}`);
  }
  for (const error of marker.errors ?? []) {
    lines.push(`[FLUJO] ERROR   ${error}`);
    lines.push('[FLUJO]         Why: this unsafe legacy root was left untouched');
  }
  lines.push(
    '[FLUJO] Workspace migration summary',
    `[FLUJO] Result: ${moved} moved, ${merged} merged, ${updated} updated, ${skipped} skipped, `
      + `${errorCount} errors, ${cleaned} obsolete artifacts cleaned (${elapsed})`,
    `[FLUJO] Start FLUJO in the browser: [${browserUrl}](${browserUrl})`,
    '',
  );
  console.info(lines.join('\n'));
}
