/**
 * The system key (#1443) against the real key store of this computer: Windows
 * data protection, the macOS Keychain or the Linux Secret Service. Ordinary
 * test runs never touch a real store (jest.setup.ts turns it off).
 * `node scripts/check-system-key-store.mjs` runs this file once per situation,
 * on Linux inside a throwaway keyring, and CI runs that script on every system
 * (.github/workflows/verify-full.yml). FLUJO_TEST_REAL_SYSTEM_KEY names the
 * situation:
 *
 * - `working`: the store answers. Store, read back, restart, replace the data
 *   key, move an existing install, recover a lost key, re-protect a restored
 *   workspace. Every entry made here is removed again.
 * - `locked` (Linux): the keyring holds FLUJO's key but is locked.
 * - `unavailable` (Linux): a desktop session without a keyring service.
 * - `absent` (Linux): no desktop session at all, like Docker or a server.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { SystemKeyStore, SystemKeyStoreKind } from '@/utils/encryption/systemKeyStore';
import { seedLegacyDefault } from './fixtures/legacyDefault';

const execFileAsync = promisify(execFile);
const SCENARIOS = ['working', 'locked', 'unavailable', 'absent'] as const;
type Scenario = typeof SCENARIOS[number];
const scenario = process.env.FLUJO_TEST_REAL_SYSTEM_KEY as Scenario | undefined;
const platformStore: Record<string, SystemKeyStoreKind> = { win32: 'windows', darwin: 'macos', linux: 'linux' };
const expected = platformStore[process.platform];
const KEYCHAIN_SERVICE = 'flujo-system-key';

jest.setTimeout(240_000);

let roots: string[] = [];
/** Store entries made directly, beside those named by a data folder's key record. */
let madeIds: Set<string>;
let previous: Record<string, string | undefined>;

function restart() {
  global.__flujo_server_dek = undefined;
  global.__flujo_encryption_sessions = undefined;
  global.__flujo_server_deks_by_workspace = undefined;
  global.__flujo_encryption_sessions_by_workspace = undefined;
  global.__flujo_encryption_metadata_locks = undefined;
  global.__flujo_system_key = undefined;
  global.__flujo_system_key_moves = undefined;
  global.__flujo_system_key_store_detected = undefined;
}

/** Loads FLUJO afresh, like a new start. `undefined` uses the store this computer really offers. */
async function modules(store: SystemKeyStore | null | undefined = undefined) {
  jest.resetModules();
  const systemKeyStore = await import('@/utils/encryption/systemKeyStore');
  systemKeyStore.setSystemKeyStoreForTests(store);
  return {
    secure: await import('@/utils/encryption/secure'),
    systemKey: await import('@/utils/encryption/systemKey'),
    migration: await import('@/backend/services/workspace/credentialMigration'),
    systemKeyStore,
  };
}

async function newDataFolder(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-system-key-real-'));
  roots.push(root);
  process.env.FLUJO_DATA_DIR = root;
  restart();
  return root;
}

async function dbDir(): Promise<string> {
  return (await import('@/utils/workspace')).getWorkspaceDbDir();
}

async function keyFile(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(await dbDir(), 'encryption_key.json'), 'utf8'));
}

interface KeyRecord { id: string; store: SystemKeyStoreKind; protectedCopy?: string; recoveryKeySavedAt?: number }

async function record(root = process.env.FLUJO_DATA_DIR!): Promise<KeyRecord> {
  return JSON.parse(await fs.readFile(path.join(root, 'keys', 'system-key.json'), 'utf8'));
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory()
    ? filesUnder(path.join(directory, entry.name)) : Promise.resolve([path.join(directory, entry.name)])));
  return nested.flat();
}

async function secretTool(): Promise<string> {
  for (const candidate of ['/usr/bin/secret-tool', '/usr/local/bin/secret-tool']) {
    if (await fs.stat(candidate).then(stat => stat.isFile(), () => false)) return candidate;
  }
  throw new Error('secret-tool is not installed');
}

/** Removes an entry this file made from the real store. Windows keeps nothing outside the data folder. */
async function forget(id: string): Promise<void> {
  if (expected === 'linux') {
    await execFileAsync(await secretTool(), ['clear', 'application', 'flujo', 'flujo-system-key', id], { timeout: 30_000 });
  } else if (expected === 'macos') {
    await execFileAsync('/usr/bin/security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', id], { timeout: 30_000 })
      .catch((error: { code?: number }) => { if (error.code !== 44) throw error; });
  }
}

/** The store no longer opens FLUJO's key, as after a password reset or a wiped keyring. */
async function loseKey(store: SystemKeyStore, root: string): Promise<void> {
  const current = await record(root);
  if (store.kind !== 'windows') { await forget(current.id); return; }
  // A copy Windows protected for another key id: Windows refuses to open it for this one.
  const foreignCopy = await store.save(randomUUID(), randomBytes(32).toString('base64url'));
  await fs.writeFile(path.join(root, 'keys', 'system-key.json'), JSON.stringify({ ...current, protectedCopy: foreignCopy }));
}

beforeEach(() => {
  previous = { dataDir: process.env.FLUJO_DATA_DIR, storeSetting: process.env.FLUJO_SYSTEM_KEY_STORE };
  roots = [];
  madeIds = new Set();
  if (scenario) delete process.env.FLUJO_SYSTEM_KEY_STORE;
  restart();
});

afterEach(async () => {
  jest.restoreAllMocks();
  const ids = new Set(madeIds);
  for (const root of roots) {
    const read = await record(root).catch(() => null);
    if (read) ids.add(read.id);
  }
  restart();
  if (scenario === 'working') {
    for (const id of ids) await forget(id);
    const { systemKeyStore } = await modules();
    const store = await systemKeyStore.detectSystemKeyStore();
    for (const id of ids) {
      if (store && store.kind !== 'windows') expect(await store.load(id, undefined)).toBeNull();
    }
    systemKeyStore.setSystemKeyStoreForTests(undefined);
  }
  for (const [key, value] of [['FLUJO_DATA_DIR', previous.dataDir], ['FLUJO_SYSTEM_KEY_STORE', previous.storeSetting]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  restart();
  await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true })));
});

if (!scenario) {
  it('never reaches the real key store in ordinary test runs (scripts/check-system-key-store.mjs does)', async () => {
    expect(process.env.FLUJO_SYSTEM_KEY_STORE).toBe('off');
    const { systemKeyStore } = await modules();
    expect(await systemKeyStore.detectSystemKeyStore()).toBeNull();
  });
} else if (!SCENARIOS.includes(scenario) || (scenario !== 'working' && expected !== 'linux')) {
  it('names a situation this computer can show', () => {
    throw new Error(`FLUJO_TEST_REAL_SYSTEM_KEY=${scenario} is not one of ${SCENARIOS.join(', ')} for ${process.platform}`);
  });
}

if (scenario === 'working') {
  describe(`a working ${expected} key store`, () => {
    it('is found and keeps a key under its id, replacing it on a second save', async () => {
      await newDataFolder();
      const { systemKeyStore } = await modules();
      const store = (await systemKeyStore.detectSystemKeyStore())!;
      expect(store?.kind).toBe(expected);
      const id = randomUUID();
      madeIds.add(id);
      // A key that starts with "-" must not be read as an option by the store's tool.
      const first = `-${randomBytes(32).toString('base64url')}`;
      const firstCopy = await store.save(id, first);
      expect(await store.load(id, firstCopy)).toBe(first);
      const second = randomBytes(32).toString('base64url');
      const secondCopy = await store.save(id, second);
      expect(await store.load(id, secondCopy)).toBe(second);
      if (store.kind === 'windows') {
        expect(secondCopy).toEqual(expect.any(String));
        expect(secondCopy).not.toContain(second);
        await expect(store.load(randomUUID(), secondCopy)).rejects.toBeInstanceOf(systemKeyStore.SystemKeyUnreadableError);
      } else {
        expect(secondCopy).toBeUndefined();
        expect(await store.load(randomUUID(), undefined)).toBeNull();
      }
    });

    it('protects a fresh install, keeps the key out of the data folder and opens it again after a restart', async () => {
      const root = await newDataFolder();
      const { secure, systemKey } = await modules();
      const ciphertext = (await secure.encryptWithPassword('sk-real-fresh'))!;
      expect(await keyFile()).toMatchObject({ encryption_type: 'user', key_protection: 'os-store', encryption_version: 2 });
      expect(await secure.getEncryptionStatus()).toMatchObject({
        initialized: true, locked: false, protection: 'os-store',
        systemKey: { available: expected, keptIn: expected, recoveryKeySaved: false, problem: null },
      });
      const secret = (await systemKey.getSystemSecret())!;
      for (const file of await filesUnder(root)) expect(await fs.readFile(file, 'utf8')).not.toContain(secret);

      restart();
      const after = await modules();
      expect(await after.secure.isEncryptionLocked()).toBe(false);
      expect(await after.secure.decryptWithPassword(ciphertext)).toBe('sk-real-fresh');
      const rotated = (await after.secure.encryptWithPassword('sk-real-fresh-rotated'))!;
      expect(await after.secure.decryptWithPassword(rotated)).toBe('sk-real-fresh-rotated');
      expect(await after.secure.decryptWithPassword(ciphertext)).toBe('sk-real-fresh');
    });

    it('moves an existing install under the store with a sealed backup, keeping every secret readable', async () => {
      const root = await newDataFolder();
      const plain = await modules(null);
      await seedLegacyDefault();
      const ciphertext = (await plain.secure.encryptWithPassword('sk-real-existing'))!;
      const before = await fs.readFile(path.join(await dbDir(), 'encryption_key.json'));

      restart();
      const { secure, systemKey } = await modules();
      expect(await secure.getEncryptionStatus()).toMatchObject({ protection: 'os-store', locked: false });
      expect((await keyFile()).key_id).toBe(JSON.parse(before.toString('utf8')).key_id);
      expect(await secure.decryptWithPassword(ciphertext)).toBe('sk-real-existing');
      const backups = await fs.readdir(path.join(root, 'keys', 'before-system-key'));
      expect(backups).toHaveLength(1);
      const backup = path.join(root, 'keys', 'before-system-key', backups[0]);
      expect((await systemKey.openKeyFileBackup(backup, (await systemKey.getSystemSecret())!)).equals(before)).toBe(true);

      restart();
      const after = await modules();
      expect(await after.secure.isEncryptionLocked()).toBe(false);
      expect(await after.secure.decryptWithPassword(ciphertext)).toBe('sk-real-existing');
    });

    it('replaces the data key, starting from the key in the store, and re-encrypts saved credentials', async () => {
      await newDataFolder();
      const { secure, migration } = await modules();
      const ciphertext = (await secure.encryptWithPassword('sk-real-rotate'))!;
      const models = path.join(await dbDir(), 'models.json');
      await fs.writeFile(models, JSON.stringify([{ id: 'real-store', ApiKey: `encrypted:${ciphertext}` }]), { mode: 0o600 });
      const before = await keyFile();

      const options = { recoveryPassphrase: 'owner-chosen-password-1443', retireActiveKey: true };
      const plan = await migration.preflightCredentialMigration(options);
      expect(plan.activeKeyWillChange).toBe(true);
      expect(await migration.migrateCredentials(options, plan.planToken)).toMatchObject({ status: 'committed', protection: 'passphrase' });
      const after = await keyFile();
      expect(after).toMatchObject({ key_protection: 'passphrase' });
      expect(after.key_id).not.toBe(before.key_id);

      restart();
      const reopened = await modules();
      expect(await reopened.secure.isEncryptionLocked()).toBe(true);
      expect((await reopened.secure.verifyPassword(options.recoveryPassphrase)).valid).toBe(true);
      const [model] = JSON.parse(await fs.readFile(models, 'utf8')) as Array<{ ApiKey: string }>;
      expect(model.ApiKey).not.toBe(`encrypted:${ciphertext}`);
      expect(await reopened.secure.decryptWithPassword(model.ApiKey.slice('encrypted:'.length))).toBe('sk-real-rotate');
    });

    it('opens with the recovery key when the store lost the key, and puts the key back into the store', async () => {
      const root = await newDataFolder();
      const { secure, systemKey, systemKeyStore } = await modules();
      const ciphertext = (await secure.encryptWithPassword('sk-real-recovery'))!;
      const recoveryKey = (await systemKey.getSystemSecret())!;
      const { id } = await record();
      await loseKey((await systemKeyStore.detectSystemKeyStore())!, root);

      restart();
      const lost = await modules();
      const status = await lost.secure.getEncryptionStatus();
      expect(status).toMatchObject({ protection: 'os-store', locked: true });
      expect(status.systemKey?.problem).toMatch(/no longer has FLUJO's key/);
      expect((await lost.secure.verifyPassword('not the recovery key')).valid).toBe(false);
      expect((await lost.secure.verifyPassword(recoveryKey.replace(/(.{8})/g, '$1 '))).valid).toBe(true);
      expect(await lost.secure.decryptWithPassword(ciphertext)).toBe('sk-real-recovery');
      const restored = await record();
      expect(restored).toMatchObject({ id, store: expected, recoveryKeySavedAt: expect.any(Number) });
      const store = (await lost.systemKeyStore.detectSystemKeyStore())!;
      expect(await store.load(restored.id, restored.protectedCopy)).toBe(recoveryKey);

      restart();
      const after = await modules();
      expect(await after.secure.isEncryptionLocked()).toBe(false);
      expect(await after.secure.decryptWithPassword(ciphertext)).toBe('sk-real-recovery');
    });

    it("re-protects a workspace restored from another FLUJO with this computer's key", async () => {
      await newDataFolder();
      const other = await modules();
      const ciphertext = (await other.secure.encryptWithPassword('sk-real-restored'))!;
      const otherKey = (await other.systemKey.getSystemSecret())!;
      const restoredKeyFile = JSON.stringify(await keyFile());

      await newDataFolder();
      const own = await modules();
      const ownKey = (await own.systemKey.getSystemSecret({ create: true }))!;
      expect(ownKey).not.toBe(otherKey);
      await fs.mkdir(await dbDir(), { recursive: true });
      await fs.writeFile(path.join(await dbDir(), 'encryption_key.json'), restoredKeyFile);
      expect(await own.secure.isEncryptionLocked()).toBe(true);
      expect((await own.secure.verifyPassword(otherKey)).valid).toBe(true);
      expect(await own.secure.decryptWithPassword(ciphertext)).toBe('sk-real-restored');

      restart();
      const after = await modules();
      expect(await after.secure.isEncryptionLocked()).toBe(false);
      expect(await after.secure.decryptWithPassword(ciphertext)).toBe('sk-real-restored');
    });
  });
}

if (scenario === 'locked' && expected === 'linux') {
  describe('a locked Linux keyring', () => {
    it('is reported as locked, never as a lost key, and the recovery key still opens the credentials', async () => {
      await newDataFolder();
      const { secure, systemKey } = await modules();
      const ciphertext = (await secure.encryptWithPassword('sk-real-locked'))!;
      const recoveryKey = (await systemKey.getSystemSecret())!;
      const before = await record();
      await execFileAsync('dbus-send', ['--session', '--dest=org.freedesktop.secrets', '--print-reply', '/org/freedesktop/secrets',
        'org.freedesktop.Secret.Service.Lock', 'array:objpath:/org/freedesktop/secrets/collection/login'], { timeout: 30_000 });

      restart();
      const locked = await modules();
      const status = await locked.secure.getEncryptionStatus();
      expect(status).toMatchObject({ protection: 'os-store', locked: true });
      expect(status.systemKey?.problem).toMatch(/did not hand over FLUJO's key just now/);
      expect(status.systemKey?.problem).not.toMatch(/no longer has|password reset/);
      expect(status.systemKey?.retryAt).toEqual(expect.any(Number));
      await expect(locked.secure.decryptWithPassword(ciphertext)).rejects.toThrow(/recovery key/);
      expect((await locked.secure.verifyPassword(recoveryKey)).valid).toBe(true);
      expect(await locked.secure.decryptWithPassword(ciphertext)).toBe('sk-real-locked');
      expect(await record()).toEqual(before);
    });
  });
}

if ((scenario === 'unavailable' || scenario === 'absent') && expected === 'linux') {
  describe(scenario === 'absent' ? 'no desktop session and no keyring' : 'a desktop session without a keyring service', () => {
    it(scenario === 'absent' ? 'finds no key store' : 'finds the keyring tool, which says it cannot be reached', async () => {
      await newDataFolder();
      const { systemKeyStore } = await modules();
      const store = await systemKeyStore.detectSystemKeyStore();
      if (scenario === 'absent') { expect(store).toBeNull(); return; }
      expect(store?.kind).toBe('linux');
      const id = randomUUID();
      await expect(store!.save(id, randomBytes(32).toString('base64url'))).rejects.toBeInstanceOf(systemKeyStore.SystemKeyStoreUnavailableError);
      await expect(store!.load(id, undefined)).rejects.toBeInstanceOf(systemKeyStore.SystemKeyStoreUnavailableError);
    });

    it('keeps basic protection on a fresh install, at once, and says so', async () => {
      await newDataFolder();
      const { secure } = await modules();
      const started = Date.now();
      const ciphertext = (await secure.encryptWithPassword('sk-real-basic'))!;
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(await keyFile()).toMatchObject({ encryption_type: 'default' });
      expect(await secure.decryptWithPassword(ciphertext)).toBe('sk-real-basic');
      const status = await secure.getEncryptionStatus();
      expect(status).toMatchObject({ initialized: true, locked: false, protection: 'legacy-default' });
      if (scenario === 'absent') expect(status).not.toHaveProperty('systemKey');
      else expect(status.systemKey).toMatchObject({ available: 'linux', keptIn: null, problem: null });
    });

    it('keeps a keyring-protected workspace closed with a plain note, opens it with the recovery key and never replaces the key', async () => {
      await newDataFolder();
      const kept = new Map<string, string>();
      const desktop: SystemKeyStore = {
        kind: 'linux',
        async save(id, secret) { kept.set(id, secret); return undefined; },
        async load(id) { return kept.get(id) ?? null; },
      };
      const made = await modules(desktop);
      const ciphertext = (await made.secure.encryptWithPassword('sk-real-elsewhere'))!;
      const recoveryKey = (await made.systemKey.getSystemSecret())!;
      const before = await record();

      restart();
      const here = await modules();
      const status = await here.secure.getEncryptionStatus();
      expect(status).toMatchObject({ protection: 'os-store', locked: true });
      expect(status.systemKey?.problem).toMatch(/did not hand over FLUJO's key just now.*recovery key/);
      expect((await here.secure.verifyPassword(recoveryKey)).valid).toBe(true);
      expect(await here.secure.decryptWithPassword(ciphertext)).toBe('sk-real-elsewhere');
      expect(await record()).toEqual(before);

      restart();
      const again = await modules();
      expect(await again.secure.isEncryptionLocked()).toBe(true);
      await expect(again.systemKey.getSystemSecret({ create: true })).rejects.toThrow(/recovery key/);
      expect(await record()).toEqual(before);
    });
  });
}
