/**
 * Optional unattended unlock, against the real encryption and storage backend.
 * The rule under test: without opting in nothing changes, and with opting in a
 * problem only ever leaves the instance locked.
 */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

jest.setTimeout(120000);

const PASSWORD = 'a long enough test passphrase';
let tmpDir: string;

function clearGlobals(): void {
  const globals = global as Record<string, unknown>;
  for (const key of ['__flujo_server_dek', '__flujo_encryption_sessions', '__flujo_server_deks_by_workspace',
    '__flujo_encryption_sessions_by_workspace', '__flujo_unattended_unlock_secret']) globals[key] = undefined;
}

async function load() {
  jest.resetModules();
  const secure = await import('@/utils/encryption/secure');
  const unlock = await import('@/backend/services/security/unattendedUnlock');
  return { secure, unlock };
}

/** Set a password, then forget the unlock, as a restart of the process would. */
async function lockedProfile() {
  const { secure } = await load();
  expect(await secure.initializeEncryption(PASSWORD)).toBe(true);
  clearGlobals();
  const fresh = await load();
  expect(await fresh.secure.isEncryptionLocked()).toBe(true);
  return fresh;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-unattended-unlock-'));
  process.env.FLUJO_DATA_DIR = tmpDir;
  delete process.env.FLUJO_UNLOCK_SECRET;
  delete process.env.FLUJO_UNLOCK_SECRET_CHECKED;
  delete process.env.FLUJO_UNLOCK_SECRET_SOURCE;
  clearGlobals();
});

afterEach(async () => {
  delete process.env.FLUJO_DATA_DIR;
  delete process.env.FLUJO_UNLOCK_SECRET;
  delete process.env.FLUJO_UNLOCK_SECRET_CHECKED;
  delete process.env.FLUJO_UNLOCK_SECRET_SOURCE;
  clearGlobals();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

it('not opted in: a correct secret in the environment does nothing and is removed', async () => {
  const { secure, unlock } = await lockedProfile();
  process.env.FLUJO_UNLOCK_SECRET_CHECKED = PASSWORD;
  process.env.FLUJO_UNLOCK_SECRET = PASSWORD;
  expect(await unlock.attemptUnattendedUnlock()).toBe(false);
  expect(await secure.isEncryptionLocked()).toBe(true);
  expect(process.env.FLUJO_UNLOCK_SECRET_CHECKED).toBeUndefined();
  expect(process.env.FLUJO_UNLOCK_SECRET).toBeUndefined();
});

it('opted in: the right secret unlocks, and child programs cannot inherit it', async () => {
  const { secure, unlock } = await lockedProfile();
  process.env.FLUJO_UNLOCK_SECRET_SOURCE = 'env';
  process.env.FLUJO_UNLOCK_SECRET_CHECKED = PASSWORD;
  unlock.captureUnattendedUnlockSecret();
  expect(process.env.FLUJO_UNLOCK_SECRET_CHECKED).toBeUndefined();
  expect(await unlock.attemptUnattendedUnlock()).toBe(true);
  expect(await secure.isEncryptionLocked()).toBe(false);
  // Encrypting works, so the unlock is real and not just a flag.
  const sealed = await secure.encryptWithPassword('value');
  expect(await secure.decryptWithPassword(sealed!)).toBe('value');
});

it('the unlock survives dropping its one-off browser session', async () => {
  const { secure, unlock } = await lockedProfile();
  process.env.FLUJO_UNLOCK_SECRET_SOURCE = 'dpapi';
  process.env.FLUJO_UNLOCK_SECRET_CHECKED = PASSWORD;
  await unlock.attemptUnattendedUnlock();
  expect(await secure.isEncryptionLocked()).toBe(false);
  expect((global as Record<string, unknown>).__flujo_encryption_sessions).toEqual(new Map());
});

it('a wrong secret leaves it locked, says nothing about the secret, and a person can still unlock', async () => {
  const { secure, unlock } = await lockedProfile();
  process.env.FLUJO_UNLOCK_SECRET_SOURCE = 'env';
  process.env.FLUJO_UNLOCK_SECRET_CHECKED = 'this is the wrong passphrase';
  const printed: string[] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method =>
    jest.spyOn(console, method).mockImplementation((...args: unknown[]) => { printed.push(args.map(String).join(' ')); }));
  try {
    expect(await unlock.attemptUnattendedUnlock()).toBe(false);
    expect(await secure.isEncryptionLocked()).toBe(true);
  } finally { spies.forEach(spy => spy.mockRestore()); }
  expect(printed.join('\n')).not.toContain('wrong passphrase');
  expect((await secure.verifyPassword(PASSWORD)).valid).toBe(true);
  expect(await secure.isEncryptionLocked()).toBe(false);
});

it('an instance with no password is not touched', async () => {
  const { secure, unlock } = await load();
  process.env.FLUJO_UNLOCK_SECRET_SOURCE = 'env';
  process.env.FLUJO_UNLOCK_SECRET_CHECKED = PASSWORD;
  expect(await unlock.attemptUnattendedUnlock()).toBe(false);
  expect(await secure.isUserEncryptionEnabled()).toBe(false);
  expect(await secure.getEncryptionType()).toBeNull();
});

it('the unchecked variable alone never unlocks, so a value from a .env file cannot', async () => {
  const { secure, unlock } = await lockedProfile();
  process.env.FLUJO_UNLOCK_SECRET_SOURCE = 'env';
  process.env.FLUJO_UNLOCK_SECRET = PASSWORD;
  expect(await unlock.attemptUnattendedUnlock()).toBe(false);
  expect(await secure.isEncryptionLocked()).toBe(true);
  expect(process.env.FLUJO_UNLOCK_SECRET).toBeUndefined();
});
