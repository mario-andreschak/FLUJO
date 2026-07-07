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
  };
  return {
    __esModule: true,
    default: jest.fn(() => git),
    __git: git,
  };
});

import { GET, POST } from '@/app/api/update/route';

const { __git: mockGit, default: simpleGitFactory } = jest.requireMock('simple-git') as any;

const postReq = (body: unknown) => ({ json: async () => body }) as any;

const ENV_KEYS = ['FLUJO_CONTAINER', 'FLUJO_NPM'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
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
    const res = await GET();
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
    const res = await GET();
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

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ isGitRepo: true, updateMode: 'git', updateAvailable: false });
  });

  it("reports updateMode 'git' with updateAvailable when behind", async () => {
    mockGit.checkIsRepo.mockResolvedValue(true);
    mockGit.fetch.mockResolvedValue(undefined);
    mockGit.status.mockResolvedValue({ behind: 3, current: 'main', tracking: 'origin/main' });

    const res = await GET();
    const body = await res.json();

    expect(body).toMatchObject({ updateMode: 'git', updateAvailable: true, behindBy: 3, branch: 'main' });
  });

  it("reports updateMode 'none' when git mode but not a git repo", async () => {
    mockGit.checkIsRepo.mockResolvedValue(false);

    const res = await GET();
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
});
