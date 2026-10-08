/** Update preflight must finish before any fetch, code mutation, or server stop. */
jest.mock('simple-git', () => {
  const git = {
    checkIsRepo: jest.fn(), fetch: jest.fn(), status: jest.fn(), pull: jest.fn(), raw: jest.fn(),
  };
  return { __esModule: true, default: jest.fn(() => git), __git: git };
});

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execSync: jest.fn(),
  spawn: jest.fn(() => ({ on: jest.fn(), unref: jest.fn() })),
}));

import { GET, POST } from '@/app/api/update/route';
import { makeLocalRequest } from '../utils/localRequest';

const { __git: mockGit, default: simpleGitFactory } = jest.requireMock('simple-git') as {
  __git: Record<string, jest.Mock>; default: jest.Mock;
};
const { execSync: mockExecSync, spawn: mockSpawn } = jest.requireMock('child_process') as {
  execSync: jest.Mock; spawn: jest.Mock;
};
const postReq = () => makeLocalRequest({ body: { action: 'apply' } });
const originalPlatform = process.platform;
const savedEnv: Record<string, string | undefined> = {};
const currentRevision = 'a'.repeat(40);
const upstreamRevision = 'b'.repeat(40);
const cleanStatus = (overrides: Record<string, unknown> = {}) => ({
  files: [], current: 'main', tracking: 'origin/main', ahead: 0, behind: 0, detached: false, ...overrides,
});

function gitReply(args: string[]) {
  switch (args.join(' ')) {
    case 'rev-parse --show-toplevel': return process.cwd();
    case 'remote get-url origin': return 'https://github.com/mario-andreschak/FLUJO.git';
    case 'rev-parse HEAD': return currentRevision;
    case 'symbolic-ref --quiet --short HEAD': return 'main';
    case 'describe --tags --exact-match HEAD': return 'v3.45.2';
    case 'merge-base --is-ancestor HEAD refs/remotes/origin/main': return '';
    case 'rev-parse refs/remotes/origin/main': return upstreamRevision;
    case `merge --ff-only ${upstreamRevision}`: return '';
    default: throw new Error(`Unexpected Git command: ${args.join(' ')}`);
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of ['FLUJO_CONTAINER', 'FLUJO_NPM']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  mockGit.checkIsRepo.mockResolvedValue(true);
  mockGit.status.mockResolvedValue(cleanStatus());
  mockGit.fetch.mockResolvedValue(undefined);
  mockGit.raw.mockImplementation(async (args: string[]) => gitReply(args));
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  for (const key of ['FLUJO_CONTAINER', 'FLUJO_NPM']) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function expectNoUpdateEffects() {
  expect(mockGit.fetch).not.toHaveBeenCalled();
  expect(mockGit.pull).not.toHaveBeenCalled();
  expect(mockGit.raw.mock.calls.some(call => ['merge', 'reset', 'restore', 'checkout'].includes((call[0] as string[])[0]))).toBe(false);
  expect(mockExecSync).not.toHaveBeenCalled();
  expect(mockSpawn).not.toHaveBeenCalled();
}

describe('packaged updates', () => {
  it.each([['FLUJO_CONTAINER', 'container'], ['FLUJO_NPM', 'npm']])('keeps %s out of Git update paths', async (env, mode) => {
    process.env[env] = '1';
    const check = await GET(makeLocalRequest());
    expect(await check.json()).toMatchObject({ success: true, isGitRepo: false, updateMode: mode, updateAvailable: false });
    const apply = await POST(postReq());
    expect(apply.status).toBe(501);
    expect(simpleGitFactory).not.toHaveBeenCalled();
    expectNoUpdateEffects();
  });
});

describe('safe branch checks', () => {
  it('inspects a clean official checkout before fetching and reports its source', async () => {
    mockGit.status.mockResolvedValue(cleanStatus({ behind: 3 }));
    const response = await GET(makeLocalRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ updateMode: 'git', canApply: true, updateAvailable: true, behindBy: 3, branch: 'main', sourceRef: 'main', revision: currentRevision });
    expect(mockGit.fetch).toHaveBeenCalledWith('origin', 'main');
    expect(mockGit.status.mock.invocationCallOrder[0]).toBeLessThan(mockGit.fetch.mock.invocationCallOrder[0]);
    expect(mockGit.status).toHaveBeenCalledTimes(2);
  });

  it('does not rebuild or stop a server when already current', async () => {
    const response = await POST(postReq());
    expect(await response.json()).toMatchObject({ success: true, updateAvailable: false, restarting: false });
    expect(mockExecSync).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('uses only a fast-forward to the verified revision on non-Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    mockGit.status.mockResolvedValue(cleanStatus({ behind: 1 }));
    const response = await POST(postReq());
    expect(response.status).toBe(200);
    expect(mockGit.raw).toHaveBeenCalledWith(['merge', '--ff-only', upstreamRevision]);
    expect(mockGit.pull).not.toHaveBeenCalled();
    expect(mockExecSync).toHaveBeenNthCalledWith(1, 'npm ci --include=dev', expect.objectContaining({ cwd: process.cwd() }));
    expect(mockExecSync).toHaveBeenNthCalledWith(2, 'npm run build', expect.anything());
  });

  it('only launches the Windows updater after both preflights pass', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mockGit.status.mockResolvedValue(cleanStatus({ behind: 1 }));
    const response = await POST(postReq());
    expect(await response.json()).toMatchObject({ success: true, restarting: true });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn.mock.invocationCallOrder[0]).toBeGreaterThan(mockGit.status.mock.invocationCallOrder[1]);
  });
});

describe('unsafe checkouts', () => {
  const blockedStates = [
    ['lockfile edits', { files: [{ path: 'package-lock.json', index: ' ', working_dir: 'M' }] }, 'local-changes'],
    ['untracked work', { files: [{ path: 'notes.txt', index: '?', working_dir: '?' }] }, 'local-changes'],
    ['local commits', { ahead: 1 }, 'local-commits'],
    ['diverged branch', { ahead: 1, behind: 2 }, 'local-commits'],
    ['different upstream', { tracking: 'fork/main' }, 'unexpected-upstream'],
  ] as const;

  it.each(blockedStates)('refuses %s on GET and POST before any fetch or update effect', async (_label, status, blockedReason) => {
    mockGit.status.mockResolvedValue(cleanStatus(status));
    const check = await GET(makeLocalRequest());
    expect(await check.json()).toMatchObject({ updateMode: 'blocked', blockedReason, updateAvailable: false });
    const apply = await POST(postReq());
    expect(apply.status).toBe(409);
    expect(await apply.json()).toMatchObject({ success: false, blockedReason });
    expectNoUpdateEffects();
  });

  it('reports detached stable releases as pinned and refuses before stopping Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mockGit.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') throw new Error('detached HEAD');
      return gitReply(args);
    });
    const response = await GET(makeLocalRequest());
    const data = await response.json();
    expect(data).toMatchObject({ updateMode: 'pinned', sourceRef: 'v3.45.2', revision: currentRevision, canApply: false });
    expect(data.message).toMatch(/newer versioned FLUJO installer/);
    expect((await POST(postReq())).status).toBe(409);
    expectNoUpdateEffects();
  });

  it.each(['unrelated-origin', 'unrelated-checkout', 'not-fast-forward'])('refuses %s without mutating the checkout', async reason => {
    mockGit.raw.mockImplementation(async (args: string[]) => {
      if (reason === 'unrelated-origin' && args[0] === 'remote') return 'https://github.com/someone/another-project.git';
      if (reason === 'unrelated-checkout' && args[1] === '--show-toplevel') return `${process.cwd()}/different-root`;
      if (reason === 'not-fast-forward' && args[0] === 'merge-base') throw new Error('not ancestor');
      return gitReply(args);
    });
    const response = await POST(postReq());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ blockedReason: reason });
    expectNoUpdateEffects();
  });

  it('rechecks fetched history and refuses divergence before spawning or merging', async () => {
    mockGit.fetch.mockImplementation(async () => { mockGit.status.mockResolvedValue(cleanStatus({ ahead: 1, behind: 2 })); });
    const response = await POST(postReq());
    expect(response.status).toBe(409);
    expect(mockGit.raw.mock.calls.some(call => (call[0] as string[])[0] === 'merge')).toBe(false);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('reports a non-Git install without trying to update it', async () => {
    mockGit.checkIsRepo.mockResolvedValue(false);
    expect(await (await GET(makeLocalRequest())).json()).toMatchObject({ updateMode: 'none', isGitRepo: false });
    expect((await POST(postReq())).status).toBe(400);
    expectNoUpdateEffects();
  });

  it('rejects unknown actions', async () => {
    expect((await POST(makeLocalRequest({ body: { action: 'bogus' } }))).status).toBe(400);
    expect(simpleGitFactory).not.toHaveBeenCalled();
  });
});
