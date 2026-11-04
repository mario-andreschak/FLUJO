/**
 * Git awareness for workspace projects: which branch a project folder is on,
 * which branches and worktrees exist, and the few mutations the project switcher
 * offers (switch branch, create branch, add/remove a worktree).
 *
 * Every mutation is deliberately conservative: switching branches refuses a
 * dirty working tree (the UI offers a worktree instead), and worktree removal
 * never forces and only touches worktrees FLUJO created, so nothing here can
 * discard uncommitted work or another tool's checkout.
 */
import path from 'path';
import fs from 'fs/promises';
import { simpleGit, type SimpleGit } from 'simple-git';
import { isSafeBranchName } from '@/utils/git/validation';
import { sameFilesystemPath } from '@/utils/workspace';

const GIT_TIMEOUT_MS = 15_000;
const MAX_LISTED_BRANCHES = 300;

export type ProjectGitErrorCode =
  | 'NOT_A_REPOSITORY'
  | 'INVALID_BRANCH'
  | 'DIRTY_WORKTREE'
  | 'WORKTREE_EXISTS'
  | 'NOT_A_WORKTREE'
  | 'GIT_FAILED';

export class ProjectGitError extends Error {
  constructor(readonly code: ProjectGitErrorCode, message: string) {
    super(message);
    this.name = 'ProjectGitError';
  }
}

export interface ProjectWorktree {
  path: string;
  /** Short branch name, or null for a detached HEAD. */
  branch: string | null;
  head: string | null;
  /** The repository's main checkout (the first `git worktree list` entry). */
  main: boolean;
  /** Created by FLUJO, i.e. inside the repository's `<repo>.worktrees` folder. */
  managed: boolean;
}

export interface ProjectGitStatus {
  /** Top level of the checkout the queried folder belongs to. */
  repoRoot: string;
  /** Short branch name, or null for a detached HEAD. */
  branch: string | null;
  head: string | null;
  /** Number of changed (modified, staged or untracked) paths. */
  changes: number;
  upstream: string | null;
  ahead: number;
  behind: number;
  branches: string[];
  remoteBranches: string[];
  worktrees: ProjectWorktree[];
}

function git(baseDir: string): SimpleGit {
  return simpleGit({ baseDir, timeout: { block: GIT_TIMEOUT_MS } });
}

function gitFailure(error: unknown): ProjectGitError {
  if (error instanceof ProjectGitError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ProjectGitError('GIT_FAILED', message.trim() || 'Git command failed.');
}

/** Top level of the repository containing `dir`, or null when it is not one. */
export async function resolveRepoRoot(dir: string): Promise<string | null> {
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) return null;
    const top = (await git(dir).revparse(['--show-toplevel'])).trim();
    return top ? path.resolve(top) : null;
  } catch {
    return null;
  }
}

function isInsideFolder(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Parse `git worktree list --porcelain`. The first entry is the main checkout.
 * Bare entries and prunable ones (their folder is gone) are left out.
 */
export function parseWorktreeList(output: string): ProjectWorktree[] {
  const worktrees: ProjectWorktree[] = [];
  let container: string | null = null;
  output.split(/\r?\n\r?\n/).forEach((block, index) => {
    const lines = block.split(/\r?\n/);
    let current: ProjectWorktree | null = null;
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        current = { path: path.resolve(line.slice('worktree '.length)), branch: null, head: null, main: index === 0, managed: false };
      } else if (current && line.startsWith('HEAD ')) {
        current.head = line.slice('HEAD '.length).slice(0, 12);
      } else if (current && line.startsWith('branch ')) {
        current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      }
    }
    if (!current) return;
    if (current.main) container = worktreeContainerFor(current.path);
    if (lines.includes('bare') || lines.some(line => line === 'prunable' || line.startsWith('prunable '))) return;
    current.managed = !current.main && container !== null && isInsideFolder(container, current.path);
    worktrees.push(current);
  });
  return worktrees;
}

async function listRefs(repo: SimpleGit, namespace: string): Promise<string[]> {
  const output = await repo.raw(['for-each-ref', '--format=%(refname:short)', `--count=${MAX_LISTED_BRANCHES}`, namespace]);
  return output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

/** Git state of a project folder, or null when the folder is not a repository. */
export async function readProjectGit(dir: string): Promise<ProjectGitStatus | null> {
  const repoRoot = await resolveRepoRoot(dir);
  if (!repoRoot) return null;
  const repo = git(repoRoot);
  try {
    const [status, branches, remotes, worktreeOutput] = await Promise.all([
      repo.status(),
      listRefs(repo, 'refs/heads'),
      listRefs(repo, 'refs/remotes'),
      repo.raw(['worktree', 'list', '--porcelain']),
    ]);
    const head = (await repo.revparse(['--short', 'HEAD']).catch(() => '')).trim() || null;
    return {
      repoRoot,
      branch: status.detached ? null : status.current || null,
      head,
      changes: status.files.length,
      upstream: status.tracking || null,
      ahead: status.ahead,
      behind: status.behind,
      branches,
      remoteBranches: remotes.filter(ref => !ref.endsWith('/HEAD') && ref.includes('/')),
      worktrees: parseWorktreeList(worktreeOutput),
    };
  } catch (error) {
    throw gitFailure(error);
  }
}

async function requireRepo(dir: string): Promise<{ repoRoot: string; repo: SimpleGit }> {
  const repoRoot = await resolveRepoRoot(dir);
  if (!repoRoot) throw new ProjectGitError('NOT_A_REPOSITORY', `${dir} is not inside a Git repository.`);
  return { repoRoot, repo: git(repoRoot) };
}

/** Validate a branch name with Git's own rules; never lets an option through. */
async function assertBranchName(repo: SimpleGit, branch: unknown): Promise<string> {
  if (!isSafeBranchName(branch)) throw new ProjectGitError('INVALID_BRANCH', 'Enter a valid branch name.');
  const name = (branch as string).trim();
  try {
    await repo.raw(['check-ref-format', '--branch', name]);
  } catch {
    throw new ProjectGitError('INVALID_BRANCH', `"${name}" is not a valid branch name.`);
  }
  return name;
}

/**
 * Check out an existing branch in `dir`. A remote-only branch (`origin/x` given
 * as `x`) is created as a tracking branch by Git's own `switch` guessing.
 * Refuses a dirty tree so uncommitted work never silently follows the switch.
 */
export async function switchProjectBranch(dir: string, branch: unknown): Promise<void> {
  const { repo } = await requireRepo(dir);
  const name = await assertBranchName(repo, branch);
  const status = await repo.status().catch(error => { throw gitFailure(error); });
  if (status.files.length > 0) {
    throw new ProjectGitError(
      'DIRTY_WORKTREE',
      `This folder has ${status.files.length} uncommitted change(s). Commit or stash them first, or open "${name}" in a new worktree.`,
    );
  }
  try {
    await repo.raw(['switch', name]);
  } catch (error) {
    throw gitFailure(error);
  }
}

/** Create a branch from the current HEAD and switch to it; changes carry over. */
export async function createProjectBranch(dir: string, branch: unknown): Promise<void> {
  const { repo } = await requireRepo(dir);
  const name = await assertBranchName(repo, branch);
  try {
    await repo.raw(['switch', '-c', name]);
  } catch (error) {
    throw gitFailure(error);
  }
}

/** Folder-safe slug for a branch name (`feat/login` → `feat-login`). */
export function worktreeSlug(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '') || 'worktree';
}

/**
 * Where FLUJO creates worktrees for a repository: a `<repo>.worktrees` folder
 * beside the main checkout, so worktrees never nest inside the repository.
 */
export function worktreeContainerFor(mainCheckout: string): string {
  const resolved = path.resolve(mainCheckout);
  return path.join(path.dirname(resolved), `${path.basename(resolved)}.worktrees`);
}

/**
 * Add a worktree for `branch`. With `createBranch` the branch is created from
 * the current HEAD; otherwise an existing (local or remote) branch is used.
 * Returns the new worktree's path.
 */
export async function addProjectWorktree(
  dir: string,
  branch: unknown,
  createBranch: boolean,
): Promise<string> {
  const { repoRoot, repo } = await requireRepo(dir);
  const name = await assertBranchName(repo, branch);
  let worktrees: ProjectWorktree[];
  try {
    worktrees = parseWorktreeList(await repo.raw(['worktree', 'list', '--porcelain']));
  } catch (error) {
    throw gitFailure(error);
  }
  const main = worktrees.find(worktree => worktree.main)?.path ?? repoRoot;
  const target = path.join(worktreeContainerFor(main), worktreeSlug(name));
  try {
    await fs.access(target);
    throw new ProjectGitError('WORKTREE_EXISTS', `${target} already exists.`);
  } catch (error) {
    if (error instanceof ProjectGitError) throw error;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await repo.raw(createBranch
      ? ['worktree', 'add', '-b', name, target]
      : ['worktree', 'add', target, name]);
  } catch (error) {
    throw gitFailure(error);
  }
  return path.resolve(target);
}

/** Remove a linked worktree. Never forces: Git refuses when it has changes. */
export async function removeProjectWorktree(dir: string, worktreePath: string): Promise<void> {
  const { repo } = await requireRepo(dir);
  let worktrees: ProjectWorktree[];
  try {
    worktrees = parseWorktreeList(await repo.raw(['worktree', 'list', '--porcelain']));
  } catch (error) {
    throw gitFailure(error);
  }
  const target = worktrees.find(worktree => sameFilesystemPath(worktree.path, worktreePath));
  // Other tools' worktrees (and the main checkout) are never FLUJO's to remove.
  if (!target || !target.managed) {
    throw new ProjectGitError('NOT_A_WORKTREE', `${worktreePath} is not a worktree FLUJO created for this repository.`);
  }
  try {
    await repo.raw(['worktree', 'remove', target.path]);
  } catch (error) {
    throw gitFailure(error);
  }
}

/**
 * Whether `candidate` is the checkout of `project` or one of its worktrees.
 * Only lists worktrees (no status), so it stays cheap on large repositories.
 */
export async function isProjectCheckout(project: string, candidate: string): Promise<boolean> {
  if (sameFilesystemPath(project, candidate)) return true;
  try {
    const worktrees = parseWorktreeList(await git(project).raw(['worktree', 'list', '--porcelain']));
    return worktrees.some(worktree => sameFilesystemPath(worktree.path, candidate));
  } catch {
    return false;
  }
}
