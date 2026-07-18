/**
 * Regression tests for the repository-URL / branch validation of the /api/git
 * clone action (security hardening for issue 58).
 *
 * The clone action feeds a user-supplied URL into simple-git, which is exactly
 * the attack surface of the simple-git advisories GHSA-hffm-xvc3-vprc,
 * GHSA-r275-fr43-pm7q and GHSA-jcxm-m3jx-f287 (option/URL injection -> RCE).
 * Contract points covered here:
 *  - only http(s)://, git://, ssh:// and scp-like user@host:path remotes are
 *    accepted; file://, ext::, option-shaped ("-...") and malformed values are
 *    rejected with 400 BEFORE any git process is involved
 *  - a branch value that could be parsed as an option ("--upload-pack=...") is
 *    rejected with 400
 *  - a valid https URL still reaches git.clone (the happy path keeps working)
 */

jest.mock('simple-git', () => {
  const git: any = {
    clone: jest.fn(),
    revparse: jest.fn(),
    remote: jest.fn(),
    listRemote: jest.fn(),
    raw: jest.fn(),
  };
  return {
    __esModule: true,
    default: jest.fn(() => git),
    __git: git,
  };
});

jest.mock('uuid', () => ({ v4: () => 'test-request-id' }));
jest.mock('@/utils/mcp', () => ({ processPathLikeArgument: (p: string) => p }));

import fs from 'fs/promises';
import os from 'os';
import nodePath from 'path';
import { POST } from '@/app/api/git/route';
import { isSafeRepoUrl, isSafeBranchName } from '@/utils/git/validation';

const { __git: mockGit } = jest.requireMock('simple-git') as any;

// The route enforces the localhost origin guard (#131), which reads
// request.headers.get('host'|'origin'); supply a localhost Host so these
// git-action tests exercise the real handler, not the 403 short-circuit.
const req = (body: unknown) =>
  ({ json: async () => body, headers: new Headers({ host: 'localhost:4200' }) }) as any;

let saveDir: string;

beforeAll(async () => {
  saveDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'flujo-git-clone-'));
});

afterAll(async () => {
  await fs.rm(saveDir, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('isSafeRepoUrl', () => {
  it('accepts standard git remote URLs', () => {
    expect(isSafeRepoUrl('https://github.com/foo/bar.git')).toBe(true);
    expect(isSafeRepoUrl('http://internal.example/repo.git')).toBe(true);
    expect(isSafeRepoUrl('git://github.com/foo/bar.git')).toBe(true);
    expect(isSafeRepoUrl('ssh://git@github.com/foo/bar.git')).toBe(true);
    expect(isSafeRepoUrl('git@github.com:foo/bar.git')).toBe(true);
  });

  it('rejects option-shaped, local and exotic-transport values', () => {
    expect(isSafeRepoUrl('--upload-pack=touch /tmp/pwned')).toBe(false);
    expect(isSafeRepoUrl('-o ProxyCommand=calc')).toBe(false);
    expect(isSafeRepoUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeRepoUrl('ext::sh -c calc')).toBe(false);
    expect(isSafeRepoUrl('https://host/a b')).toBe(false); // embedded whitespace
    expect(isSafeRepoUrl('not a url')).toBe(false);
    expect(isSafeRepoUrl('')).toBe(false);
    expect(isSafeRepoUrl(undefined)).toBe(false);
    expect(isSafeRepoUrl(42)).toBe(false);
  });
});

describe('isSafeBranchName', () => {
  it('accepts normal ref names', () => {
    expect(isSafeBranchName('main')).toBe(true);
    expect(isSafeBranchName('feature/foo-1.2')).toBe(true);
    expect(isSafeBranchName('v1.0.0')).toBe(true);
  });

  it('rejects option-shaped or malformed values', () => {
    expect(isSafeBranchName('--upload-pack=calc')).toBe(false);
    expect(isSafeBranchName('-b')).toBe(false);
    expect(isSafeBranchName('name with space')).toBe(false);
    expect(isSafeBranchName('')).toBe(false);
    expect(isSafeBranchName(undefined)).toBe(false);
  });
});

describe('POST /api/git action=clone URL validation', () => {
  it.each([
    ['file:// transport', 'file:///etc/passwd'],
    ['ext:: transport', 'ext::sh -c calc'],
    ['option injection', '--upload-pack=touch /tmp/pwned'],
    ['garbage', 'not a url at all'],
  ])('rejects %s with 400 and never invokes git', async (_label, repoUrl) => {
    const res = await POST(
      req({ action: 'clone', repoUrl, savePath: nodePath.join(saveDir, 'x') })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid repository URL/);
    expect(mockGit.clone).not.toHaveBeenCalled();
  });

  it('rejects an option-shaped branch with 400 and never invokes git', async () => {
    const res = await POST(
      req({
        action: 'clone',
        repoUrl: 'https://github.com/foo/bar.git',
        branch: '--upload-pack=calc',
        savePath: nodePath.join(saveDir, 'x'),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid branch name/);
    expect(mockGit.clone).not.toHaveBeenCalled();
  });

  it('still clones a valid https URL (happy path)', async () => {
    mockGit.clone.mockResolvedValue(undefined);
    const target = nodePath.join(saveDir, 'fresh-clone');

    const res = await POST(
      req({ action: 'clone', repoUrl: 'https://github.com/foo/bar.git', savePath: target })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(mockGit.clone).toHaveBeenCalledWith(
      'https://github.com/foo/bar.git',
      target,
      expect.objectContaining({ '--depth': 1 })
    );
  });
});
