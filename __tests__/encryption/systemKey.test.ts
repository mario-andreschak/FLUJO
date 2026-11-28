/**
 * The system key (#1443): the key that protects saved credentials is wrapped
 * by a secret kept in the operating system's protected store, set up on a
 * fresh install and moved to automatically on existing ones. These drive the
 * real crypto and storage code in a throwaway data folder with a fake store;
 * the real Windows store is covered by systemKeyWindows.test.ts (opt-in).
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { StorageKey } from '@/shared/types/storage';
import type { EncryptionMetadata } from '@/utils/encryption/format';
import type { SystemKeyStore, SystemKeyStoreKind } from '@/utils/encryption/systemKeyStore';
import { seedLegacyDefault } from './fixtures/legacyDefault';

jest.setTimeout(120_000);

let root: string;
let previousDataDir: string | undefined;

type Mode = 'ok' | 'unavailable' | 'lost';

/** In-memory stand-in for Windows data protection / Keychain / keyring. */
function fakeStore(kind: SystemKeyStoreKind = 'windows') {
  const entries = new Map<string, string>();
  const state = { mode: 'ok' as Mode, saves: 0, loads: 0 };
  const errors = () => import('@/utils/encryption/systemKeyStore');
  const store: SystemKeyStore = {
    kind,
    async save(id, secret) {
      const { SystemKeyStoreUnavailableError } = await errors();
      if (state.mode === 'unavailable') throw new SystemKeyStoreUnavailableError(kind, 'test store is down');
      state.saves++;
      entries.set(id, secret);
      return kind === 'windows' ? Buffer.from(`fake-dpapi:${id}:${secret}`).toString('base64') : undefined;
    },
    async load(id, protectedCopy) {
      const { SystemKeyStoreUnavailableError, SystemKeyUnreadableError } = await errors();
      state.loads++;
      if (state.mode === 'unavailable') throw new SystemKeyStoreUnavailableError(kind, 'test store is down');
      if (state.mode === 'lost') {
        if (kind === 'windows') throw new SystemKeyUnreadableError(kind);
        return null;
      }
      if (kind !== 'windows') return entries.get(id) ?? null;
      if (!protectedCopy) return null;
      const [label, copyId, secret] = Buffer.from(protectedCopy, 'base64').toString('utf8').split(':');
      if (label !== 'fake-dpapi' || copyId !== id || entries.get(id) !== secret) throw new SystemKeyUnreadableError(kind);
      return secret;
    },
  };
  return { store, entries, state };
}

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

async function modules(store?: SystemKeyStore | null) {
  jest.resetModules();
  const systemKeyStore = await import('@/utils/encryption/systemKeyStore');
  if (store !== undefined) systemKeyStore.setSystemKeyStoreForTests(store);
  return {
    secure: await import('@/utils/encryption/secure'),
    systemKey: await import('@/utils/encryption/systemKey'),
    format: await import('@/utils/encryption/format'),
    storage: await import('@/utils/storage/backend'),
    systemKeyStore,
  };
}

async function keyFilePath(): Promise<string> {
  return path.join((await import('@/utils/workspace')).getWorkspaceDbDir(), 'encryption_key.json');
}

async function metadata(): Promise<EncryptionMetadata> {
  return JSON.parse(await fs.readFile(await keyFilePath(), 'utf8'));
}

async function record(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(root, 'keys', 'system-key.json'), 'utf8'));
}

beforeEach(async () => {
  previousDataDir = process.env.FLUJO_DATA_DIR;
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-system-key-'));
  process.env.FLUJO_DATA_DIR = root;
  restart();
});

afterEach(async () => {
  jest.restoreAllMocks();
  (await import('@/utils/encryption/systemKeyStore')).setSystemKeyStoreForTests(undefined);
  restart();
  if (previousDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
  else process.env.FLUJO_DATA_DIR = previousDataDir;
  await fs.rm(root, { recursive: true, force: true });
});

describe('fresh install', () => {
  it('protects a new key with the system key and never writes the key beside the data', async () => {
    const fake = fakeStore();
    const { secure, format } = await modules(fake.store);
    const ciphertext = (await secure.encryptWithPassword('sk-fresh-secret'))!;
    const stored = await metadata();
    expect(stored).toMatchObject({ encryption_type: 'user', key_protection: 'os-store', encryption_version: 2 });
    const [secret] = [...fake.entries.values()];
    expect(JSON.stringify(stored)).not.toContain(secret);
    await expect(format.unwrapKeyring(stored, format.DEFAULT_PASSWORD)).rejects.toThrow();
    expect(await secure.decryptWithPassword(ciphertext)).toBe('sk-fresh-secret');
    expect(await secure.getEncryptionStatus()).toMatchObject({
      initialized: true, locked: false, protection: 'os-store',
      systemKey: { available: 'windows', keptIn: 'windows', recoveryKeySaved: false, problem: null },
    });

    restart();
    const after = await modules(fake.store);
    expect(await after.secure.decryptWithPassword(ciphertext)).toBe('sk-fresh-secret');
  });

  it('keeps today\'s protection where the computer offers no system store', async () => {
    const { secure } = await modules(null);
    const ciphertext = (await secure.encryptWithPassword('sk-plain-install'))!;
    expect(await metadata()).toMatchObject({ encryption_type: 'default' });
    expect(await secure.decryptWithPassword(ciphertext)).toBe('sk-plain-install');
    const status = await secure.getEncryptionStatus();
    expect(status).toMatchObject({ protection: 'legacy-default', locked: false });
    expect(status).not.toHaveProperty('systemKey');
  });

  it('falls back to today\'s protection, without blocking, when the store does not answer', async () => {
    const fake = fakeStore();
    fake.state.mode = 'unavailable';
    const { secure } = await modules(fake.store);
    const ciphertext = (await secure.encryptWithPassword('sk-store-down'))!;
    expect(await metadata()).toMatchObject({ encryption_type: 'default' });
    expect(await secure.decryptWithPassword(ciphertext)).toBe('sk-store-down');
  });

  it('elects one system key when two processes create it at the same time', async () => {
    const fake = fakeStore('macos');
    const { systemKey } = await modules(fake.store);
    const first = systemKey.getSystemSecret({ create: true });
    global.__flujo_system_key = undefined; // a second process with its own memory
    const second = systemKey.getSystemSecret({ create: true });
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect((await record()).store).toBe('macos');
  });
});

describe('existing installs move automatically', () => {
  it('moves a default-protected key to the system key, keeps every secret readable and keeps a sealed backup', async () => {
    const plain = await modules(null);
    await seedLegacyDefault();
    const ciphertext = (await plain.secure.encryptWithPassword('sk-existing-secret'))!;
    const before = await fs.readFile(await keyFilePath());

    const fake = fakeStore();
    const { secure, systemKey, format } = await modules(fake.store);
    expect(await secure.getEncryptionStatus()).toMatchObject({ protection: 'os-store', locked: false });
    const moved = await metadata();
    expect(moved.key_id).toBe(JSON.parse(before.toString('utf8')).key_id);
    await expect(format.unwrapKeyring(moved, format.DEFAULT_PASSWORD)).rejects.toThrow();
    expect(await secure.decryptWithPassword(ciphertext)).toBe('sk-existing-secret');

    const backups = await fs.readdir(path.join(root, 'keys', 'before-system-key'));
    expect(backups).toHaveLength(1);
    const backupFile = path.join(root, 'keys', 'before-system-key', backups[0]);
    expect(await fs.readFile(backupFile, 'utf8')).not.toContain(before.toString('base64'));
    const secret = (await systemKey.getSystemSecret())!;
    expect((await systemKey.openKeyFileBackup(backupFile, secret)).equals(before)).toBe(true);

    restart();
    const after = await modules(fake.store);
    expect(await after.secure.decryptWithPassword(ciphertext)).toBe('sk-existing-secret');
    expect(await after.secure.isEncryptionLocked()).toBe(false);
  });

  it('moves on the first secret read too, not only from the status page', async () => {
    const plain = await modules(null);
    await seedLegacyDefault();
    const ciphertext = (await plain.secure.encryptWithPassword('sk-read-first'))!;
    const { secure } = await modules(fakeStore().store);
    expect(await secure.decryptWithPassword(ciphertext)).toBe('sk-read-first');
    expect((await metadata()).key_protection).toBe('os-store');
  });

  it('heals after a crash between the backup and the new key file', async () => {
    const plain = await modules(null);
    await seedLegacyDefault();
    const ciphertext = (await plain.secure.encryptWithPassword('sk-crash'))!;
    const fake = fakeStore();
    const crashed = await modules(fake.store);
    const secret = (await crashed.systemKey.getSystemSecret({ create: true }))!;
    const keyFile = await fs.readFile(await keyFilePath());
    await crashed.systemKey.backupKeyFileBeforeMove((await import('@/utils/workspace')).getCurrentWorkspace(), keyFile, secret);
    expect((await metadata()).encryption_type).toBe('default');

    restart();
    const { secure } = await modules(fake.store);
    expect(await secure.decryptWithPassword(ciphertext)).toBe('sk-crash');
    expect((await metadata()).key_protection).toBe('os-store');
    expect(await fs.readdir(path.join(root, 'keys', 'before-system-key'))).toHaveLength(1);
  });

  it('leaves password, operator and worker setups alone', async () => {
    const { secure } = await modules(fakeStore().store);
    expect(await secure.initializeEncryption('owner-password-123')).toBe(true);
    expect(await secure.getEncryptionStatus()).toMatchObject({ protection: 'passphrase', locked: true });
    expect((await metadata()).key_protection).toBe('passphrase');
  });
});

describe('when the system store has a problem', () => {
  async function protectedInstall() {
    const fake = fakeStore();
    const loaded = await modules(fake.store);
    const ciphertext = (await loaded.secure.encryptWithPassword('sk-locked-secret'))!;
    const recoveryKey = (await loaded.systemKey.getSystemSecret())!;
    return { fake, ciphertext, recoveryKey };
  }

  it('stays locked with a plain explanation, then opens by itself once the store answers again', async () => {
    const { fake, ciphertext } = await protectedInstall();
    restart();
    fake.state.mode = 'unavailable';
    const { secure } = await modules(fake.store);
    const status = await secure.getEncryptionStatus();
    expect(status).toMatchObject({ protection: 'os-store', locked: true });
    expect(status.systemKey?.problem).toMatch(/keeps trying on its own.*recovery key/);
    await expect(secure.decryptWithPassword(ciphertext)).rejects.toThrow(/recovery key/);

    fake.state.mode = 'ok';
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    expect(await secure.isEncryptionLocked()).toBe(false);
    expect(await secure.decryptWithPassword(ciphertext)).toBe('sk-locked-secret');
  });

  it('opens with the recovery key when the store lost the key, and puts the key back', async () => {
    const { fake, ciphertext, recoveryKey } = await protectedInstall();
    restart();
    fake.state.mode = 'lost';
    const { secure } = await modules(fake.store);
    const status = await secure.getEncryptionStatus();
    expect(status.locked).toBe(true);
    expect(status.systemKey?.problem).toMatch(/password reset/);
    expect((await secure.verifyPassword('not the key')).valid).toBe(false);

    fake.state.mode = 'ok';
    fake.entries.clear();
    const spaced = recoveryKey.replace(/(.{8})/g, '$1 ');
    expect((await secure.verifyPassword(spaced)).valid).toBe(true);
    expect(await secure.decryptWithPassword(ciphertext)).toBe('sk-locked-secret');
    expect([...fake.entries.values()]).toEqual([recoveryKey]);
    expect((await record()).recoveryKeySavedAt).toEqual(expect.any(Number));

    restart();
    const after = await modules(fake.store);
    expect(await after.secure.isEncryptionLocked()).toBe(false);
    expect(await after.secure.decryptWithPassword(ciphertext)).toBe('sk-locked-secret');
  });

  it('never replaces a lost key with a new one, even when the record is damaged', async () => {
    const { fake, recoveryKey } = await protectedInstall();
    restart();
    await fs.writeFile(path.join(root, 'keys', 'system-key.json'), '{ damaged');
    const { secure, systemKey } = await modules(fake.store);
    expect(await secure.isEncryptionLocked()).toBe(true);
    await expect(systemKey.getSystemSecret({ create: true })).rejects.toThrow(/recovery key/);
    expect(fake.state.saves).toBe(1);
    expect((await secure.verifyPassword(recoveryKey)).valid).toBe(true);
    expect((await record()).store).toBe('windows');
  });

  it('re-protects a workspace restored from another FLUJO once its recovery key opens it', async () => {
    const other = await protectedInstall();
    const restored = await metadata();
    const restoredFile = await keyFilePath();

    // This computer's own FLUJO: a different data folder and system key.
    restart();
    await fs.rm(path.join(root, 'keys'), { recursive: true, force: true });
    const own = fakeStore();
    const { secure, systemKey } = await modules(own.store);
    const ownKey = (await systemKey.getSystemSecret({ create: true }))!;
    expect(ownKey).not.toBe(other.recoveryKey);
    await fs.writeFile(restoredFile, JSON.stringify(restored));
    expect(await secure.isEncryptionLocked()).toBe(true);
    expect((await secure.verifyPassword(other.recoveryKey)).valid).toBe(true);
    expect(await secure.decryptWithPassword(other.ciphertext)).toBe('sk-locked-secret');

    restart();
    const after = await modules(own.store);
    expect(await after.secure.isEncryptionLocked()).toBe(false);
    expect(await after.secure.decryptWithPassword(other.ciphertext)).toBe('sk-locked-secret');
  });

  it('sends a password change through the migration that can replace a once-public key', async () => {
    const { secure } = await (async () => { await protectedInstall(); return modules(); })();
    await expect(secure.changeEncryptionPassword('', 'a-new-password-123')).rejects.toThrow(/migration/i);
  });

  it('captures worker snapshots with the keyring bound to the key file', async () => {
    await protectedInstall();
    const { secure, format } = await modules();
    const captured = await metadata();
    const serialized = await secure.getSystemKeyWorkerBootstrapKey(captured);
    const ring = format.parseSessionKey(serialized);
    expect('activeKey' in ring && format.keyId(ring)).toBe(captured.key_id);
    expect('metadataRevision' in ring && ring.metadataRevision).toBe(format.metadataRevision(captured));
  });
});

describe('Settings route for the recovery key', () => {
  function post(body: unknown) {
    return new NextRequest('http://localhost:4200/api/encryption/system-key', {
      method: 'POST', headers: { host: 'localhost:4200', 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  }

  it('shows the recovery key on this computer and remembers that it was saved', async () => {
    const fake = fakeStore();
    const { secure, systemKey } = await modules(fake.store);
    await secure.encryptWithPassword('sk-route');
    const route = await import('@/app/api/encryption/system-key/route');
    const reveal = await route.POST(post({ action: 'reveal' }));
    expect(reveal.status).toBe(200);
    expect(reveal.headers.get('cache-control')).toBe('no-store');
    expect((await reveal.json()).recoveryKey).toBe(await systemKey.getSystemSecret());

    expect((await (await route.POST(post({ action: 'saved' }))).json()).saved).toBe(true);
    expect((await secure.getEncryptionStatus()).systemKey?.recoveryKeySaved).toBe(true);

    const remote = new NextRequest('http://192.168.1.20:4200/api/encryption/system-key', {
      method: 'POST', headers: { host: '192.168.1.20:4200' }, body: JSON.stringify({ action: 'reveal' }),
    });
    expect((await route.POST(remote)).status).toBe(403);
  });

  it('remembers the saved recovery key while a reader briefly holds the key record', async () => {
    const fake = fakeStore();
    const { secure, systemKey } = await modules(fake.store);
    await secure.encryptWithPassword('sk-held-record');
    const realRename = fs.rename.bind(fs);
    let held = 0;
    jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('system-key.json') && held < 3) {
        held += 1;
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      }
      return realRename(from, to);
    });
    await expect(systemKey.markRecoveryKeySaved()).resolves.toBe(true);
    expect(held).toBe(3);
    expect(typeof (await record()).recoveryKeySavedAt).toBe('number');
  });

  it('refuses while the credentials are locked', async () => {
    const fake = fakeStore();
    const first = await modules(fake.store);
    await first.secure.encryptWithPassword('sk-route-locked');
    restart();
    fake.state.mode = 'unavailable';
    await modules(fake.store);
    const route = await import('@/app/api/encryption/system-key/route');
    expect((await route.POST(post({ action: 'reveal' }))).status).toBe(423);
  });
});

it('keeps the key file format strict: only known protections are accepted', async () => {
  const { format } = await modules(null);
  expect(format.KEY_PROTECTIONS).toEqual(['passphrase', 'operator-file', 'os-store']);
  const ring = format.newKeyring();
  const wrapped = await format.wrapKeyring(ring, 'user', 'x'.repeat(43), 'os-store');
  expect(format.keyId(await format.unwrapKeyring(wrapped, 'x'.repeat(43)))).toBe(format.keyId(ring));
  await expect(format.unwrapKeyring({ ...wrapped, key_protection: 'passphrase' }, 'x'.repeat(43))).rejects.toThrow();
  expect(StorageKey.ENCRYPTION_KEY).toBe('encryption_key');
});
