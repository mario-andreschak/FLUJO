import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import {
  addProjectWorktree,
  createProjectBranch,
  isProjectCheckout,
  parseWorktreeList,
  readProjectGit,
  removeProjectWorktree,
  switchProjectBranch,
  worktreeContainerFor,
  worktreeSlug,
} from '@/backend/services/projects/projectGit';

describe('project Git integration', () => {
  let parent: string;
  let repo: string;

  beforeEach(async () => {
    parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-project-git-')));
    repo = path.join(parent, 'app');
    await fs.mkdir(repo);
    const git = simpleGit(repo);
    await git.init();
    await git.addConfig('user.name', 'FLUJO Test');
    await git.addConfig('user.email', 'test@example.invalid');
    await git.raw(['checkout', '-b', 'main']);
    await fs.writeFile(path.join(repo, 'README.md'), 'hello\n');
    await git.add('.');
    await git.commit('initial');
  });

  afterEach(async () => {
    await fs.rm(parent, { recursive: true, force: true });
  });

  it('reports branch, changes, branches and the main worktree', async () => {
    await fs.writeFile(path.join(repo, 'new.txt'), 'x');
    const status = await readProjectGit(repo);
    expect(status).toMatchObject({ branch: 'main', changes: 1, branches: ['main'] });
    expect(status?.worktrees).toHaveLength(1);
    expect(status?.worktrees[0]).toMatchObject({ branch: 'main', main: true });
    expect(path.resolve(status!.worktrees[0].path).toLowerCase()).toBe(path.resolve(repo).toLowerCase());
  });

  it('returns null for a folder that is not a repository', async () => {
    const plain = path.join(parent, 'plain');
    await fs.mkdir(plain);
    await expect(readProjectGit(plain)).resolves.toBeNull();
  });

  it('creates and switches branches, refusing a dirty tree', async () => {
    await createProjectBranch(repo, 'feature/login');
    expect((await readProjectGit(repo))?.branch).toBe('feature/login');

    await fs.writeFile(path.join(repo, 'README.md'), 'changed\n');
    await expect(switchProjectBranch(repo, 'main')).rejects.toMatchObject({ code: 'DIRTY_WORKTREE' });
    expect((await readProjectGit(repo))?.branch).toBe('feature/login');

    await simpleGit(repo).raw(['checkout', '--', 'README.md']);
    await switchProjectBranch(repo, 'main');
    expect((await readProjectGit(repo))?.branch).toBe('main');
  });

  it.each(['-x', 'bad..name', 'with space', ''])('rejects the branch name %p', async name => {
    await expect(createProjectBranch(repo, name)).rejects.toMatchObject({ code: 'INVALID_BRANCH' });
  });

  it('adds a worktree beside the repository and removes it again', async () => {
    const created = await addProjectWorktree(repo, 'feat/x', true);
    expect(created).toBe(path.join(worktreeContainerFor(repo), 'feat-x'));
    const status = await readProjectGit(repo);
    expect(status?.branches).toEqual(expect.arrayContaining(['main', 'feat/x']));
    expect(status?.worktrees.map(worktree => [worktree.branch, worktree.managed])).toEqual([['main', false], ['feat/x', true]]);
    await expect(isProjectCheckout(repo, created)).resolves.toBe(true);
    await expect(isProjectCheckout(repo, parent)).resolves.toBe(false);

    await expect(addProjectWorktree(repo, 'feat/x', false)).rejects.toMatchObject({ code: 'WORKTREE_EXISTS' });
    await expect(removeProjectWorktree(repo, repo)).rejects.toMatchObject({ code: 'NOT_A_WORKTREE' });

    await removeProjectWorktree(repo, created);
    expect((await readProjectGit(repo))?.worktrees).toHaveLength(1);
  });

  it('never removes a worktree another tool created', async () => {
    const foreign = path.join(parent, 'agent-checkout');
    await simpleGit(repo).raw(['worktree', 'add', '-b', 'agent/run', foreign]);
    const status = await readProjectGit(repo);
    expect(status?.worktrees.find(worktree => worktree.branch === 'agent/run')).toMatchObject({ managed: false });
    await expect(removeProjectWorktree(repo, foreign)).rejects.toMatchObject({ code: 'NOT_A_WORKTREE' });
    await expect(fs.stat(foreign)).resolves.toBeTruthy();
  });

  it('parses porcelain worktree output and folder-safe slugs', () => {
    const parsed = parseWorktreeList([
      'worktree /repo', 'HEAD 0123456789abcdef', 'branch refs/heads/main', '',
      'worktree /repo.worktrees/x', 'HEAD fedcba9876543210', 'detached', '',
      'worktree /elsewhere/y', 'HEAD 1111111111111111', 'branch refs/heads/y', '',
      'worktree /repo.worktrees/gone', 'HEAD 2222222222222222', 'branch refs/heads/gone', 'prunable gitdir file points to non-existent location', '',
    ].join('\n'));
    expect(parsed).toEqual([
      { path: path.resolve('/repo'), branch: 'main', head: '0123456789ab', main: true, managed: false },
      { path: path.resolve('/repo.worktrees/x'), branch: null, head: 'fedcba987654', main: false, managed: true },
      // Another tool's worktree: listed, but not FLUJO's to offer removing.
      { path: path.resolve('/elsewhere/y'), branch: 'y', head: '111111111111', main: false, managed: false },
    ]);
    expect(worktreeSlug('feat/login page')).toBe('feat-login-page');
  });
});
