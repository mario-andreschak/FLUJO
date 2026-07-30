/**
 * Regression tests for /api/update install-mode awareness (issues #57, #59).
 *
 * FLUJO's in-app updater does `git pull` + rebuild in the install folder. That is
 * impossible (and unsafe) for the Docker image and the npm package, which are
 * effectively read-only and updated by pulling a new image / reinstalling. The
 * route must therefore:
 *   - GET: report `updateMode` ('git' | 'container' | 'npm' | 'none') and, for a
 *     packaged install, return updateAvailable=false + instructions instead of
 *     touching git.
 *   - POST: refuse with 501 for a packaged install BEFORE any git interaction.
 *
 * Install mode is driven by env vars (FLUJO_CONTAINER / FLUJO_NPM); simple-git is
 * mocked so the git-mode branches never hit a real repository.
 */

jest.mock('simple-git', () => {
  const git: any = {
    checkIsRepo: jest.fn(),
    fetch: jest.fn(),
    status: jest.fn(),
    pull: jest.fn(),
    raw: jest.fn(),
  };
  return {
    __esModule: true,
    default: jest.fn(() => git),
    __git: git,
  };
});

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execSync: jest.fn(),
  spawn: jest.fn(() => ({
    on: jest.fn(),
    unref: jest.fn(),
  })),
}));

import { GET, POST } from '@/app/api/update/route';
import { makeLocalRequest } from '../utils/localRequest';

const { __git: mockGit, default: simpleGitFactory } = jest.requireMock('simple-git') as any;
const { execSync: mockExecSync } = jest.requireMock('child_process') as {
  execSync: jest.Mock;
};

const postReq = (body: unknown) => makeLocalRequest({ body });
// GET is guarded by the fail-closed origin guard (#142); it reads only Host/Origin.
const getReq = () => makeLocalRequest();

const ENV_KEYS = ['FLUJO_CONTAINER', 'FLUJO_NPM'] as const;
const saved: Record<string, string | undefined> = {};
const originalPlatform = process.platform;

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

describe('GET /api/update', () => {
  it("reports updateMode 'container' without touching git when FLUJO_CONTAINER is set", async () => {
    process.env.FLUJO_CONTAINER = '1';
    const res = await GET(getReq());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      isGitRepo: false,
      updateMode: 'container',
      updateAvailable: false,
    });
    expect(typeof body.message).toBe('string');
    expect(simpleGitFactory).not.toHaveBeenCalled();
  });

  it("reports updateMode 'npm' without touching git when FLUJO_NPM is set", async () => {
    process.env.FLUJO_NPM = '1';
    const res = await GET(getReq());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.updateMode).toBe('npm');
    expect(body.updateAvailable).toBe(false);
    expect(simpleGitFactory).not.toHaveBeenCalled();
  });

  it("reports updateMode 'git' and no update when up to date", async () => {
    mockGit.checkIsRepo.mockResolvedValue(true);
    mockGit.fetch.mockResolvedValue(undefined);
    mockGit.status.mockResolvedValue({ behind: 0, current: 'main', tracking: 'origin/main' });

    const res = await GET(getReq());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ isGitRepo: true, updateMode: 'git', updateAvailable: false });
  });

  it("reports updateMode 'git' with updateAvailable when behind", async () => {
    mockGit.checkIsRepo.mockResolvedValue(true);
    mockGit.fetch.mockResolvedValue(undefined);
    mockGit.status.mockResolvedValue({ behind: 3, current: 'main', tracking: 'origin/main' });

    const res = await GET(getReq());
    const body = await res.json();

    expect(body).toMatchObject({ updateMode: 'git', updateAvailable: true, behindBy: 3, branch: 'main' });
  });

  it("reports updateMode 'none' when git mode but not a git repo", async () => {
    mockGit.checkIsRepo.mockResolvedValue(false);

    const res = await GET(getReq());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ isGitRepo: false, updateMode: 'none', updateAvailable: false });
  });
});

describe('POST /api/update', () => {
  it('refuses with 501 in container mode before touching git', async () => {
    process.env.FLUJO_CONTAINER = '1';
    const res = await POST(postReq({ action: 'apply' }));
    const body = await res.json();

    expect(res.status).toBe(501);
    expect(body).toMatchObject({ success: false, updateMode: 'container' });
    expect(simpleGitFactory).not.toHaveBeenCalled();
    expect(mockGit.pull).not.toHaveBeenCalled();
  });

  it('refuses with 501 in npm mode before touching git', async () => {
    process.env.FLUJO_NPM = '1';
    const res = await POST(postReq({ action: 'apply' }));
    const body = await res.json();

    expect(res.status).toBe(501);
    expect(body.updateMode).toBe('npm');
    expect(simpleGitFactory).not.toHaveBeenCalled();
  });

  it('still rejects an unknown action before the install-mode check', async () => {
    const res = await POST(postReq({ action: 'bogus' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 in git mode when the install is not a git repo', async () => {
    mockGit.checkIsRepo.mockResolvedValue(false);
    const res = await POST(postReq({ action: 'apply' }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(mockGit.pull).not.toHaveBeenCalled();
  });

  it('restores installer-generated lockfile drift and installs with npm ci', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    mockGit.checkIsRepo.mockResolvedValue(true);
    mockGit.status.mockResolvedValue({
      files: [{ path: 'package-lock.json', index: ' ', working_dir: 'M' }],
    });
    mockGit.raw.mockResolvedValue('');
    mockGit.pull.mockResolvedValue({});

    const res = await POST(postReq({ action: 'apply' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockGit.raw).toHaveBeenCalledWith([
      'restore', '--source=HEAD', '--staged', '--worktree', '--', 'package-lock.json',
    ]);
    expect(mockGit.pull).toHaveBeenCalled();
    expect(mockExecSync).toHaveBeenNthCalledWith(
      1,
      'npm ci --include=dev',
      expect.objectContaining({ cwd: process.cwd(), encoding: 'utf8' }),
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      'npm run build',
      expect.objectContaining({ cwd: process.cwd(), encoding: 'utf8' }),
    );
  });

  it('does not discard a lockfile when package.json also has dependency edits', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    mockGit.checkIsRepo.mockResolvedValue(true);
    mockGit.status.mockResolvedValue({
      files: [
        { path: 'package.json', index: ' ', working_dir: 'M' },
        { path: 'package-lock.json', index: ' ', working_dir: 'M' },
      ],
    });
    mockGit.pull.mockResolvedValue({});

    const res = await POST(postReq({ action: 'apply' }));

    expect(res.status).toBe(200);
    expect(mockGit.raw).not.toHaveBeenCalled();
    expect(mockGit.pull).toHaveBeenCalled();
  });
});
