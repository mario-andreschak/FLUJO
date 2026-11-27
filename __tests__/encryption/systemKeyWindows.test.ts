/**
 * The real Windows store for the system key (#1443): Windows data protection
 * through the built-in Windows PowerShell. Opt-in with
 * FLUJO_TEST_REAL_SYSTEM_KEY=1 on Windows, because it starts PowerShell. It
 * uses a throwaway data folder and touches no Credential Manager entry: the
 * protected copy lives only in that folder.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const run = process.platform === 'win32' && process.env.FLUJO_TEST_REAL_SYSTEM_KEY === '1';
const describeReal = run ? describe : describe.skip;

jest.setTimeout(180_000);

describeReal('Windows data protection', () => {
  let root: string;
  let previousDataDir: string | undefined;
  let previousStoreSetting: string | undefined;

  beforeEach(async () => {
    previousDataDir = process.env.FLUJO_DATA_DIR;
    previousStoreSetting = process.env.FLUJO_SYSTEM_KEY_STORE;
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-system-key-windows-'));
    process.env.FLUJO_DATA_DIR = root;
    delete process.env.FLUJO_SYSTEM_KEY_STORE;
    global.__flujo_system_key = undefined;
    global.__flujo_system_key_store_detected = undefined;
    global.__flujo_server_dek = undefined;
    global.__flujo_server_deks_by_workspace = undefined;
    jest.resetModules();
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
    else process.env.FLUJO_DATA_DIR = previousDataDir;
    if (previousStoreSetting === undefined) delete process.env.FLUJO_SYSTEM_KEY_STORE;
    else process.env.FLUJO_SYSTEM_KEY_STORE = previousStoreSetting;
    global.__flujo_system_key = undefined;
    global.__flujo_system_key_store_detected = undefined;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('protects and opens a key for this Windows user, bound to its id', async () => {
    const { detectSystemKeyStore, SystemKeyUnreadableError } = await import('@/utils/encryption/systemKeyStore');
    const store = (await detectSystemKeyStore())!;
    expect(store.kind).toBe('windows');
    const id = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const protectedCopy = (await store.save(id, secret))!;
    expect(protectedCopy).not.toContain(secret);
    expect(await store.load(id, protectedCopy)).toBe(secret);
    await expect(store.load(randomUUID(), protectedCopy)).rejects.toBeInstanceOf(SystemKeyUnreadableError);
  });

  it('protects a fresh install end to end and opens it again after a restart', async () => {
    const secure = await import('@/utils/encryption/secure');
    const ciphertext = (await secure.encryptWithPassword('sk-real-windows'))!;
    expect(await secure.getEncryptionStatus()).toMatchObject({ protection: 'os-store', locked: false });
    global.__flujo_system_key = undefined;
    global.__flujo_server_dek = undefined;
    global.__flujo_server_deks_by_workspace = undefined;
    jest.resetModules();
    const restarted = await import('@/utils/encryption/secure');
    expect(await restarted.decryptWithPassword(ciphertext)).toBe('sk-real-windows');
  });
});

it('runs the real Windows check only when asked', () => {
  expect(typeof run).toBe('boolean');
});
