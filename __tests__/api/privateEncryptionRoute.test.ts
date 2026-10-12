import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';
import { issueOwnerCredential } from '@/backend/services/security/ownerCredentials';
import { StorageKey } from '@/shared/types/storage';
import { seedLegacyDefault } from '../encryption/fixtures/legacyDefault';

jest.mock('@/backend/init', () => ({ onUnlocked: jest.fn(async () => undefined) }));
jest.mock('@/backend/services/workspace/layoutReadiness', () => ({ waitForWorkspaceLayoutReady: jest.fn(async () => undefined) }));
jest.setTimeout(60_000);
let root: string;
let saved: Record<string, string | undefined>;
let token: string;
beforeEach(async () => {
  saved = Object.fromEntries(['FLUJO_DATA_DIR', 'FLUJO_ENCRYPTION_SECRET_FILE', 'FLUJO_OWNER_AUTH_FILE']
    .map(key => [key, process.env[key]]));
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-private-route-'));
  process.env.FLUJO_DATA_DIR = path.join(root, 'data');
  await fs.mkdir(path.join(root, 'data/workspaces/default-workspace/db'), { recursive: true });
  const issued = issueOwnerCredential(['control:admin', 'secrets:read'], Date.now() + 60_000);
  token = issued.token;
  process.env.FLUJO_OWNER_AUTH_FILE = path.join(root, 'owner.json');
  await fs.writeFile(process.env.FLUJO_OWNER_AUTH_FILE,
    JSON.stringify({ schemaVersion: 1, ownerId: 'owner', credentials: [issued.record] }), { mode: 0o600 });
  delete process.env.FLUJO_ENCRYPTION_SECRET_FILE;
  global.__flujo_server_dek = undefined;
  global.__flujo_encryption_sessions = undefined;
  global.__flujo_encryption_metadata_locks = undefined;
  global.__flujo_server_deks_by_workspace = undefined;
  global.__flujo_encryption_sessions_by_workspace = undefined;
  jest.resetModules();
});
afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  global.__flujo_server_dek = undefined;
  global.__flujo_encryption_sessions = undefined;
  global.__flujo_encryption_metadata_locks = undefined;
  await fs.rm(root, { recursive: true, force: true });
});
async function call(body: Record<string, unknown>, bearer: string | null = token) {
  const { POST } = await import('@/app/api/encryption/secure/route');
  return POST(new NextRequest('http://localhost:4200/api/encryption/secure', { method: 'POST', headers: {
    host: 'localhost:4200', origin: 'http://localhost:4200', 'Content-Type': 'application/json',
    ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
  }, body: JSON.stringify(body) }));
}
test('status and missing-password writes do not silently initialize public-default metadata', async () => {
  const status = await call({ action: 'status' });
  expect(status.status).toBe(200);
  expect(await status.json()).toEqual({ initialized: false, locked: true, protection: 'uninitialized' });
  const write = await call({ action: 'encrypt', data: 'synthetic-private-token' });
  expect(write.status).toBe(423);
  const { isEncryptionInitialized } = await import('@/utils/encryption/secure');
  expect(await isEncryptionInitialized()).toBe(false);
});
test('owner admission precedes encryption actions and remains distinct from encryption unlock tokens', async () => {
  expect((await call({ action: 'initialize', password: 'private-owner-passphrase' }, null)).status).toBe(401);
  expect((await call({ action: 'initialize', password: 'private-owner-passphrase' })).status).toBe(200);
  const verified = await call({ action: 'verify_password', password: 'private-owner-passphrase' });
  const result = await verified.json();
  expect(result.valid).toBe(true);
  expect((await call({ action: 'status' }, result.token)).status).toBe(401);
  expect(await (await call({ action: 'status' })).json()).toEqual({ initialized: true, locked: false, protection: 'passphrase' });
});
test('operator status initializes private metadata but returns no secret mount path, key or credential', async () => {
  const secret = randomBytes(32).toString('base64url');
  const filename = path.join(root, 'operator-secret');
  await fs.writeFile(filename, secret, { mode: 0o600 });
  process.env.FLUJO_ENCRYPTION_SECRET_FILE = filename;
  const response = await call({ action: 'status' });
  const text = await response.text();
  expect(JSON.parse(text)).toEqual({ initialized: true, locked: false, protection: 'operator-file' });
  for (const privateValue of [secret, filename, root, token]) expect(text).not.toContain(privateValue);
});
test('existing legacy-default status is explicit and remains recoverable', async () => {
  await seedLegacyDefault();
  expect(await (await call({ action: 'status' })).json()).toEqual({ initialized: true, locked: false, protection: 'legacy-default' });
  const { loadItem } = await import('@/utils/storage/backend');
  expect(await loadItem(StorageKey.ENCRYPTION_KEY, null)).toBeTruthy();
});
test('an unavailable operator mount reports its profile as locked instead of falling back to passphrase setup', async () => {
  process.env.FLUJO_ENCRYPTION_SECRET_FILE = path.join(root, 'missing-private-secret');
  const response = await call({ action: 'status' });
  expect(await response.json()).toEqual({ initialized: false, locked: true, protection: 'operator-file' });
});
