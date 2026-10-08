import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { issueOwnerCredential, type OwnerPolicy } from '@/backend/services/security/ownerCredentials';
import { assertOwnerRequest, resolveOwnerRequest } from '@/backend/services/security/ownerAccess';
import { createOwnerSession, OWNER_SESSION_MAX_AGE_MS } from '@/backend/services/security/ownerSession';
import { DELETE, GET, POST } from '@/app/api/owner/session/route';

let directory: string;
let filename: string;
let token: string;
let policy: OwnerPolicy;
let now: number;
let savedPolicy: string | undefined;
let savedOrigin: string | undefined;
let origin: string;

beforeEach(() => {
  savedPolicy = process.env.FLUJO_OWNER_AUTH_FILE;
  savedOrigin = process.env.FLUJO_OWNER_BROWSER_ORIGIN;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-owner-session-'));
  filename = path.join(directory, 'policy.json');
  origin = 'http://localhost:4200';
  now = 1700000000000;
  jest.spyOn(Date, 'now').mockReturnValue(now);
  const issued = issueOwnerCredential(['control:admin', 'secrets:read', 'mcp:access'], now + 2 * OWNER_SESSION_MAX_AGE_MS, now);
  token = issued.token;
  policy = { schemaVersion: 1, ownerId: 'owner', credentials: [issued.record] };
  persist();
  process.env.FLUJO_OWNER_AUTH_FILE = filename;
  process.env.FLUJO_OWNER_BROWSER_ORIGIN = origin;
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
  if (savedPolicy === undefined) delete process.env.FLUJO_OWNER_AUTH_FILE;
  else process.env.FLUJO_OWNER_AUTH_FILE = savedPolicy;
  if (savedOrigin === undefined) delete process.env.FLUJO_OWNER_BROWSER_ORIGIN;
  else process.env.FLUJO_OWNER_BROWSER_ORIGIN = savedOrigin;
});

function persist() {
  fs.writeFileSync(`${filename}.new`, JSON.stringify(policy), { mode: 0o600 });
  fs.renameSync(`${filename}.new`, filename);
}

function request(method: string, route = '/api/owner/session', headers: Record<string, string> = {}) {
  return new Request(`${origin}${route}`, { method, headers: {
    host: new URL(origin).host, origin, ...headers,
  } });
}

function login() {
  const response = POST(request('POST', undefined, { authorization: `Bearer ${token}` }));
  expect(response.status).toBe(200);
  const header = response.headers.get('set-cookie')!;
  expect(header).toContain('HttpOnly; SameSite=Strict');
  expect(header).toContain('Path=/');
  return header.split(';')[0];
}

function sessionRequest(cookie: string, method = 'GET') {
  return request(method, '/api/models', { cookie });
}

test('issues an opaque HttpOnly cookie and stores no bearer or plaintext session token', async () => {
  const response = POST(request('POST', undefined, { authorization: `Bearer ${token}` }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ authenticated: true });
  expect(response.headers.get('cache-control')).toBe('no-store');
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  expect(cookie).toMatch(/^flujo-owner-local=flo_s1_[A-Za-z0-9_-]{43}$/);
  const records = fs.readdirSync(`${filename}.sessions`);
  expect(records).toHaveLength(1);
  const stored = fs.readFileSync(path.join(`${filename}.sessions`, records[0]), 'utf8');
  expect(stored).not.toContain(token);
  expect(stored).not.toContain(cookie.split('=')[1]);
  expect(stored).not.toContain(policy.credentials[0].digest);
  expect(assertOwnerRequest(sessionRequest(cookie))).toBeNull();
});

test('reauthenticates a persisted cookie after module reload without shared proxy state', () => {
  const cookie = login();
  jest.isolateModules(() => {
    const fresh = jest.requireActual<typeof import('@/backend/services/security/ownerAccess')>('@/backend/services/security/ownerAccess');
    expect(fresh.resolveOwnerRequest(sessionRequest(cookie)).ok).toBe(true);
  });
});

test('two logins generate distinct IDs; cookie alone cannot establish or fix a session', () => {
  const first = login();
  const second = login();
  expect(second).not.toBe(first);
  expect(POST(request('POST', undefined, { cookie: first })).status).toBe(401);
  expect(POST(request('POST', undefined, { cookie: 'flujo-owner-local=attacker' })).status).toBe(401);
});

test.each(['https://attacker.test', 'null', 'http://localhost:4201'])('rejects cross-origin login and cookie mutations (%s)', attacker => {
  const cookie = login();
  expect(POST(request('POST', undefined, { authorization: `Bearer ${token}`, origin: attacker })).status).toBe(403);
  expect(resolveOwnerRequest(request('POST', '/api/models', { cookie, origin: attacker })).ok).toBe(false);
  expect(DELETE(request('DELETE', undefined, { cookie, origin: attacker })).status).toBe(403);
});

test('rejects mutation without Origin, even when Sec-Fetch-Site claims same-origin', () => {
  const cookie = login();
  const req = sessionRequest(cookie, 'POST');
  req.headers.delete('origin');
  req.headers.set('sec-fetch-site', 'same-origin');
  expect(resolveOwnerRequest(req).ok).toBe(false);
  expect(DELETE(new Request(`${origin}/api/owner/session`, { method: 'DELETE', headers: {
    host: new URL(origin).host, cookie, 'sec-fetch-site': 'same-origin',
  } })).status).toBe(403);
});

test('permits same-origin browser reads without Origin and refuses cross-site reads', () => {
  const cookie = login();
  const req = sessionRequest(cookie);
  req.headers.delete('origin');
  req.headers.set('sec-fetch-site', 'same-origin');
  expect(resolveOwnerRequest(req).ok).toBe(true);
  req.headers.set('sec-fetch-site', 'cross-site');
  expect(resolveOwnerRequest(req).ok).toBe(false);
  req.headers.set('sec-fetch-site', 'same-origin');
  req.headers.set('origin', 'https://attacker.test');
  expect(resolveOwnerRequest(req).ok).toBe(false);
});

test('does not infer the trusted browser origin from Host or forwarded headers', () => {
  const cookie = login();
  const req = new Request('http://attacker.test/api/models', { headers: {
    cookie, host: 'localhost:4200', origin,
    'x-forwarded-host': 'localhost:4200', 'x-forwarded-proto': 'http',
  } });
  expect(resolveOwnerRequest(req).ok).toBe(false);
  expect(resolveOwnerRequest(request('GET', '/api/models', { cookie, host: 'localhost:4201' })).ok).toBe(false);
});

test('expires sessions at the exact boundary, independently of the longer-lived bearer', () => {
  const cookie = login();
  expect(resolveOwnerRequest(sessionRequest(cookie), undefined, { now: now + OWNER_SESSION_MAX_AGE_MS - 1 }).ok).toBe(true);
  expect(resolveOwnerRequest(sessionRequest(cookie), undefined, { now: now + OWNER_SESSION_MAX_AGE_MS }).ok).toBe(false);
  expect(resolveOwnerRequest(request('GET', '/api/models', { authorization: `Bearer ${token}` }), undefined,
    { now: now + OWNER_SESSION_MAX_AGE_MS }).ok).toBe(true);
});

test('logout revokes both subsequent requests and an existing authorization witness', () => {
  const cookie = login();
  const admitted = resolveOwnerRequest(sessionRequest(cookie));
  expect(admitted.ok).toBe(true);
  const response = DELETE(request('DELETE', undefined, { cookie }));
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  expect(resolveOwnerRequest(sessionRequest(cookie)).ok).toBe(false);
  if (admitted.ok) expect(admitted.authorization.recheck()!.status).toBe(401);
  expect(assertOwnerRequest(request('DELETE', undefined, { cookie }))).toBeNull();
  expect(DELETE(request('DELETE', undefined, { cookie })).status).toBe(200);
});

test.each(['revoke', 'remove', 'owner', 'scope'])('policy %s invalidates cookies and existing witnesses', change => {
  const cookie = login();
  const admitted = resolveOwnerRequest(sessionRequest(cookie));
  if (!admitted.ok) throw new Error('Expected session');
  if (change === 'revoke') policy.credentials[0].revokedAt = now;
  if (change === 'remove') policy.credentials = [];
  if (change === 'owner') policy.ownerId = 'different-owner';
  if (change === 'scope') policy.credentials[0].scopes = ['openai:read'];
  persist();
  expect(resolveOwnerRequest(sessionRequest(cookie)).ok).toBe(false);
  expect(admitted.authorization.recheck()!.status).toBe(401);
});

test('rejects a duplicate cookie, an explicit invalid bearer and cookie use for private voice admission', () => {
  const cookie = login();
  expect(resolveOwnerRequest(sessionRequest(`${cookie}; ${cookie}`)).ok).toBe(false);
  expect(resolveOwnerRequest(request('GET', '/api/models', { cookie, authorization: 'Bearer invalid' })).ok).toBe(false);
  expect(resolveOwnerRequest(sessionRequest(cookie), ['avatar:voice']).ok).toBe(false);
  expect(resolveOwnerRequest(sessionRequest(cookie), undefined, { requireBearer: true }).ok).toBe(false);
});

test('rejects policy corruption and a changed browser configuration without leaking record data', async () => {
  const cookie = login();
  process.env.FLUJO_OWNER_BROWSER_ORIGIN = 'http://localhost:4201';
  expect(resolveOwnerRequest(sessionRequest(cookie)).ok).toBe(false);
  process.env.FLUJO_OWNER_BROWSER_ORIGIN = origin;
  fs.writeFileSync(filename, '{private-corrupt-policy');
  const response = GET(request('GET', undefined, { cookie }));
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('private-corrupt-policy');
});

test('corrupt session storage fails closed and never falls back to anonymous access', async () => {
  const cookie = login();
  const file = path.join(`${filename}.sessions`, fs.readdirSync(`${filename}.sessions`)[0]);
  fs.writeFileSync(file, '{synthetic-private-path');
  const result = resolveOwnerRequest(sessionRequest(cookie));
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.response.status).toBe(503);
    expect(await result.response.text()).not.toContain('synthetic-private-path');
  }
});

test('HTTPS uses a Secure host-prefixed cookie; insecure non-loopback configuration is refused', () => {
  origin = 'https://owner.example.test';
  process.env.FLUJO_OWNER_BROWSER_ORIGIN = origin;
  const response = POST(request('POST', undefined, { authorization: `Bearer ${token}` }));
  expect(response.headers.get('set-cookie')).toMatch(/^__Host-flujo-owner=/);
  expect(response.headers.get('set-cookie')).toContain('; Secure');
  origin = 'http://owner.example.test';
  process.env.FLUJO_OWNER_BROWSER_ORIGIN = origin;
  expect(POST(request('POST', undefined, { authorization: `Bearer ${token}` })).status).toBe(403);
});

test('an execution-only bearer cannot mint an administrative browser session', () => {
  const issued = issueOwnerCredential(['openai:execute'], now + 10000, now);
  policy.credentials.push(issued.record);
  persist();
  expect(POST(request('POST', undefined, { authorization: `Bearer ${issued.token}` })).status).toBe(403);
  expect(fs.existsSync(`${filename}.sessions`)).toBe(false);
});

test('policy replacement after bearer admission cannot mint a session with stale authority', () => {
  const req = request('POST', undefined, { authorization: `Bearer ${token}` });
  const admitted = resolveOwnerRequest(req, undefined, { requireBearer: true });
  if (!admitted.ok) throw new Error('Expected bearer admission');
  policy.credentials[0].digest = 'a'.repeat(64);
  persist();
  expect(() => createOwnerSession(req, admitted.authorization.principal)).toThrow('Owner authorization was lost');
  expect(fs.existsSync(`${filename}.sessions`)).toBe(false);
});

test('rejects a replaced session pathname even after reading the admitted descriptor', () => {
  const cookie = login();
  const file = path.join(`${filename}.sessions`, fs.readdirSync(`${filename}.sessions`)[0]);
  const read = fs.readSync.bind(fs);
  const original = fs.readFileSync(file);
  let replaced = false;
  jest.spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    const result = read(...args);
    if (!replaced && typeof args[1] === 'object' && args[1].byteLength === 4097) {
      replaced = true;
      fs.renameSync(file, `${file}.old`);
      fs.writeFileSync(file, original, { mode: 0o600 });
    }
    return result;
  }) as typeof fs.readSync);
  const admitted = resolveOwnerRequest(sessionRequest(cookie));
  expect(replaced).toBe(true);
  expect(admitted.ok).toBe(false);
  if (!admitted.ok) expect(admitted.response.status).toBe(503);
});

test('rejects a hard-linked session file before authorizing a request', () => {
  const cookie = login();
  const file = path.join(`${filename}.sessions`, fs.readdirSync(`${filename}.sessions`)[0]);
  fs.linkSync(file, path.join(directory, 'session-alias.json'));
  const admitted = resolveOwnerRequest(sessionRequest(cookie));
  expect(admitted.ok).toBe(false);
  if (!admitted.ok) expect(admitted.response.status).toBe(503);
});

test('rejects a symlink or junction substituted for the private session directory', () => {
  const cookie = login();
  const moved = path.join(directory, 'moved-sessions');
  fs.renameSync(`${filename}.sessions`, moved);
  fs.symlinkSync(moved, `${filename}.sessions`, process.platform === 'win32' ? 'junction' : 'dir');
  const admitted = resolveOwnerRequest(sessionRequest(cookie));
  expect(admitted.ok).toBe(false);
  if (!admitted.ok) expect(admitted.response.status).toBe(503);
});

test('fresh OS processes admit a durable session and independently observe revocation', () => {
  const cookie = login();
  const probe = () => {
    const child = spawnSync(process.execPath, [
      path.join(__dirname, 'fixtures/owner-session-child.cjs'),
      path.resolve(__dirname, '../../src/backend/services/security/ownerAccess.ts'),
      require.resolve('typescript'),
    ], { input: JSON.stringify({ cookie, now }), encoding: 'utf8', timeout: 10000, maxBuffer: 4096,
      windowsHide: true, env: { NODE_ENV: 'test', SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR, FLUJO_OWNER_AUTH_FILE: filename, FLUJO_OWNER_BROWSER_ORIGIN: origin } });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stderr).toBe('');
    return Number(child.stdout);
  };
  expect(probe()).toBe(200);
  policy.credentials[0].revokedAt = now;
  persist();
  expect(probe()).toBe(401);
});
