import path from 'path';
import fs from 'fs/promises';
import { getDataDir } from '@/utils/paths';
import {
  DEFAULT_WORKSPACE,
  WORKSPACE_SUBTREES,
  WorkspaceSubtree,
  ensureWorkspaceDirs,
  getWorkspaceDir,
  getWorkspacesDir,
} from '@/utils/workspace';
import { createLogger } from '@/utils/logger';

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
 *   - both have content    -> STOP with an actionable conflict error
 *
 * That makes a fresh install, a legacy install, an already-migrated install, an
 * interrupted migration and two racing startups all deterministic.
 */

/** Bump when the on-disk layout changes again; older markers then re-run. */
export const WORKSPACE_LAYOUT_VERSION = 1;

const MARKER_FILE = '.workspace-layout.json';

export interface WorkspaceLayoutMarker {
  version: number;
  completedAt: string;
  defaultWorkspace: string;
  subtrees: Record<string, SubtreeOutcome>;
}

export type SubtreeOutcome =
  | 'created'
  | 'moved'
  | 'copied'
  | 'already-migrated'
  | 'skipped';

/**
 * A source/destination conflict. Deliberately its own class so startup can
 * surface a precise operator instruction instead of a generic ENOTEMPTY.
 */
export class WorkspaceMigrationConflictError extends Error {
  readonly code = 'WORKSPACE_MIGRATION_CONFLICT';

  constructor(subtree: string, source: string, destination: string) {
    super(
      `Cannot migrate "${subtree}" into the default workspace: both the legacy ` +
        `location and the workspace location contain data.\n` +
        `  legacy:    ${source}\n` +
        `  workspace: ${destination}\n` +
        `FLUJO will not merge or overwrite either copy. Decide which one is ` +
        `authoritative, back up the other, remove (or empty) the losing ` +
        `directory, then start FLUJO again.`,
    );
    this.name = 'WorkspaceMigrationConflictError';
  }
}

let inFlight: Promise<WorkspaceLayoutMarker> | undefined;

/**
 * Ensure the workspace layout exists and legacy data has been migrated.
 * Concurrent callers share a single run; the memo is cleared afterwards so a
 * failed migration can be retried by the next caller.
 */
export function migrateWorkspaceLayout(): Promise<WorkspaceLayoutMarker> {
  if (inFlight) return inFlight;
  inFlight = runMigration().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

/** Test seam: forget the in-flight promise (never the on-disk marker). */
export function _resetWorkspaceMigrationState(): void {
  inFlight = undefined;
}

function markerPath(): string {
  return path.join(getWorkspacesDir(), MARKER_FILE);
}

async function readMarker(): Promise<WorkspaceLayoutMarker | undefined> {
  try {
    const raw = await fs.readFile(markerPath(), 'utf-8');
    const parsed = JSON.parse(raw) as WorkspaceLayoutMarker;
    if (typeof parsed?.version === 'number') return parsed;
    return undefined;
  } catch {
    // Missing (normal, first run) or unreadable/corrupt: re-run the migration.
    // Re-running is safe — every step is idempotent and conflict-checked.
    return undefined;
  }
}

async function runMigration(): Promise<WorkspaceLayoutMarker> {
  const existing = await readMarker();
  if (existing && existing.version >= WORKSPACE_LAYOUT_VERSION) {
    return existing;
  }

  const dataRoot = getDataDir();
  const workspaceRoot = getWorkspaceDir(DEFAULT_WORKSPACE);
  await fs.mkdir(workspaceRoot, { recursive: true });

  const subtrees: Record<string, SubtreeOutcome> = {};
  for (const subtree of WORKSPACE_SUBTREES) {
    subtrees[subtree] = await migrateSubtree(
      subtree,
      path.join(dataRoot, subtree),
      path.join(workspaceRoot, subtree),
    );
  }

  // Only now — with all three subtrees resolved — is the layout complete.
  await ensureWorkspaceDirs(DEFAULT_WORKSPACE);
  const marker: WorkspaceLayoutMarker = {
    version: WORKSPACE_LAYOUT_VERSION,
    completedAt: new Date().toISOString(),
    defaultWorkspace: DEFAULT_WORKSPACE,
    subtrees,
  };
  await fs.writeFile(markerPath(), JSON.stringify(marker, null, 2), 'utf-8');
  log.info('Workspace layout ready', { workspaceRoot, subtrees });
  return marker;
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

  // Source has content.
  if (destinationState === 'populated') {
    throw new WorkspaceMigrationConflictError(subtree, source, destination);
  }

  // Destination missing or empty: safe to move the whole subtree.
  if (destinationState === 'empty') {
    // rename() onto an existing directory is portable only when the target is
    // absent, so clear the empty placeholder first.
    await fs.rmdir(destination).catch(() => undefined);
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });

  try {
    await fs.rename(source, destination);
    log.info(`Migrated "${subtree}" into the default workspace`, { source, destination });
    return 'moved';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EXDEV: different volumes (bind mounts, Docker volumes). EPERM/EBUSY/EACCES:
    // Windows can transiently refuse a directory rename. Fall back to a verified
    // copy; the source is only deleted once the copy has been checked.
    if (!code || !['EXDEV', 'EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(code)) {
      throw error;
    }
    log.warn(`rename() failed for "${subtree}" (${code}) — falling back to copy+verify`, {
      source,
      destination,
    });
    await copyDir(source, destination);
    await verifyCopy(source, destination);
    await fs.rm(source, { recursive: true, force: true });
    log.info(`Copied "${subtree}" into the default workspace`, { source, destination });
    return 'copied';
  }
}

type DirState = 'missing' | 'empty' | 'populated' | 'other';

async function inspect(dir: string): Promise<DirState> {
  let stat;
  try {
    stat = await fs.stat(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
  if (!stat.isDirectory()) return 'other';
  const entries = await fs.readdir(dir);
  return entries.length === 0 ? 'empty' : 'populated';
}

async function copyDir(source: string, destination: string): Promise<void> {
  // `fs.cp` preserves symlinks as symlinks, which matters for node_modules trees
  // inside mcp-servers/.
  await fs.cp(source, destination, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}

/**
 * Confirm every source entry exists at the destination with the same size before
 * the source is deleted. A cheap structural check, not a checksum — enough to
 * catch a truncated or partially failed copy without re-reading gigabytes.
 */
async function verifyCopy(source: string, destination: string): Promise<void> {
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await verifyCopy(from, to);
      continue;
    }
    if (entry.isSymbolicLink()) {
      await fs.lstat(to); // throws if the link wasn't copied
      continue;
    }
    const [a, b] = await Promise.all([fs.stat(from), fs.stat(to)]);
    if (a.size !== b.size) {
      throw new Error(
        `Workspace migration copy verification failed: ${from} (${a.size} bytes) ` +
          `!= ${to} (${b.size} bytes). The legacy data has NOT been deleted.`,
      );
    }
  }
}
