/**
 * Regression tests for the localhost / DNS-rebinding origin guard (#131).
 *
 * Several internal `/api/*` routes execute shell commands, read/delete arbitrary
 * files, or return secrets. They were previously gated ONLY by the encryption
 * lock (`assertUnlocked`), so a cross-origin *simple* POST from any page in the
 * user's browser could reach them (drive-by RCE on localhost). `assertLocalRequest`
 * now guards them.
 *
 * These tests fail on `main` (no guard -> the request would proceed / a
 * cross-origin POST reaches the exec/spawn/fs sinks) and pass after the fix:
 *   - a cross-origin request (or the DNS-rebinding vector) gets 403 and NEVER
 *     reaches command execution or file access,
 *   - a localhost same-origin request proceeds past the guard,
 *   - a native request with no Origin proceeds past the guard.
 */

// --- Mock every dangerous sink of /api/git so nothing is ever executed. -------
const execSyncMock = jest.fn();
const spawnMock = jest.fn();
jest.mock('child_process', () => ({
  execSync: (...args: unknown[]) => execSyncMock(...args),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const fsReadFileMock = jest.fn(async () => 'file-contents');
const fsRmMock = jest.fn(async () => undefined);
jest.mock('fs/promises', () => ({
  __esModule: true,
  default: {
    access: jest.fn(async () => undefined),
    mkdir: jest.fn(async () => undefined),
    readFile: (...args: unknown[]) => fsReadFileMock(...args),
    rm: (...args: unknown[]) => fsRmMock(...args),
    readdir: jest.fn(async () => []),
    stat: jest.fn(async () => ({})),
    writeFile: jest.fn(async () => undefined),
  },
}));

// simple-git: any instantiation would mean we got past the guard on a git action.
const simpleGitFactory = jest.fn(() => ({
  remote: jest.fn(),
  revparse: jest.fn(),
  listRemote: jest.fn(),
  raw: jest.fn(),
  clone: jest.fn(),
  fetch: jest.fn(),
}));
jest.mock('simple-git', () => ({
  __esModule: true,
  default: (...args: unknown[]) => simpleGitFactory(...args),
}));

// Force the encryption gate open so only the origin guard is under test.
jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: jest.fn(async () => null),
}));

jest.mock('uuid', () => ({ v4: () => 'test-request-id' }));
jest.mock('@/utils/mcp', () => ({ processPathLikeArgument: (p: string) => p }));

import type { NextRequest } from 'next/server';
import { isLocalRequest, assertLocalRequest } from '@/utils/http/localRequest';
import { POST as gitPost } from '@/app/api/git/route';
import { GET as cwdGet } from '@/app/api/cwd/route';

beforeEach(() => {
  jest.clearAllMocks();
});

/** Build a request with the given host/origin headers (and optional JSON body). */
const makeRequest = (
  url: string,
  { host, origin, body }: { host?: string; origin?: string; body?: unknown } = {}
): NextRequest => {
  const headers: Record<string, string> = {};
  if (host) headers.host = host;
  if (origin) headers.origin = origin;
  const init: RequestInit = { headers };
  if (body !== undefined) {
    init.method = 'POST';
    init.body = JSON.stringify(body);
    headers['content-type'] = 'application/json';
  }
  return new Request(url, init) as unknown as NextRequest;
};

describe('isLocalRequest / assertLocalRequest unit', () => {
  it('accepts localhost-family Hosts with no Origin (native client)', () => {
    expect(isLocalRequest('localhost:4200', null)).toBe(true);
    expect(isLocalRequest('127.0.0.1:4200', null)).toBe(true);
    expect(isLocalRequest('[::1]:4200', null)).toBe(true);
  });

  it('accepts a localhost Host with a matching localhost Origin', () => {
    expect(isLocalRequest('localhost:4200', 'http://localhost:4200')).toBe(true);
  });

  it('rejects a non-localhost Host', () => {
    expect(isLocalRequest('evil.com', null)).toBe(false);
    expect(isLocalRequest(null, null)).toBe(false);
  });

  it('rejects the DNS-rebinding vector: localhost Host but a non-local Origin', () => {
    expect(isLocalRequest('localhost:4200', 'http://evil.com')).toBe(false);
    expect(isLocalRequest('localhost:4200', 'not-a-url')).toBe(false);
  });

  it('assertLocalRequest returns 403 for non-local, null for local', () => {
    const blocked = assertLocalRequest(makeRequest('http://x/api/git', { host: 'evil.com' }));
    expect(blocked).not.toBeNull();
    expect(blocked!.status).toBe(403);

    expect(assertLocalRequest(makeRequest('http://x/api/git', { host: 'localhost:4200' }))).toBeNull();
  });
});

describe('POST /api/git origin guard', () => {
  const gitBody = { action: 'readFile', savePath: '/etc/passwd' };

  it('blocks a cross-origin POST with 403 and never touches exec/spawn/fs/git', async () => {
    const res = await gitPost(
      makeRequest('http://localhost:4200/api/git', {
        host: 'localhost:4200',
        origin: 'http://evil.com',
        body: gitBody,
      })
    );
    expect(res.status).toBe(403);
    expect(execSyncMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(fsReadFileMock).not.toHaveBeenCalled();
    expect(fsRmMock).not.toHaveBeenCalled();
    expect(simpleGitFactory).not.toHaveBeenCalled();
  });

  it('blocks a non-local Host with 403 and never touches the sinks', async () => {
    const res = await gitPost(
      makeRequest('http://evil.com/api/git', { host: 'evil.com', body: gitBody })
    );
    expect(res.status).toBe(403);
    expect(execSyncMock).not.toHaveBeenCalled();
    expect(fsReadFileMock).not.toHaveBeenCalled();
  });

  it('lets a localhost same-origin request past the guard (not 403)', async () => {
    // Missing/invalid params make the real handler return 400 — that it is NOT
    // 403 proves the guard allowed it through.
    const res = await gitPost(
      makeRequest('http://localhost:4200/api/git', {
        host: 'localhost:4200',
        origin: 'http://localhost:4200',
        body: { action: 'checkUpdates' }, // no savePath -> 400
      })
    );
    expect(res.status).not.toBe(403);
  });

  it('lets a native request with no Origin past the guard (not 403)', async () => {
    const res = await gitPost(
      makeRequest('http://localhost:4200/api/git', {
        host: 'localhost:4200',
        body: { action: 'checkUpdates' },
      })
    );
    expect(res.status).not.toBe(403);
  });
});

describe('GET /api/cwd origin guard', () => {
  it('blocks a cross-origin request with 403', async () => {
    const res = await cwdGet(
      makeRequest('http://localhost:4200/api/cwd', {
        host: 'localhost:4200',
        origin: 'http://evil.com',
      })
    );
    expect(res.status).toBe(403);
  });

  it('allows a localhost request (200)', async () => {
    const res = await cwdGet(
      makeRequest('http://localhost:4200/api/cwd', { host: 'localhost:4200' })
    );
    expect(res.status).toBe(200);
  });
});
