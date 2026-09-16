import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import CryptoJS from 'crypto-js';
import { StorageKey } from '@/shared/types/storage';
import type { EncryptionMetadata } from '@/utils/encryption/format';

jest.setTimeout(60_000);
let root: string;
let previousDataDir: string | undefined;

async function modules() {
  jest.resetModules();
  return {
    secure: await import('@/utils/encryption/secure'),
    session: await import('@/utils/encryption/session'),
    storage: await import('@/utils/storage/backend'),
    format: await import('@/utils/encryption/format'),
  };
}
function restart() {
  global.__flujo_server_dek = undefined;
  global.__flujo_encryption_sessions = undefined;
  global.__flujo_server_deks_by_workspace = undefined;
  global.__flujo_encryption_sessions_by_workspace = undefined;
  global.__flujo_encryption_metadata_locks = undefined;
}
beforeEach(async () => {
  previousDataDir = process.env.FLUJO_DATA_DIR;
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-crypto-v2-'));
  process.env.FLUJO_DATA_DIR = root;
  restart();
});
afterEach(async () => {
  jest.restoreAllMocks();
  restart();
  if (previousDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
  else process.env.FLUJO_DATA_DIR = previousDataDir;
  await fs.rm(root, { recursive: true, force: true });
});

/** Independent fixture from the shipped CryptoJS v1 implementation. */
function legacyFixture(password?: string) {
  const secret = 'legacy-token:with-unicode-\u00e9';
  const generatedKey = CryptoJS.enc.Hex.parse('0123456789abcdef');
  const effectiveKey = CryptoJS.enc.Utf8.parse(generatedKey.toString());
  const salt = password ? CryptoJS.lib.WordArray.random(16) : CryptoJS.enc.Utf8.parse('flujo_fixed_salt_v1');
  const wrapping = CryptoJS.PBKDF2(password ?? 'FLUJO~', salt, { keySize: 8, iterations: 100_000 });
  const iv = CryptoJS.lib.WordArray.random(16);
  const dataIv = CryptoJS.lib.WordArray.random(16);
  const metadata: EncryptionMetadata = {
    encryption_version: 1, encryption_type: password ? 'user' : 'default',
    data_encryption_key: CryptoJS.AES.encrypt(generatedKey.toString(), wrapping, { iv }).toString(),
    data_encryption_iv: iv.toString(), data_encryption_salt: salt.toString(),
  };
  return {
    metadata, secret, effectiveKey: effectiveKey.toString(),
    ciphertext: `${dataIv}:${CryptoJS.AES.encrypt(secret, effectiveKey, { iv: dataIv })}`,
  };
}

it('keeps the data key stable through default-to-user migration and password changes', async () => {
  const { secure, session, storage, format } = await modules();
  expect(await secure.initializeDefaultEncryption()).toBe(true);
  const before = (await storage.loadItem<EncryptionMetadata | null>(StorageKey.ENCRYPTION_KEY, null))!;
  const ring = await format.unwrapKeyring(before, 'FLUJO~');
  expect(Buffer.from(ring.activeKey, 'hex')).toHaveLength(32);
  const ciphertext = (await secure.encryptWithPassword('preserved-secret'))!;
  expect(ciphertext).toMatch(/^v2:/);
  expect(await secure.migrateToUserEncryption('first-password')).toBe(true);
  expect(await secure.decryptWithPassword(ciphertext, 'first-password')).toBe('preserved-secret');
  expect(await secure.authenticate('first-password')).toBeTruthy();
  expect(await secure.changeEncryptionPassword('first-password', 'second-password')).toBe(true);
  const after = (await storage.loadItem<EncryptionMetadata | null>(StorageKey.ENCRYPTION_KEY, null))!;
  expect((await format.unwrapKeyring(after, 'second-password')).activeKey).toBe(ring.activeKey);
  session.lockServer();
  expect(await secure.authenticate('first-password')).toBeNull();
  expect(await secure.authenticate('second-password')).toBeTruthy();
  expect(await secure.decryptWithPassword(ciphertext)).toBe('preserved-secret');
});

it.each(['default', 'user'])('upgrades %s v1 metadata, reads mixed ciphertext after restart and backup restore', async (type) => {
  const fixture = legacyFixture(type === 'user' ? 'old-password' : undefined);
  let { secure, session, storage, format } = await modules();
  await storage.saveItem(StorageKey.ENCRYPTION_KEY, fixture.metadata);
  if (type === 'user') expect(await secure.authenticate('old-password')).toBeTruthy();
  expect(await secure.decryptWithPassword(fixture.ciphertext)).toBe(fixture.secret);
  const modern = (await secure.encryptWithPassword('new-secret'))!;
  const upgraded = (await storage.loadItem<EncryptionMetadata | null>(StorageKey.ENCRYPTION_KEY, null))!;
  const ring = await format.unwrapKeyring(upgraded, type === 'user' ? 'old-password' : 'FLUJO~');
  expect(upgraded.encryption_version).toBe(2);
  expect(ring.legacyKey).toBe(fixture.effectiveKey);
  expect(Buffer.from(ring.activeKey, 'hex')).toHaveLength(32);
  const metadataFile = path.join(root, 'workspaces', 'default-workspace', 'db', 'encryption_key.json');
  const backup = await fs.readFile(metadataFile);
  restart();
  ({ secure, session, storage, format } = await modules());
  // Restore the on-disk metadata exactly as a workspace backup does.
  await fs.writeFile(metadataFile, backup);
  if (type === 'user') {
    expect(session.isServerLocked()).toBe(true);
    expect(await secure.authenticate('old-password')).toBeTruthy();
    expect(await secure.changeEncryptionPassword('old-password', 'new-password')).toBe(true);
    session.lockServer();
    expect(await secure.authenticate('new-password')).toBeTruthy();
  }
  expect(await secure.decryptWithPassword(fixture.ciphertext)).toBe(fixture.secret);
  expect(await secure.decryptWithPassword(modern)).toBe('new-secret');
  // A pre-upgrade backup remains independently readable with its original password.
  restart();
  await storage.saveItem(StorageKey.ENCRYPTION_KEY, fixture.metadata);
  if (type === 'user') expect(await secure.authenticate('old-password')).toBeTruthy();
  expect(await secure.decryptWithPassword(fixture.ciphertext)).toBe(fixture.secret);
});

it('rejects modified ciphertext, nonce, tag and format version', async () => {
  const { secure } = await modules();
  await secure.initializeEncryption('password');
  await secure.authenticate('password');
  const ciphertext = (await secure.encryptWithPassword('authenticated-secret'))!;
  for (const index of [0, 1, 2, 3]) {
    const parts = ciphertext.split(':');
    parts[index] = (parts[index][0] === '0' ? '1' : '0') + parts[index].slice(1);
    expect(await secure.decryptWithPassword(parts.join(':'))).toBeNull();
  }
  expect(await secure.decryptWithPassword(ciphertext)).toBe('authenticated-secret');
});

it('rejects modified wrapping metadata and does not replace it on failure', async () => {
  const { secure, storage } = await modules();
  await secure.initializeEncryption('password');
  const metadata = (await storage.loadItem<EncryptionMetadata | null>(StorageKey.ENCRYPTION_KEY, null))!;
  for (const change of [
    { data_encryption_key: metadata.data_encryption_key.slice(0, -4) + 'AAAA' },
    { data_encryption_salt: '00'.repeat(16) },
    { key_id: '00'.repeat(32) },
    { kdf_iterations: 1 },
    { encryption_version: 99 },
  ]) {
    const altered = { ...metadata, ...change };
    await storage.saveItem(StorageKey.ENCRYPTION_KEY, altered);
    expect(await secure.authenticate('password')).toBeNull();
    expect(await secure.encryptWithPassword('must-not-be-saved', 'password')).toBeFalsy();
    expect(await storage.loadItem(StorageKey.ENCRYPTION_KEY, null)).toEqual(altered);
  }
});

it('does not rotate an initialized USER key when initialization is called again', async () => {
  const { secure, storage } = await modules();
  await secure.initializeEncryption('first');
  const metadata = await storage.loadItem(StorageKey.ENCRYPTION_KEY, null);
  expect(await secure.initializeEncryption('second')).toBe(false);
  expect(await storage.loadItem(StorageKey.ENCRYPTION_KEY, null)).toEqual(metadata);
  expect(await secure.authenticate('first')).toBeTruthy();
  expect(await secure.authenticate('second')).toBeNull();
});

it('serializes competing first writes so all ciphertext uses the committed key', async () => {
  const { secure } = await modules();
  const values = ['first', 'second', 'third'];
  const ciphertexts = await Promise.all(values.map(value => secure.encryptWithPassword(value)));
  restart();
  for (let index = 0; index < values.length; index++) {
    expect(await secure.decryptWithPassword(ciphertexts[index]!)).toBe(values[index]);
  }
});

it('retains complete legacy metadata if committing the upgrade fails', async () => {
  const fixture = legacyFixture('password');
  const { secure, storage } = await modules();
  await storage.saveItem(StorageKey.ENCRYPTION_KEY, fixture.metadata);
  const save = jest.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('simulated write failure'));
  expect(await secure.authenticate('password')).toBeNull();
  expect(await storage.loadItem(StorageKey.ENCRYPTION_KEY, null)).toEqual(fixture.metadata);
  save.mockRestore();
  expect(await secure.authenticate('password')).toBeTruthy();
  expect(await secure.decryptWithPassword(fixture.ciphertext)).toBe(fixture.secret);
});

it.each(['', '   \n\t', 'null', 'false', '0', '[]', '{}'])('never replaces existing invalid key metadata %j with a fresh key', async (invalid) => {
  const { secure } = await modules();
  const db = path.join(root, 'workspaces', 'default-workspace', 'db');
  await fs.mkdir(db, { recursive: true });
  const metadataFile = path.join(db, 'encryption_key.json');
  await fs.writeFile(metadataFile, invalid);
  expect(await secure.initializeDefaultEncryption()).toBe(false);
  expect(await secure.initializeEncryption('password')).toBe(false);
  expect(await secure.encryptWithPassword('must-not-be-saved')).toBeNull();
  expect(await fs.readFile(metadataFile, 'utf8')).toBe(invalid);
});
