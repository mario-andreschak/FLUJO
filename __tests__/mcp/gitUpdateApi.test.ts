/**
 * Regression tests for the git update actions of /api/git:
 *
 *   POST { action: 'checkUpdates', savePath }        -> update status of one cloned repo
 *   POST { action: 'checkUpdatesBatch', paths: [] }  -> per-path status map, degrades per repo
 *   POST { action: 'pullUpdates', savePath }         -> shallow-safe fetch + hard reset
 *
 * These power the "Update available" badge on server cards and the semi-automatic
 * update flow (pull, then re-run the stored install/build commands). Contract points
 * covered here:
 *  - the repository root is resolved by walking UP from the server's rootPath
 *    (`rev-parse --show-toplevel`), because monorepo clones store rootPaths like
 *    servers/src/everything while .git lives at the clone root
 *  - a rootPath that resolves into FLUJO's own repository is refused (the update
 *    hard-resets the whole repo — it must never target the app itself)
 *  - check compares local HEAD against `ls-remote` of the checked-out branch,
 *    falling back to the remote HEAD when detached or when the branch is gone
 *  - only tracked-file modifications are reported (untracked .env files survive
 *    the reset, so they must not trigger the discard warning)
 *  - non-git directories report isGitRepo=false instead of erroring
 *  - a failing repo inside a batch does not fail the whole batch
 *  - pull uses `fetch --depth 1` + `reset --hard FETCH_HEAD` (shallow clones)
 */

// Shared simple-git mock; the route creates instances via simpleGit({ baseDir }).
// The factory records the most recent baseDir on the shared object so revparse
// implementations can answer `--show-toplevel` per directory.
jest.mock('simple-git', () => {
  const git: any = {
    remote: jest.fn(),
    revparse: jest.fn(),
    listRemote: jest.fn(),
    raw: jest.fn(),
    clone: jest.fn(),
    fetch: jest.fn(),
    __baseDir: '',
  };
  return {
    __esModule: true,
    default: jest.fn((opts?: { baseDir?: string }) => {
      git.__baseDir = opts?.baseDir || '';
      return git;
    }),
    __git: git,
  };
});

jest.mock('uuid', () => ({ v4: () => 'test-request-id' }));
jest.mock('@/utils/mcp', () => ({ processPathLikeArgument: (p: string) => p }));

import fs from 'fs/promises';
import os from 'os';
import nodePath from 'path';
import { POST } from '@/app/api/git/route';

const { __git: mockGit } = jest.requireMock('simple-git') as any;

// The route now enforces the localhost origin guard (#131), which reads
// request.headers.get('host'|'origin'); supply a localhost Host so these
// git-action tests exercise the real handler rather than the 403 short-circuit.
const req = (body: unknown) =>
  ({ json: async () => body, headers: new Headers({ host: 'localhost:4200' }) }) as any;

// Real temp directories: a clone root (with a monorepo-style subdirectory) and a
// directory that is not a repo. Git operations themselves are mocked; only the
// savePath existence probe hits disk.
let repoDir: string;
let subDir: string;
let plainDir: string;

beforeAll(async () => {
  repoDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'flujo-git-repo-'));
  subDir = nodePath.join(repoDir, 'src', 'everything');
  await fs.mkdir(subDir, { recursive: true });
  plainDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'flujo-git-plain-'));
});

afterAll(async () => {
  await fs.rm(repoDir, { recursive: true, force: true });
  await fs.rm(plainDir, { recursive: true, force: true });
});

const LOCAL_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REMOTE_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/**
 * Configure the git mock as a clean repo on `main`, remote ahead or not.
 * `--show-toplevel` resolves to repoDir for anything inside it and fails for
 * plainDir, mirroring real git's upward repository discovery.
 */
function setupRepo({ remoteSha = LOCAL_SHA, branch = 'main', dirty = '' } = {}) {
  mockGit.remote.mockResolvedValue('https://github.com/foo/bar.git\n');
  mockGit.revparse.mockImplementation(async (args: string[]) => {
    if (args.includes('--show-toplevel')) {
      if (mockGit.__baseDir.startsWith(plainDir)) {
        throw new Error('fatal: not a git repository');
      }
      return `${repoDir}\n`;
    }
    if (args.includes('--abbrev-ref')) return `${branch}\n`;
    return `${LOCAL_SHA}\n`;
  });
  mockGit.listRemote.mockResolvedValue(`${remoteSha}\trefs/heads/${branch}\n`);
  mockGit.raw.mockImplementation(async (args: string[]) =>
    args[0] === 'status' ? dirty : ''
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/git action=checkUpdates', () => {
  it('reports an available update when the remote branch tip differs from local HEAD', async () => {
    setupRepo({ remoteSha: REMOTE_SHA });

    const res = await POST(req({ action: 'checkUpdates', savePath: repoDir }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toMatchObject({
      success: true,
      isGitRepo: true,
      repoRoot: repoDir,
      remoteUrl: 'https://github.com/foo/bar.git',
      branch: 'main',
      localSha: LOCAL_SHA,
      remoteSha: REMOTE_SHA,
      updateAvailable: true,
      hasLocalChanges: false,
      dirtyFiles: [],
    });
    expect(mockGit.listRemote).toHaveBeenCalledWith(['origin', 'refs/heads/main']);
  });

  it('resolves the enclosing repository when rootPath is a monorepo subdirectory', async () => {
    setupRepo({ remoteSha: REMOTE_SHA });

    const body = await (await POST(req({ action: 'checkUpdates', savePath: subDir }))).json();
    expect(body).toMatchObject({
      isGitRepo: true,
      repoRoot: repoDir,
      updateAvailable: true,
    });
  });

  it('refuses to treat FLUJO\'s own repository as an updatable clone', async () => {
    setupRepo({ remoteSha: REMOTE_SHA });
    // A rootPath inside the app repo resolves upward to process.cwd().
    mockGit.revparse.mockImplementation(async (args: string[]) => {
      if (args.includes('--show-toplevel')) return `${process.cwd()}\n`;
      return `${LOCAL_SHA}\n`;
    });

    const body = await (await POST(req({ action: 'checkUpdates', savePath: repoDir }))).json();
    expect(body.isGitRepo).toBe(false);
    expect(body.updateAvailable).toBe(false);
    expect(body.error).toContain('FLUJO');
  });

  it('reports no update when local HEAD matches the remote tip', async () => {
    setupRepo();

    const body = await (await POST(req({ action: 'checkUpdates', savePath: repoDir }))).json();
    expect(body.updateAvailable).toBe(false);
  });

  it('lists modified tracked files so the UI can warn before the hard reset', async () => {
    setupRepo({ remoteSha: REMOTE_SHA, dirty: ' M src/index.ts\nM  package.json\n' });

    const body = await (await POST(req({ action: 'checkUpdates', savePath: repoDir }))).json();
    expect(body.hasLocalChanges).toBe(true);
    expect(body.dirtyFiles).toEqual(['src/index.ts', 'package.json']);
    // Untracked files must be excluded from the check entirely.
    expect(mockGit.raw).toHaveBeenCalledWith(['status', '--porcelain', '--untracked-files=no']);
  });

  it('compares against the remote HEAD when the clone is in detached-HEAD state', async () => {
    setupRepo({ remoteSha: REMOTE_SHA, branch: 'HEAD' });
    mockGit.listRemote.mockResolvedValue(`${REMOTE_SHA}\tHEAD\n`);

    const body = await (await POST(req({ action: 'checkUpdates', savePath: repoDir }))).json();
    expect(mockGit.listRemote).toHaveBeenCalledWith(['origin', 'HEAD']);
    expect(body.updateAvailable).toBe(true);
  });

  it('returns isGitRepo=false (not an error) for a directory outside any repository', async () => {
    mockGit.revparse.mockRejectedValue(new Error('fatal: not a git repository'));

    const res = await POST(req({ action: 'checkUpdates', savePath: plainDir }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, isGitRepo: false, updateAvailable: false });
  });

  it('degrades to an error field when git fails (e.g. remote unreachable)', async () => {
    setupRepo();
    mockGit.listRemote.mockRejectedValue(new Error('could not resolve host'));

    const res = await POST(req({ action: 'checkUpdates', savePath: repoDir }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isGitRepo).toBe(true);
    expect(body.updateAvailable).toBe(false);
    expect(body.error).toContain('could not resolve host');
  });

  it('rejects a missing savePath with 400', async () => {
    const res = await POST(req({ action: 'checkUpdates' }));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/git action=checkUpdatesBatch', () => {
  it('returns a per-path map and a broken repo does not fail the batch', async () => {
    setupRepo({ remoteSha: REMOTE_SHA });

    // plainDir is not a git repo; repoDir is fine.
    const res = await POST(
      req({ action: 'checkUpdatesBatch', paths: [repoDir, plainDir] })
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.results[repoDir].updateAvailable).toBe(true);
    expect(body.results[plainDir]).toMatchObject({ isGitRepo: false, updateAvailable: false });
  });

  it('rejects a missing/empty paths array with 400', async () => {
    expect((await POST(req({ action: 'checkUpdatesBatch' }))).status).toBe(400);
    expect((await POST(req({ action: 'checkUpdatesBatch', paths: [] }))).status).toBe(400);
  });
});

describe('POST /api/git action=pullUpdates', () => {
  it('shallow-fetches the current branch and hard-resets onto FETCH_HEAD', async () => {
    // revparse: repo root, then oldSha (HEAD), branch (--abbrev-ref), newSha (HEAD after reset)
    let headCalls = 0;
    mockGit.revparse.mockImplementation(async (args: string[]) => {
      if (args.includes('--show-toplevel')) return `${repoDir}\n`;
      if (args.includes('--abbrev-ref')) return 'main\n';
      headCalls++;
      return headCalls === 1 ? `${LOCAL_SHA}\n` : `${REMOTE_SHA}\n`;
    });
    mockGit.raw.mockResolvedValue('');

    const res = await POST(req({ action: 'pullUpdates', savePath: repoDir }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toMatchObject({
      success: true,
      oldSha: LOCAL_SHA,
      newSha: REMOTE_SHA,
      updated: true,
    });
    expect(mockGit.raw).toHaveBeenCalledWith(['fetch', '--depth', '1', 'origin', 'main']);
    expect(mockGit.raw).toHaveBeenCalledWith(['reset', '--hard', 'FETCH_HEAD']);
  });

  it('fetches the remote HEAD when detached', async () => {
    mockGit.revparse.mockImplementation(async (args: string[]) => {
      if (args.includes('--show-toplevel')) return `${repoDir}\n`;
      return args.includes('--abbrev-ref') ? 'HEAD\n' : `${LOCAL_SHA}\n`;
    });
    mockGit.raw.mockResolvedValue('');

    const body = await (await POST(req({ action: 'pullUpdates', savePath: repoDir }))).json();
    expect(mockGit.raw).toHaveBeenCalledWith(['fetch', '--depth', '1', 'origin', 'HEAD']);
    expect(body.updated).toBe(false); // same sha before and after
  });

  it('rejects a non-git directory with 400', async () => {
    mockGit.revparse.mockRejectedValue(new Error('fatal: not a git repository'));

    const res = await POST(req({ action: 'pullUpdates', savePath: plainDir }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toHaveProperty('error', 'Not a git repository');
  });

  it('refuses to pull into FLUJO\'s own repository with 400', async () => {
    mockGit.revparse.mockImplementation(async (args: string[]) => {
      if (args.includes('--show-toplevel')) return `${process.cwd()}\n`;
      return `${LOCAL_SHA}\n`;
    });

    const res = await POST(req({ action: 'pullUpdates', savePath: repoDir }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('FLUJO');
    expect(mockGit.raw).not.toHaveBeenCalled();
  });

  it('returns 500 with the git error message when the fetch fails', async () => {
    mockGit.revparse.mockImplementation(async (args: string[]) => {
      if (args.includes('--show-toplevel')) return `${repoDir}\n`;
      return `${LOCAL_SHA}\n`;
    });
    mockGit.raw.mockRejectedValue(new Error('network is unreachable'));

    const res = await POST(req({ action: 'pullUpdates', savePath: repoDir }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('network is unreachable');
  });
});
