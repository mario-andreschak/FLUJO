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
    readFile: (...args: unknown[]) => fsReadFileMock(...(args as [])),
    rm: (...args: unknown[]) => fsRmMock(...(args as [])),
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
  default: (...args: unknown[]) => simpleGitFactory(...(args as [])),
}));

// Force the encryption gate open so only the origin guard is under test.
jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: jest.fn(async () => null),
}));

jest.mock('uuid', () => ({ v4: () => 'test-request-id' }));
jest.mock('@/utils/mcp', () => ({ processPathLikeArgument: (p: string) => p }));

// The update route reads the install mode from @/utils/paths; force 'git' so
// POST/GET /api/update reach PAST the mode check to the git/exec/spawn sinks that
// the origin guard must block (otherwise a non-git early-return would mask it).
// getDataDir/getAppDir are kept because the git & cwd routes resolve module-level
// paths from them at import time.
jest.mock('@/utils/paths', () => ({
  getInstallMode: jest.fn(() => 'git'),
  getDataDir: jest.fn(() => '/tmp/flujo-data'),
  getAppDir: jest.fn(() => '/tmp/flujo-app'),
}));

// --- Mocks for the routes newly guarded in #141. -----------------------------
// The MCP service is where the real stdio child processes are spawned and where
// server configs are persisted; mocking it means a request that gets PAST the
// guard is observable (the mock is called) without any real spawn/IO.
jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    testConnection: jest.fn(async () => ({ success: true })),
    updateServerConfig: jest.fn(async () => ({ name: 'x' })),
    deleteServerConfig: jest.fn(async () => ({ success: true })),
    loadServerConfigs: jest.fn(async () => []),
  },
}));

// /api/env sinks: loadItem/saveItem (storage) and decrypt/encrypt (secrets).
const loadItemMock = jest.fn(async () => ({}));
const saveItemMock = jest.fn(async () => undefined);
jest.mock('@/utils/storage/backend', () => ({
  loadItem: (...args: unknown[]) => loadItemMock(...(args as [])),
  saveItem: (...args: unknown[]) => saveItemMock(...(args as [])),
}));
const decryptWithPasswordMock = jest.fn(async () => 'decrypted-secret');
const encryptWithPasswordMock = jest.fn(async () => 'encrypted');
jest.mock('@/utils/encryption/secure', () => ({
  encryptWithPassword: (...args: unknown[]) => encryptWithPasswordMock(...(args as [])),
  decryptWithPassword: (...args: unknown[]) => decryptWithPasswordMock(...(args as [])),
  isEncryptionInitialized: jest.fn(() => true),
  initializeDefaultEncryption: jest.fn(async () => undefined),
}));
jest.mock('@/utils/shared', () => ({ isSecretEnvVar: () => true }));

import type { NextRequest } from 'next/server';
import { isLocalRequest, assertLocalRequest } from '@/utils/http/localRequest';
import { POST as gitPost } from '@/app/api/git/route';
import { GET as cwdGet } from '@/app/api/cwd/route';
import { GET as updateGet, POST as updatePost } from '@/app/api/update/route';
import { POST as testConnPost } from '@/app/api/mcp/test-connection/route';
import { POST as testConnStreamPost } from '@/app/api/mcp/test-connection/stream/route';
import { POST as serversPost } from '@/app/api/mcp/servers/route';
import { PUT as serverPut, DELETE as serverDelete } from '@/app/api/mcp/servers/[name]/route';
import { GET as envGet, POST as envPost } from '@/app/api/env/route';
import { mcpService } from '@/backend/services/mcp';

// Convenience typed handles to the mcpService mock fns for assertions.
const testConnectionMock = mcpService.testConnection as jest.Mock;
const updateServerConfigMock = mcpService.updateServerConfig as jest.Mock;
const deleteServerConfigMock = mcpService.deleteServerConfig as jest.Mock;

/** Route context for the /api/mcp/servers/[name] handlers. */
const nameCtx = (name = 'x') => ({ params: Promise.resolve({ name }) });

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

describe('POST /api/update origin guard', () => {
  const applyBody = { action: 'apply' };

  it('blocks a cross-origin POST with 403 and never touches exec/spawn/git', async () => {
    const res = await updatePost(
      makeRequest('http://localhost:4200/api/update', {
        host: 'localhost:4200',
        origin: 'http://evil.com',
        body: applyBody,
      })
    );
    expect(res.status).toBe(403);
    expect(execSyncMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(simpleGitFactory).not.toHaveBeenCalled();
  });

  it('blocks a non-local Host with 403 and never touches the sinks', async () => {
    const res = await updatePost(
      makeRequest('http://evil.com/api/update', { host: 'evil.com', body: applyBody })
    );
    expect(res.status).toBe(403);
    expect(execSyncMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(simpleGitFactory).not.toHaveBeenCalled();
  });

  it('lets a localhost same-origin request past the guard (not 403)', async () => {
    // The mocked simple-git has no checkIsRepo, so the handler errors out with 500
    // AFTER the guard — that it is NOT 403 proves the guard allowed it through.
    const res = await updatePost(
      makeRequest('http://localhost:4200/api/update', {
        host: 'localhost:4200',
        origin: 'http://localhost:4200',
        body: applyBody,
      })
    );
    expect(res.status).not.toBe(403);
  });

  it('lets a native request with no Origin past the guard (not 403)', async () => {
    const res = await updatePost(
      makeRequest('http://localhost:4200/api/update', {
        host: 'localhost:4200',
        body: applyBody,
      })
    );
    expect(res.status).not.toBe(403);
  });
});

describe('GET /api/update origin guard', () => {
  it('blocks a cross-origin request with 403 and never touches git', async () => {
    const res = await updateGet(
      makeRequest('http://localhost:4200/api/update', {
        host: 'localhost:4200',
        origin: 'http://evil.com',
      })
    );
    expect(res.status).toBe(403);
    expect(simpleGitFactory).not.toHaveBeenCalled();
  });

  it('blocks a non-local Host with 403', async () => {
    const res = await updateGet(
      makeRequest('http://evil.com/api/update', { host: 'evil.com' })
    );
    expect(res.status).toBe(403);
    expect(simpleGitFactory).not.toHaveBeenCalled();
  });

  it('lets a localhost request past the guard (not 403)', async () => {
    const res = await updateGet(
      makeRequest('http://localhost:4200/api/update', { host: 'localhost:4200' })
    );
    expect(res.status).not.toBe(403);
  });

  it('lets a native request with no Origin past the guard (not 403)', async () => {
    const res = await updateGet(
      makeRequest('http://localhost:4200/api/update', { host: 'localhost:4200' })
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

// ============================================================================
// #141: routes that spawn child processes (drive-by RCE) or return secrets and
// were previously guarded only by assertUnlocked().
// ============================================================================

const stdioBody = { transport: 'stdio', command: 'calc.exe', args: [] };

describe('POST /api/mcp/test-connection origin guard', () => {
  it('blocks a cross-origin POST with 403 and never spawns (testConnection not called)', async () => {
    const res = await testConnPost(
      makeRequest('http://localhost:4200/api/mcp/test-connection', {
        host: 'localhost:4200',
        origin: 'http://evil.com',
        body: stdioBody,
      })
    );
    expect(res.status).toBe(403);
    expect(testConnectionMock).not.toHaveBeenCalled();
  });

  it('blocks a non-local Host with 403 and never spawns', async () => {
    const res = await testConnPost(
      makeRequest('http://evil.com/api/mcp/test-connection', { host: 'evil.com', body: stdioBody })
    );
    expect(res.status).toBe(403);
    expect(testConnectionMock).not.toHaveBeenCalled();
  });

  it('lets a localhost same-origin request past the guard (not 403)', async () => {
    const res = await testConnPost(
      makeRequest('http://localhost:4200/api/mcp/test-connection', {
        host: 'localhost:4200',
        origin: 'http://localhost:4200',
        body: stdioBody,
      })
    );
    expect(res.status).not.toBe(403);
  });

  it('lets a native request with no Origin past the guard (not 403)', async () => {
    const res = await testConnPost(
      makeRequest('http://localhost:4200/api/mcp/test-connection', {
        host: 'localhost:4200',
        body: stdioBody,
      })
    );
    expect(res.status).not.toBe(403);
  });
});

describe('POST /api/mcp/test-connection/stream origin guard', () => {
  it('blocks a cross-origin POST with 403 and never spawns', async () => {
    const res = await testConnStreamPost(
      makeRequest('http://localhost:4200/api/mcp/test-connection/stream', {
        host: 'localhost:4200',
        origin: 'http://evil.com',
        body: stdioBody,
      })
    );
    expect(res.status).toBe(403);
    expect(testConnectionMock).not.toHaveBeenCalled();
  });

  it('blocks a non-local Host with 403 and never spawns', async () => {
    const res = await testConnStreamPost(
      makeRequest('http://evil.com/api/mcp/test-connection/stream', { host: 'evil.com', body: stdioBody })
    );
    expect(res.status).toBe(403);
    expect(testConnectionMock).not.toHaveBeenCalled();
  });

  it('lets a localhost same-origin request past the guard (not 403)', async () => {
    const res = await testConnStreamPost(
      makeRequest('http://localhost:4200/api/mcp/test-connection/stream', {
        host: 'localhost:4200',
        origin: 'http://localhost:4200',
        body: stdioBody,
      })
    );
    expect(res.status).not.toBe(403);
  });

  it('lets a native request with no Origin past the guard (not 403)', async () => {
    const res = await testConnStreamPost(
      makeRequest('http://localhost:4200/api/mcp/test-connection/stream', {
        host: 'localhost:4200',
        body: stdioBody,
      })
    );
    expect(res.status).not.toBe(403);
  });
});

describe('POST /api/mcp/servers origin guard', () => {
  const serverBody = { name: 'evil', transport: 'stdio', command: 'calc.exe', args: [] };

  it('blocks a cross-origin POST with 403 and never persists (updateServerConfig not called)', async () => {
    const res = await serversPost(
      makeRequest('http://localhost:4200/api/mcp/servers', {
        host: 'localhost:4200',
        origin: 'http://evil.com',
        body: serverBody,
      })
    );
    expect(res.status).toBe(403);
    expect(updateServerConfigMock).not.toHaveBeenCalled();
  });

  it('blocks a non-local Host with 403 and never persists', async () => {
    const res = await serversPost(
      makeRequest('http://evil.com/api/mcp/servers', { host: 'evil.com', body: serverBody })
    );
    expect(res.status).toBe(403);
    expect(updateServerConfigMock).not.toHaveBeenCalled();
  });

  it('lets a localhost same-origin request past the guard (not 403)', async () => {
    const res = await serversPost(
      makeRequest('http://localhost:4200/api/mcp/servers', {
        host: 'localhost:4200',
        origin: 'http://localhost:4200',
        body: serverBody,
      })
    );
    expect(res.status).not.toBe(403);
  });

  it('lets a native request with no Origin past the guard (not 403)', async () => {
    const res = await serversPost(
      makeRequest('http://localhost:4200/api/mcp/servers', {
        host: 'localhost:4200',
        body: serverBody,
      })
    );
    expect(res.status).not.toBe(403);
  });
});

describe('PUT /api/mcp/servers/[name] origin guard', () => {
  const putBody = { name: 'x', transport: 'stdio', command: 'calc.exe', args: [] };

  it('blocks a cross-origin PUT with 403 and never persists', async () => {
    const res = await serverPut(
      makeRequest('http://localhost:4200/api/mcp/servers/x', {
        host: 'localhost:4200',
        origin: 'http://evil.com',
        body: putBody,
      }),
      nameCtx('x')
    );
    expect(res.status).toBe(403);
    expect(updateServerConfigMock).not.toHaveBeenCalled();
  });

  it('blocks a non-local Host with 403 and never persists', async () => {
    const res = await serverPut(
      makeRequest('http://evil.com/api/mcp/servers/x', { host: 'evil.com', body: putBody }),
      nameCtx('x')
    );
    expect(res.status).toBe(403);
    expect(updateServerConfigMock).not.toHaveBeenCalled();
  });

  it('lets a localhost same-origin request past the guard (not 403)', async () => {
    const res = await serverPut(
      makeRequest('http://localhost:4200/api/mcp/servers/x', {
        host: 'localhost:4200',
        origin: 'http://localhost:4200',
        body: putBody,
      }),
      nameCtx('x')
    );
    expect(res.status).not.toBe(403);
  });
});

describe('DELETE /api/mcp/servers/[name] origin guard', () => {
  it('blocks a cross-origin DELETE with 403 and never deletes', async () => {
    const res = await serverDelete(
      makeRequest('http://localhost:4200/api/mcp/servers/x', {
        host: 'localhost:4200',
        origin: 'http://evil.com',
      }),
      nameCtx('x')
    );
    expect(res.status).toBe(403);
    expect(deleteServerConfigMock).not.toHaveBeenCalled();
  });

  it('blocks a non-local Host with 403 and never deletes', async () => {
    const res = await serverDelete(
      makeRequest('http://evil.com/api/mcp/servers/x', { host: 'evil.com' }),
      nameCtx('x')
    );
    expect(res.status).toBe(403);
    expect(deleteServerConfigMock).not.toHaveBeenCalled();
  });

  it('lets a localhost same-origin request past the guard (not 403)', async () => {
    const res = await serverDelete(
      makeRequest('http://localhost:4200/api/mcp/servers/x', {
        host: 'localhost:4200',
        origin: 'http://localhost:4200',
      }),
      nameCtx('x')
    );
    expect(res.status).not.toBe(403);
  });
});

describe('GET /api/env origin guard (secret exfiltration)', () => {
  it('blocks a cross-origin ?includeSecrets=true with 403 and never decrypts', async () => {
    const res = await envGet(
      makeRequest('http://localhost:4200/api/env?includeSecrets=true', {
        host: 'localhost:4200',
        origin: 'http://evil.com',
      })
    );
    expect(res.status).toBe(403);
    expect(decryptWithPasswordMock).not.toHaveBeenCalled();
    expect(loadItemMock).not.toHaveBeenCalled();
  });

  it('blocks a non-local Host with 403 and never decrypts', async () => {
    const res = await envGet(
      makeRequest('http://evil.com/api/env?includeSecrets=true', { host: 'evil.com' })
    );
    expect(res.status).toBe(403);
    expect(decryptWithPasswordMock).not.toHaveBeenCalled();
  });

  it('lets a localhost same-origin request past the guard (not 403)', async () => {
    const res = await envGet(
      makeRequest('http://localhost:4200/api/env', {
        host: 'localhost:4200',
        origin: 'http://localhost:4200',
      })
    );
    expect(res.status).not.toBe(403);
  });

  it('lets a native request with no Origin past the guard (not 403)', async () => {
    const res = await envGet(
      makeRequest('http://localhost:4200/api/env', { host: 'localhost:4200' })
    );
    expect(res.status).not.toBe(403);
  });
});

describe('POST /api/env origin guard', () => {
  const setBody = { action: 'set', key: 'OPENAI_API_KEY', value: 'sk-secret', metadata: { isSecret: true } };

  it('blocks a cross-origin POST with 403 and never persists', async () => {
    const res = await envPost(
      makeRequest('http://localhost:4200/api/env', {
        host: 'localhost:4200',
        origin: 'http://evil.com',
        body: setBody,
      })
    );
    expect(res.status).toBe(403);
    expect(saveItemMock).not.toHaveBeenCalled();
    expect(encryptWithPasswordMock).not.toHaveBeenCalled();
  });

  it('blocks a non-local Host with 403 and never persists', async () => {
    const res = await envPost(
      makeRequest('http://evil.com/api/env', { host: 'evil.com', body: setBody })
    );
    expect(res.status).toBe(403);
    expect(saveItemMock).not.toHaveBeenCalled();
  });

  it('lets a localhost same-origin request past the guard (not 403)', async () => {
    const res = await envPost(
      makeRequest('http://localhost:4200/api/env', {
        host: 'localhost:4200',
        origin: 'http://localhost:4200',
        body: setBody,
      })
    );
    expect(res.status).not.toBe(403);
  });
});
