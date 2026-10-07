import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { StorageKey } from '@/shared/types/storage';
import type { EncryptionMetadata } from '@/utils/encryption/format';

jest.setTimeout(60_000);
let root: string;
let data: string;
let secretFile: string;
let secret: string;
let saved: Record<string, string | undefined>;
function restart() {
  global.__flujo_server_dek = undefined;
  global.__flujo_encryption_sessions = undefined;
  global.__flujo_server_deks_by_workspace = undefined;
  global.__flujo_encryption_sessions_by_workspace = undefined;
  global.__flujo_encryption_metadata_locks = undefined;
}
async function modules() {
  jest.resetModules();
  return { secure: await import('@/utils/encryption/secure'), format: await import('@/utils/encryption/format'),
    storage: await import('@/utils/storage/backend') };
}
beforeEach(async () => {
  saved = { FLUJO_DATA_DIR: process.env.FLUJO_DATA_DIR,
    FLUJO_ENCRYPTION_SECRET_FILE: process.env.FLUJO_ENCRYPTION_SECRET_FILE };
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-private-encryption-'));
  data = path.join(root, 'data');
  await fs.mkdir(data);
  secretFile = path.join(root, 'operator-secret');
  secret = randomBytes(32).toString('base64url');
  await fs.writeFile(secretFile, `${secret}\n`, { mode: 0o600 });
  process.env.FLUJO_DATA_DIR = data;
  delete process.env.FLUJO_ENCRYPTION_SECRET_FILE;
  restart();
});
afterEach(async () => {
  jest.restoreAllMocks(); restart();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await fs.rm(root, { recursive: true, force: true });
});
test('fresh writes fail closed without a passphrase or independent operator secret, leaving no metadata', async () => {
  const { secure } = await modules();
  expect(await secure.initializeDefaultEncryption()).toBe(false);
  await expect(secure.encryptWithPassword('private-token')).rejects.toBeInstanceOf(secure.EncryptionLockedError);
  expect(await secure.isEncryptionInitialized()).toBe(false);
  expect(await secure.isEncryptionLocked()).toBe(true);
  expect(await secure.initializeEncryption('FLUJO~')).toBe(false);
  expect(await secure.isEncryptionInitialized()).toBe(false);
});
test('fresh passphrase profile survives restart, rejects the public password and requires unlock', async () => {
  let { secure, storage, format } = await modules();
  expect(await secure.initializeEncryption('independent-owner-passphrase')).toBe(true);
  const metadata = (await storage.loadItem<EncryptionMetadata | null>(StorageKey.ENCRYPTION_KEY, null))!;
  expect(metadata.key_protection).toBe('passphrase');
  await expect(format.unwrapKeyring(metadata, 'FLUJO~')).rejects.toThrow();
  await secure.authenticate('independent-owner-passphrase');
  const ciphertext = (await secure.encryptWithPassword('private-token'))!;
  restart(); ({ secure, storage, format } = await modules());
  await expect(secure.decryptWithPassword(ciphertext)).rejects.toBeInstanceOf(secure.EncryptionLockedError);
  expect(await secure.authenticate('independent-owner-passphrase')).toBeTruthy();
  expect(await secure.decryptWithPassword(ciphertext)).toBe('private-token');
  expect(await secure.changeEncryptionPassword('independent-owner-passphrase', 'FLUJO~')).toBe(false);
});
test('operator profile initializes with a separate secret and decrypts after restart without exposing it in data', async () => {
  process.env.FLUJO_ENCRYPTION_SECRET_FILE = secretFile;
  let { secure, storage, format } = await modules();
  expect(await secure.isEncryptionLocked()).toBe(false);
  const metadata = (await storage.loadItem<EncryptionMetadata | null>(StorageKey.ENCRYPTION_KEY, null))!;
  expect(metadata.key_protection).toBe('operator-file');
  expect(metadata.encryption_type).toBe('user');
  expect(JSON.stringify(metadata)).not.toContain(secret);
  await expect(format.unwrapKeyring(metadata, 'FLUJO~')).rejects.toThrow();
  const ciphertext = (await secure.encryptWithPassword('headless-private-token'))!;
  restart(); ({ secure, storage, format } = await modules());
  expect(await secure.isEncryptionLocked()).toBe(false);
  expect(await secure.decryptWithPassword(ciphertext)).toBe('headless-private-token');
  expect(await secure.verifyPassword(secret)).toEqual({ valid: false });
  expect(await secure.isUserEncryptionEnabled()).toBe(false);
});
test.each(['missing', 'changed'])('operator secret %s fails closed without rewriting ciphertext or key metadata', async variant => {
  process.env.FLUJO_ENCRYPTION_SECRET_FILE = secretFile;
  const { secure, storage } = await modules();
  const ciphertext = (await secure.encryptWithPassword('preserved-headless-token'))!;
  const before = await storage.loadItem(StorageKey.ENCRYPTION_KEY, null);
  if (variant === 'missing') await fs.unlink(secretFile);
  else await fs.writeFile(secretFile, randomBytes(32).toString('base64url'));
  expect(await secure.isEncryptionLocked()).toBe(true);
  expect(await secure.decryptWithPassword(ciphertext)).toBeNull();
  expect(await storage.loadItem(StorageKey.ENCRYPTION_KEY, null)).toEqual(before);
  await fs.writeFile(secretFile, secret, { mode: 0o600 });
  expect(await secure.decryptWithPassword(ciphertext)).toBe('preserved-headless-token');
});
test('removing authenticated protection metadata cannot turn operator ciphertext into a default profile', async () => {
  process.env.FLUJO_ENCRYPTION_SECRET_FILE = secretFile;
  const { secure, storage, format } = await modules();
  await secure.initializeDefaultEncryption();
  const metadata = (await storage.loadItem<EncryptionMetadata | null>(StorageKey.ENCRYPTION_KEY, null))!;
  const altered = { ...metadata }; delete altered.key_protection;
  await expect(format.unwrapKeyring(altered, secret)).rejects.toThrow();
  await storage.saveItem(StorageKey.ENCRYPTION_KEY, altered);
  expect(await secure.authenticate(secret)).toBeNull();
});
test.each(['inside-data', 'hardlink', 'parent-link', 'short', 'corrupt-utf8'])('rejects unsafe operator provisioning: %s', async variant => {
  let configured = secretFile;
  if (variant === 'inside-data') {
    configured = path.join(data, 'operator-secret'); await fs.writeFile(configured, secret, { mode: 0o600 });
  }
  if (variant === 'hardlink') await fs.link(secretFile, `${secretFile}.alias`);
  if (variant === 'parent-link') {
    const alias = path.join(root, 'linked');
    await fs.symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    configured = path.join(alias, 'operator-secret');
  }
  if (variant === 'short') await fs.writeFile(secretFile, 'FLUJO~');
  if (variant === 'corrupt-utf8') await fs.writeFile(secretFile, Buffer.from([0xff, 0xfe]));
  process.env.FLUJO_ENCRYPTION_SECRET_FILE = configured;
  const { secure } = await modules();
  expect(await secure.initializeDefaultEncryption()).toBe(false);
  expect(await secure.isEncryptionInitialized()).toBe(false);
});
test('decrypting without metadata never mints a replacement key even with an operator mount', async () => {
  process.env.FLUJO_ENCRYPTION_SECRET_FILE = secretFile;
  const { secure } = await modules();
  await expect(secure.decryptWithPassword('v2:missing-metadata')).rejects.toBeInstanceOf(secure.EncryptionLockedError);
  expect(await secure.isEncryptionInitialized()).toBe(false);
});
test('passphrase rotation revokes existing unlock tokens while preserving encrypted data', async () => {
  const { secure } = await modules();
  await secure.initializeEncryption('first-private-passphrase');
  const oldToken = (await secure.authenticate('first-private-passphrase'))!;
  const ciphertext = (await secure.encryptWithPassword('rotation-private-token'))!;
  expect(await secure.changeEncryptionPassword('first-private-passphrase', 'second-private-passphrase')).toBe(true);
  await expect(secure.decryptWithPassword(ciphertext, oldToken, true)).rejects.toBeInstanceOf(secure.EncryptionLockedError);
  expect(await secure.decryptWithPassword(ciphertext)).toBe('rotation-private-token');
  expect(await secure.authenticate('first-private-passphrase')).toBeNull();
  expect(await secure.authenticate('second-private-passphrase')).toBeTruthy();
});
test('cached unlock authority cannot bypass changed authenticated metadata or a removed profile marker', async () => {
  const { secure, storage } = await modules();
  await secure.initializeEncryption('private-metadata-passphrase');
  await secure.authenticate('private-metadata-passphrase');
  const ciphertext = (await secure.encryptWithPassword('metadata-private-token'))!;
  const metadata = (await storage.loadItem<EncryptionMetadata | null>(StorageKey.ENCRYPTION_KEY, null))!;
  for (const altered of [{ ...metadata, key_protection: undefined }, { ...metadata, data_encryption_salt: '00'.repeat(16) }]) {
    await storage.saveItem(StorageKey.ENCRYPTION_KEY, altered);
    expect(await secure.isEncryptionLocked()).toBe(true);
    await expect(secure.decryptWithPassword(ciphertext)).rejects.toBeInstanceOf(secure.EncryptionLockedError);
  }
  await storage.saveItem(StorageKey.ENCRYPTION_KEY, metadata);
  expect(await secure.decryptWithPassword(ciphertext)).toBe('metadata-private-token');
});
test('failed private metadata commit preserves the uninitialized state for a safe retry', async () => {
  process.env.FLUJO_ENCRYPTION_SECRET_FILE = secretFile;
  const { secure } = await modules();
  const rename = jest.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('synthetic interrupted commit'));
  expect(await secure.initializeDefaultEncryption()).toBe(false);
  expect(await secure.isEncryptionInitialized()).toBe(false);
  rename.mockRestore();
  expect(await secure.initializeDefaultEncryption()).toBe(true);
});
test('two fresh OS processes race initialization and a third independently recovers both ciphertexts', async () => {
  process.env.FLUJO_ENCRYPTION_SECRET_FILE = secretFile;
  const args = [path.join(__dirname, 'fixtures/private-profile-child.cjs'),
    path.resolve(__dirname, '../..'), require.resolve('typescript')];
  const env: NodeJS.ProcessEnv = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    NODE_ENV: 'test', FLUJO_DATA_DIR: data, FLUJO_ENCRYPTION_SECRET_FILE: secretFile };
  const values = ['synthetic-first-private-token', 'synthetic-second-private-token'];
  const children = values.map(value => {
    const child = spawn(process.execPath, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let stderr = '';
    const ready = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('READY_TO_COMMIT\n')) resolve(); });
      child.once('exit', code => { if (!output.includes('READY_TO_COMMIT\n')) reject(new Error(`Probe exited before barrier: ${code}`)); });
    });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const completed = new Promise<string>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => code === 0 && stderr === '' ? resolve(output) : reject(new Error('Private source process failed')));
    });
    child.stdin.write(`${JSON.stringify({ operation: 'mint', value })}\n`);
    return { child, ready, completed };
  });
  const timeout = setTimeout(() => { for (const item of children) item.child.kill(); }, 20_000);
  try {
    await Promise.all(children.map(item => item.ready));
    for (const item of children) item.child.stdin.write('commit\n');
    const output = await Promise.all(children.map(item => item.completed));
    const ciphertexts = output.map(value => JSON.parse(value.trim().split('\n').at(-1)!).ciphertext);
    const recovery = spawnSync(process.execPath, args, { env, windowsHide: true, encoding: 'utf8', timeout: 20_000,
      input: `${JSON.stringify({ operation: 'read', ciphertexts, expected: values })}\n`, maxBuffer: 64 * 1024 });
    expect(recovery.error).toBeUndefined(); expect(recovery.status).toBe(0); expect(recovery.stderr).toBe('');
    expect(JSON.parse(recovery.stdout.trim().split('\n').at(-1)!)).toEqual({ recovered: true });
  } finally {
    clearTimeout(timeout);
    for (const item of children) if (item.child.exitCode === null) item.child.kill();
  }
});
