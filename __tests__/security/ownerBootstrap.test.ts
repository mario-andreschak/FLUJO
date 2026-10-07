import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { issueOwnerCredential, type OwnerPolicy } from '@/backend/services/security/ownerCredentials';
import { isOwnerBootstrapAvailable, pairFirstOwner } from '@/backend/services/security/ownerBootstrap';
import { assertOwnerRequest } from '@/backend/services/security/ownerAccess';
import { assertOwnerStartup } from '@/backend/services/security/ownerStartup';
import { readOwnerPolicy } from '@/backend/services/security/ownerPolicy';
import { resolveOwnerSession } from '@/backend/services/security/ownerSession';
import { GET, POST } from '@/app/api/owner/bootstrap/route';

const keys = ['FLUJO_DATA_DIR', 'FLUJO_OWNER_AUTH_FILE', 'FLUJO_OWNER_BOOTSTRAP_FILE', 'FLUJO_OWNER_BROWSER_ORIGIN',
  'FLUJO_EXPOSURE_MODE', 'FLUJO_WORKER_MODE'] as const;
let saved: Record<string, string | undefined>; let root: string; let policyFile: string;
let bootstrapFile: string; let token: string; let grant: OwnerPolicy;
beforeEach(() => {
  saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-owner-pairing-'));
  fs.mkdirSync(path.join(root, 'private'), { mode: 0o700 });
  process.env.FLUJO_DATA_DIR = path.join(root, 'data');
  policyFile = path.join(root, 'private', 'owner.json'); bootstrapFile = path.join(root, 'private', 'bootstrap.json');
  process.env.FLUJO_OWNER_AUTH_FILE = policyFile; process.env.FLUJO_OWNER_BOOTSTRAP_FILE = bootstrapFile;
  process.env.FLUJO_OWNER_BROWSER_ORIGIN = 'http://localhost:4200'; process.env.FLUJO_EXPOSURE_MODE = 'localhost';
  delete process.env.FLUJO_WORKER_MODE;
  const now = Date.now(); const issued = issueOwnerCredential(['control:admin', 'secrets:read'], now + 900_000, now);
  token = issued.token; grant = { schemaVersion: 1, ownerId: 'owner', credentials: [issued.record] };
  fs.writeFileSync(bootstrapFile, JSON.stringify(grant), { mode: 0o600 });
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.rmSync(root, { recursive: true, force: true });
});
function request(options: { method?: string; token?: string; origin?: string; host?: string; body?: unknown; url?: string } = {}) {
  const method = options.method ?? 'POST';
  return new Request(options.url ?? 'http://localhost:4200/api/owner/bootstrap', { method,
    headers: { host: options.host ?? 'localhost:4200', origin: options.origin ?? 'http://localhost:4200',
      Authorization: `Bearer ${options.token ?? token}`, 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(options.body ?? { confirmOwnerEnrollment: true }) } : {}) });
}
test('pending private pairing admits only exact endpoint, not data access or nonlocal startup', () => {
  expect(isOwnerBootstrapAvailable()).toBe(true); expect(() => assertOwnerStartup()).not.toThrow();
  expect(assertOwnerRequest(request())).toBeNull();
  expect(assertOwnerRequest(request({ url: 'http://localhost:4200/api/models' }))?.status).toBe(503);
  process.env.FLUJO_EXPOSURE_MODE = 'network';
  expect(() => assertOwnerStartup()).toThrow('Restart with FLUJO_EXPOSURE_MODE=localhost');
  expect(isOwnerBootstrapAvailable()).toBe(false);
});
test('confirmed pairing commits one owner, returns a new token once and mints a restart-safe session', async () => {
  const paired = await POST(request()); expect(paired.status).toBe(201);
  const body = await paired.json(); expect(body.authenticated).toBe(true); expect(body.ownerToken).not.toBe(token);
  const policy = readOwnerPolicy(policyFile); expect(policy.ownerId).toBe('owner');
  expect(JSON.stringify(policy)).not.toContain(body.ownerToken); expect(JSON.stringify(policy)).not.toContain(token);
  const cookie = paired.headers.get('set-cookie')!; expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Strict');
  const browser = new Request('http://localhost:4200/api/models', { headers: { host: 'localhost:4200',
    origin: 'http://localhost:4200', cookie: cookie.split(';')[0] } });
  expect(resolveOwnerSession(browser, readOwnerPolicy(policyFile), policyFile, Date.now())).not.toBeNull();
  expect(isOwnerBootstrapAvailable()).toBe(false); expect((await POST(request())).status).toBe(403);
  expect(fs.lstatSync(policyFile).nlink).toBe(1);
  if (process.platform !== 'win32') expect(fs.statSync(policyFile).mode & 0o777).toBe(0o600);
  expect(paired.headers.get('cache-control')).toBe('no-store');
});
test.each([{ token: 'invalid' }, { origin: 'http://attacker.test' }, { host: 'attacker.test' },
  { body: { confirmOwnerEnrollment: false } }, { body: { confirmOwnerEnrollment: true, ownerId: 'forged' } }])
('denies invalid proof, authority or confirmation without writing a policy', async options => {
  const response = await POST(request(options)); expect(response.status).toBeGreaterThanOrEqual(400);
  expect(fs.existsSync(policyFile)).toBe(false); expect(JSON.stringify(await response.json())).not.toContain(token);
});
test.each(['expired', 'future', 'long-lived', 'revoked', 'scope'])('refuses %s pairing grant', variant => {
  const credential = grant.credentials[0];
  if (variant === 'expired') credential.expiresAt = Date.now() - 1;
  if (variant === 'future') credential.issuedAt = Date.now() + 1_000;
  if (variant === 'long-lived') credential.expiresAt += 1_000;
  if (variant === 'revoked') credential.revokedAt = Date.now();
  if (variant === 'scope') credential.scopes = ['openai:execute'];
  fs.writeFileSync(bootstrapFile, JSON.stringify(grant)); expect(isOwnerBootstrapAvailable()).toBe(false);
});
test.each(['valid', 'corrupt', 'empty'])('never replaces an existing %s owner policy', variant => {
  const bytes = variant === 'valid' ? JSON.stringify(grant) : variant === 'corrupt' ? 'bad json' : '';
  fs.writeFileSync(policyFile, bytes); expect(() => pairFirstOwner(request(), true)).toThrow();
  expect(fs.readFileSync(policyFile, 'utf8')).toBe(bytes);
});
test('worker mode, public browser origin and data-directory capabilities cannot enroll', () => {
  process.env.FLUJO_WORKER_MODE = '1'; expect(isOwnerBootstrapAvailable()).toBe(false); delete process.env.FLUJO_WORKER_MODE;
  process.env.FLUJO_OWNER_BROWSER_ORIGIN = 'https://public.test'; expect(isOwnerBootstrapAvailable()).toBe(false);
  process.env.FLUJO_OWNER_BROWSER_ORIGIN = 'http://localhost:4200'; process.env.FLUJO_DATA_DIR = root;
  expect(isOwnerBootstrapAvailable()).toBe(false);
});
test('availability response never contains the capability or private paths', async () => {
  const response = GET(request({ method: 'GET' })); expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ pairingAvailable: true });
});

test('two real OS processes elect one first owner without replacing the policy', async () => {
  const probe = () => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'fixtures/owner-access-child.cjs'),
      path.resolve(__dirname, '../../src/backend/services/security/ownerAccess.ts'), require.resolve('typescript')],
    { env: { ...process.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let errors = '';
    child.stdout.on('data', bytes => { output += bytes.toString(); });
    child.stderr.on('data', bytes => { errors += bytes.toString(); });
    child.on('error', reject); child.on('close', code => {
      if (code !== 0 || errors) reject(new Error('Owner pairing source process failed')); else resolve(output);
    });
    child.stdin.end(JSON.stringify({ pair: true, token }));
  });
  expect((await Promise.all([probe(), probe()])).sort()).toEqual(['PAIRED', 'REFUSED']);
  expect(readOwnerPolicy(policyFile).credentials).toHaveLength(1);
  expect(fs.readdirSync(path.dirname(policyFile)).filter(name => name.startsWith('.owner-enrollment'))).toEqual([]);
});

test('revocation before commit fences the staged enrollment without erasing prior capability data', () => {
  const sync = fs.fsyncSync;
  const spy = jest.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    sync(fd); grant.credentials[0].revokedAt = Date.now();
    fs.writeFileSync(bootstrapFile, JSON.stringify(grant));
  });
  try {
    expect(() => pairFirstOwner(request(), true)).toThrow();
    expect(fs.existsSync(policyFile)).toBe(false);
    expect(readOwnerPolicy(bootstrapFile).credentials[0].revokedAt).not.toBeNull();
    expect(fs.readdirSync(path.dirname(policyFile)).filter(name => name.startsWith('.owner-enrollment'))).toEqual([]);
  } finally { spy.mockRestore(); }
});

test('a capability that expires while staging cannot commit using the earlier admission timestamp', () => {
  const admittedAt = Date.now();
  const clock = jest.spyOn(Date, 'now').mockReturnValue(admittedAt);
  const sync = fs.fsyncSync;
  const barrier = jest.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    sync(fd); clock.mockReturnValue(grant.credentials[0].expiresAt + 1);
  });
  try {
    expect(() => pairFirstOwner(request(), true, admittedAt)).toThrow();
    expect(fs.existsSync(policyFile)).toBe(false);
    expect(fs.readdirSync(path.dirname(policyFile)).filter(name => name.startsWith('.owner-enrollment'))).toEqual([]);
  } finally { barrier.mockRestore(); clock.mockRestore(); }
});
