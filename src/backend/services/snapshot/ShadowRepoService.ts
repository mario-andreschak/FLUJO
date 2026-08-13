/**
 * ShadowRepoService — git-based shadow-repository snapshots for installed
 * host-path MCP packages (issue #250).
 *
 * Those packages can mutate the host with no undo. Confinement
 * (`internal/confinement.ts`) limits *where* writes land but nothing records
 * *what* changed or can put it back — which matters most for scheduled /
 * unattended runs where nobody watches the diff go by.
 *
 * This service captures the confinement roots into a **separate shadow git
 * repository** whose gitdir lives under `getDataDir()/snapshots/<hash(root)>`
 * and whose *work tree is the confinement root itself*. Every git command is
 * issued with an explicit `--git-dir=<shadow>` / `--work-tree=<root>`, so the
 * user's own git state (their real `.git`: index, HEAD, branches, stash,
 * reflog) is **provably never touched** — an explicit acceptance criterion of
 * issue #250. Git also never descends into a nested `.git`, so the real repo's
 * internals are not captured either.
 *
 * Everything here is BEST-EFFORT: any failure is logged and degrades to
 * "no snapshot" (returns `null`) — a capture failure must never abort a run.
 *
 * Disabled when snapshots are switched off (env `FLUJO_SNAPSHOTS=0`) or when
 * the target is not a git repository (mirrors opencode: we only snapshot real
 * project directories, which also skips the default `getDataDir()` root).
 */
import path from 'path';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import simpleGit, { SimpleGit } from 'simple-git';
import { createLogger } from '@/utils/logger';
import { loadItem } from '@/utils/storage/backend';
import { StorageKey, type Settings } from '@/shared/types/storage/storage';
import { snapshotStore } from './SnapshotStore';
import { getWorkspaceDataDir } from '@/utils/workspace';

const log = createLogger('backend/services/snapshot/ShadowRepoService');

export interface ChangedFile {
  /** Repo-relative POSIX path of the changed file. */
  path: string;
  /** git name-status code: A(dded) / M(odified) / D(eleted) / R(enamed) / … */
  status: string;
}

// The shadow-repo root (gitdirs live under here). Overridable for tests via
// _setShadowRepoDirForTests, mirroring conversationLog's test seam.
let shadowRootDir: string | null = null;

/** Test seam: point the shadow-repo store at a temp directory. Returns previous. */
export function _setShadowRepoDirForTests(dir: string | null): string | null {
  const previous = shadowRootDir;
  shadowRootDir = dir;
  return previous;
}

function resolveShadowRootDir(): string {
  if (shadowRootDir) return shadowRootDir;
  // Snapshots are workspace-owned user data (#406).
  return path.join(getWorkspaceDataDir(), 'snapshots');
}

/** Snapshots globally on unless the operator or user switches them off. */
async function snapshotsEnabled(): Promise<boolean> {
  const raw = (process.env.FLUJO_SNAPSHOTS || '').trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off') return false;

  try {
    const settings = await loadItem<Settings | undefined>(
      StorageKey.SPEECH_SETTINGS,
      undefined,
    );
    return settings?.experimental?.snapshotsEnabled !== false;
  } catch (error) {
    log.warn('Could not load snapshot setting; keeping snapshots enabled', error);
    return true;
  }
}

/** Deterministic shadow gitdir for a confinement root. */
function gitDirFor(root: string): string {
  const abs = path.resolve(root);
  const hash = crypto.createHash('sha1').update(abs).digest('hex').slice(0, 16);
  return path.join(resolveShadowRootDir(), hash, 'git');
}

/**
 * A simple-git client whose cwd is the confinement root but whose every command
 * is pinned to the SEPARATE shadow gitdir (never the user's real `.git`). The
 * `--git-dir` / `--work-tree` prefix is applied per-call via raw().
 */
function clientFor(root: string): SimpleGit {
  return simpleGit(path.resolve(root));
}

function gitArgs(root: string): string[] {
  return [`--git-dir=${gitDirFor(root)}`, `--work-tree=${path.resolve(root)}`];
}

class ShadowRepoService {
  /**
   * True when snapshots are on AND `root` is an existing git repository.
   * Read-only: `checkIsRepo` inspects the real repo but never mutates it.
   */
  async isEnabledFor(root: string): Promise<boolean> {
    if (!(await snapshotsEnabled())) return false;
    try {
      const abs = path.resolve(root);
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat || !stat.isDirectory()) return false;
      // Git discovery walks ancestor directories, so `checkIsRepo()` alone
      // would incorrectly accept a plain nested folder in a parent repository.
      // Only a target that is itself the worktree root is eligible.
      const git = simpleGit(abs);
      if (!(await git.checkIsRepo())) return false;
      const topLevel = (await git.raw(['rev-parse', '--show-toplevel'])).trim();
      return path.resolve(topLevel) === abs;
    } catch (err) {
      log.debug('isEnabledFor: not a git repo / unavailable', { root, err });
      return false;
    }
  }

  /** Ensure the shadow gitdir exists and is initialised (idempotent). */
  private async ensureShadowRepo(root: string): Promise<void> {
    const gitDir = gitDirFor(root);
    const head = path.join(gitDir, 'HEAD');
    const exists = await fs
      .access(head)
      .then(() => true)
      .catch(() => false);
    if (exists) return;
    await fs.mkdir(gitDir, { recursive: true });
    const git = clientFor(root);
    await git.raw([...gitArgs(root), 'init']);
    // Identity + no signing so commits succeed in headless / CI environments
    // regardless of the operator's global git config.
    await git.raw([...gitArgs(root), 'config', 'user.email', 'snapshot@flujo.local']);
    await git.raw([...gitArgs(root), 'config', 'user.name', 'FLUJO Snapshot']);
    await git.raw([...gitArgs(root), 'config', 'commit.gpgsign', 'false']);
    await git.raw([...gitArgs(root), 'config', 'core.autocrlf', 'false']);
  }

  /**
   * Capture the current worktree state of `root` into the shadow repo and
   * return the commit SHA, or `null` when disabled / on any failure. Respects
   * the root's `.gitignore`, includes untracked files, and (with --allow-empty)
   * always produces a commit so a no-change before/after pair still yields two
   * comparable SHAs. NEVER throws.
   */
  async capture(root: string): Promise<string | null> {
    if (!(await this.isEnabledFor(root))) return null;
    try {
      // Coordinate the full shadow-repository transaction with destructive
      // cleanup. The lock covers only workspace-derived Git metadata; it never
      // locks or mutates the project's real `.git` directory.
      const sha = await snapshotStore.withExclusiveAccess(async () => {
        await this.ensureShadowRepo(root);
        const git = clientFor(root);
        await git.raw([...gitArgs(root), 'add', '-A']);
        await git.raw([
          ...gitArgs(root),
          'commit',
          '--no-verify',
          '--allow-empty',
          '-m',
          `snapshot ${new Date().toISOString()}`,
        ]);
        return (await git.raw([...gitArgs(root), 'rev-parse', 'HEAD'])).trim();
      });
      // Retention is independent from capture enablement. Maintenance can only
      // remove the isolated workspace store; failures never affect the run.
      const policy = await snapshotStore.policy();
      if (policy.enabled && policy.automaticCleanup) {
        await snapshotStore.cleanup().catch((error: unknown) => log.warn('snapshot cleanup failed', { error }));
      }
      return sha || null;
    } catch (err) {
      log.warn('capture failed — degrading to no snapshot', { root, err });
      return null;
    }
  }

  /**
   * List changed paths between two snapshots (or between a snapshot and the
   * working tree when `to` is omitted) without loading file content. Returns
   * `[]` on any failure.
   */
  async files(root: string, from: string, to?: string): Promise<ChangedFile[]> {
    try {
      const git = clientFor(root);
      const range = to ? [from, to] : [from];
      const out = await git.raw([...gitArgs(root), 'diff', '--name-status', ...range]);
      return this.parseNameStatus(out);
    } catch (err) {
      log.warn('files() failed', { root, from, to, err });
      return [];
    }
  }

  /** Per-file unified patch between two snapshots (or snapshot→worktree). */
  async diff(root: string, from: string, to?: string): Promise<string> {
    try {
      const git = clientFor(root);
      const range = to ? [from, to] : [from];
      return await git.raw([...gitArgs(root), 'diff', ...range]);
    } catch (err) {
      log.warn('diff() failed', { root, from, to, err });
      return '';
    }
  }

  /**
   * Selectively revert the worktree of `root` to the state captured in
   * `toSnapshot`, touching ONLY the given `paths` (or every path that changed
   * since `toSnapshot` when `paths` is omitted). Files created after the
   * snapshot are removed; modified/deleted files are restored to their snapshot
   * content. Unrelated edits are left alone.
   *
   * Reversible: a pre-revert snapshot is captured FIRST and its SHA returned so
   * the caller can un-revert. Returns `null` on failure (best-effort).
   */
  async revert(root: string, toSnapshot: string, paths?: string[]): Promise<string | null> {
    if (!(await this.isEnabledFor(root))) return null;
    try {
      // Un-revert anchor: capture the current state before mutating anything.
      const preRevert = await this.capture(root);
      await snapshotStore.withExclusiveAccess(async () => {
        const git = clientFor(root);

        // What differs between the target snapshot and the current HEAD.
        const changed = await this.files(root, toSnapshot, 'HEAD');
        const wanted = paths && paths.length ? new Set(paths.map((p) => p.replace(/\\/g, '/'))) : null;
        const selected = changed.filter((c) => !wanted || wanted.has(c.path));

        for (const c of selected) {
          if (c.status.startsWith('A')) {
            // Added after the snapshot → remove it to revert the creation.
            await git.raw([...gitArgs(root), 'rm', '-f', '--', c.path]).catch((err) => {
              log.warn('revert: rm failed for added path', { path: c.path, err });
            });
          } else {
            // Modified/deleted → restore the snapshot version into the worktree.
            await git.raw([...gitArgs(root), 'checkout', toSnapshot, '--', c.path]).catch((err) => {
              log.warn('revert: checkout failed', { path: c.path, err });
            });
          }
        }
      });
      return preRevert;
    } catch (err) {
      log.warn('revert failed', { root, toSnapshot, err });
      return null;
    }
  }

  private parseNameStatus(out: string): ChangedFile[] {
    const files: ChangedFile[] = [];
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split('\t');
      const status = parts[0];
      // For renames (R100) git prints old\tnew — take the new path.
      const filePath = parts[parts.length - 1];
      if (filePath) files.push({ path: filePath.replace(/\\/g, '/'), status });
    }
    return files;
  }
}

export const shadowRepoService = new ShadowRepoService();
export type { ShadowRepoService };
