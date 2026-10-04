import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { NextRequest } from 'next/server';

jest.mock('@/backend/init', () => ({ onUnlocked: jest.fn(async () => undefined) }));

jest.setTimeout(60_000);
let root: string;
let previousData: string | undefined;
let previousFile: string | undefined;
let secretFile: string;
const password = randomBytes(32).toString('hex');

function restart(): void {
  global.__flujo_server_dek = undefined;
  global.__flujo_encryption_sessions = undefined;
  global.__flujo_server_deks_by_workspace = undefined;
  global.__flujo_encryption_sessions_by_workspace = undefined;
  global.__flujo_encryption_metadata_locks = undefined;
  jest.resetModules();
}

async function modules() {
  return {
    secure: await import('@/utils/encryption/secure'),
    session: await import('@/utils/encryption/session'),
    format: await import('@/utils/encryption/format'),
    profile: await import('@/utils/encryption/privateProfile'),
    storage: await import('@/utils/storage/backend'),
    keys: (await import('@/shared/types/storage')).StorageKey,
  };
}

beforeEach(async () => {
  previousData = process.env.FLUJO_DATA_DIR;
  previousFile = process.env.FLUJO_ENCRYPTION_PASSPHRASE_FILE;
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-private-profile-'));
  process.env.FLUJO_DATA_DIR = path.join(root, 'data');
  delete process.env.FLUJO_ENCRYPTION_PASSPHRASE_FILE;
  secretFile = path.join(root, 'operator-passphrase');
  await fs.writeFile(secretFile, `${password}\n`, { mode: 0o600 });
  restart();
});

afterEach(async () => {
  restart();
  if (previousData === undefined) delete process.env.FLUJO_DATA_DIR;
  else process.env.FLUJO_DATA_DIR = previousData;
  if (previousFile === undefined) delete process.env.FLUJO_ENCRYPTION_PASSPHRASE_FILE;
  else process.env.FLUJO_ENCRYPTION_PASSPHRASE_FILE = previousFile;
  if (!path.isAbsolute(root) || !path.basename(root).startsWith('flujo-private-profile-')) throw new Error('Unsafe fixture cleanup');
  await fs.rm(root, { recursive: true, force: true });
});

test('fresh interactive setup refuses the public password and leaves no key metadata on denied writes', async () => {
  const { secure } = await modules();
  expect(await secure.isEncryptionLocked()).toBe(true);
  expect(await secure.initializeDefaultEncryption()).toBe(false);
  expect(await secure.initializeEncryption('FLUJO~')).toBe(false);
  await expect(secure.encryptWithPassword('synthetic-secret')).rejects.toBeInstanceOf(secure.EncryptionLockedError);
  expect(await secure.isEncryptionInitialized()).toBe(false);
  expect(await secure.getEncryptionStatus()).toEqual({ initialized: false, type: null,
    locked: true, recoveryRequired: false, protection: 'interactive' });
});

test('operator protection creates USER metadata, survives a restart and never unwraps with the public password', async () => {
  process.env.FLUJO_ENCRYPTION_PASSPHRASE_FILE = secretFile;
  let { secure, storage, keys, format } = await modules();
  expect(await secure.initializeDefaultEncryption()).toBe(true);
  const metadata = (await storage.loadItem<import('@/utils/encryption/format').EncryptionMetadata | null>(keys.ENCRYPTION_KEY, null))!;
  expect(metadata.encryption_type).toBe('user');
  expect(await secure.getEncryptionStatus()).toEqual({ initialized: true, type: 'user',
    locked: false, recoveryRequired: false, protection: 'operator' });
  await expect(format.unwrapKeyring(metadata, 'FLUJO~')).rejects.toThrow();
  const ciphertext = (await secure.encryptWithPassword('synthetic-restart-secret'))!;
  restart();
  ({ secure, storage, keys, format } = await modules());
  expect(await secure.isEncryptionLocked()).toBe(false);
  expect(await secure.decryptWithPassword(ciphertext)).toBe('synthetic-restart-secret');
  expect(await storage.loadItem(keys.ENCRYPTION_KEY, null)).toEqual(metadata);
});

test('concurrent first operator writes use one committed key', async () => {
  process.env.FLUJO_ENCRYPTION_PASSPHRASE_FILE = secretFile;
  let { secure } = await modules();
  const values = ['synthetic-one', 'synthetic-two', 'synthetic-three'];
  const results = await Promise.allSettled(values.map(value => secure.encryptWithPassword(value)));
  expect(results.every(result => result.status === 'fulfilled')).toBe(true);
  const ciphertexts = results.map(result => result.status === 'fulfilled' ? result.value : null);
  restart();
  ({ secure } = await modules());
  for (let index = 0; index < values.length; index++) {
    expect(await secure.decryptWithPassword(ciphertexts[index]!)).toBe(values[index]);
  }
});

test('two fresh OS processes serialize first-write metadata and retain both credentials', async () => {
  process.env.FLUJO_ENCRYPTION_PASSPHRASE_FILE = secretFile;
  const values = ['synthetic-process-one', 'synthetic-process-two'];
  const probe = (value: string) => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'private-profile-child.cjs'),
      path.resolve('src'), path.resolve('node_modules/typescript/lib/typescript.js')], { env: { ...process.env } });
    let output = '';
    let overflow = false;
    const timeout = setTimeout(() => { child.kill(); }, 25_000);
    child.stdout.on('data', chunk => {
      output += String(chunk);
      if (output.length > 65_536) { overflow = true; child.kill(); }
    });
    child.stderr.on('data', () => undefined);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => {
      clearTimeout(timeout);
      const result = /^SOURCE_RESULT:(.*)$/m.exec(output);
      if (code !== 0 || overflow || !result) { reject(new Error('Source process probe failed')); return; }
      const parsed: unknown = JSON.parse(result[1]);
      if (!parsed || typeof parsed !== 'object' || !('ciphertext' in parsed) || typeof parsed.ciphertext !== 'string') {
        reject(new Error('Invalid source process result')); return;
      }
      resolve(parsed.ciphertext);
    });
    child.stdin.end(JSON.stringify({ value }));
  });
  // Drain both processes before fixture cleanup, including a failed probe.
  const results = await Promise.allSettled(values.map(probe));
  expect(results.every(result => result.status === 'fulfilled')).toBe(true);
  restart();
  const { secure } = await modules();
  for (let index = 0; index < values.length; index++) {
    const result = results[index];
    if (result.status !== 'fulfilled') throw new Error('Source process probe failed');
    expect(await secure.decryptWithPassword(result.value)).toBe(values[index]);
  }
});

test('missing and replaced operator files clear server unlock, deny access and retain metadata', async () => {
  process.env.FLUJO_ENCRYPTION_PASSPHRASE_FILE = secretFile;
  const { secure, storage, keys, session } = await modules();
  expect(await secure.initializeDefaultEncryption()).toBe(true);
  const metadata = await storage.loadItem(keys.ENCRYPTION_KEY, null);
  const ciphertext = (await secure.encryptWithPassword('synthetic-retained-secret'))!;
  await fs.unlink(secretFile);
  expect(await secure.isEncryptionLocked()).toBe(true);
  expect(session.isServerLocked()).toBe(true);
  expect(await secure.getEncryptionStatus()).toEqual({ initialized: true, type: 'user',
    locked: true, recoveryRequired: false, protection: 'operator' });
  await expect(secure.decryptWithPassword(ciphertext)).rejects.toBeInstanceOf(secure.EncryptionLockedError);
  await fs.writeFile(secretFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  await expect(secure.encryptWithPassword('must-not-be-saved')).rejects.toBeInstanceOf(secure.EncryptionLockedError);
  expect(await storage.loadItem(keys.ENCRYPTION_KEY, null)).toEqual(metadata);
  await fs.writeFile(secretFile, password, { mode: 0o600 });
  expect(await secure.decryptWithPassword(ciphertext)).toBe('synthetic-retained-secret');
});

test('password rotation requires a matching operator-file update and preserves old ciphertext', async () => {
  process.env.FLUJO_ENCRYPTION_PASSPHRASE_FILE = secretFile;
  const { secure } = await modules();
  expect(await secure.initializeDefaultEncryption()).toBe(true);
  const ciphertext = (await secure.encryptWithPassword('synthetic-rotation-secret'))!;
  const replacement = randomBytes(32).toString('hex');
  expect(await secure.changeEncryptionPassword(password, 'FLUJO~')).toBe(false);
  expect(await secure.changeEncryptionPassword(password, replacement)).toBe(true);
  expect(await secure.isEncryptionLocked()).toBe(true);
  await fs.writeFile(secretFile, replacement, { mode: 0o600 });
  expect(await secure.decryptWithPassword(ciphertext)).toBe('synthetic-rotation-secret');
});

test('operator protection requires explicit migration of existing public metadata', async () => {
  const { secure, storage, keys } = await modules();
  await (await import('./fixtures')).seedExistingDefaultProfile();
  const ciphertext = (await secure.encryptWithPassword('synthetic-compatibility-secret'))!;
  const before = await storage.loadItem(keys.ENCRYPTION_KEY, null);
  process.env.FLUJO_ENCRYPTION_PASSPHRASE_FILE = secretFile;
  expect(await secure.initializeDefaultEncryption()).toBe(false);
  expect(await secure.isEncryptionLocked()).toBe(true);
  await expect(secure.encryptWithPassword('must-not-be-saved', password)).rejects.toBeInstanceOf(secure.EncryptionLockedError);
  expect(await storage.loadItem(keys.ENCRYPTION_KEY, null)).toEqual(before);
  expect(await secure.initializeEncryption(password)).toBe(true);
  expect(await secure.decryptWithPassword(ciphertext)).toBe('synthetic-compatibility-secret');
});

test.each(['blank', 'relative', 'same-data-tree', 'short', 'oversized', 'multiline', 'invalid-utf8'])('invalid operator input %s never creates metadata', async variant => {
  const { secure, profile } = await modules();
  let configured = secretFile;
  if (variant === 'blank') configured = '';
  if (variant === 'relative') configured = 'operator-passphrase';
  if (variant === 'same-data-tree') {
    configured = path.join(process.env.FLUJO_DATA_DIR!, 'passphrase');
    await fs.mkdir(path.dirname(configured), { recursive: true });
    await fs.writeFile(configured, password, { mode: 0o600 });
  }
  if (variant === 'short') await fs.writeFile(secretFile, 'x'.repeat(31));
  if (variant === 'oversized') await fs.writeFile(secretFile, 'x'.repeat(1027));
  if (variant === 'multiline') await fs.writeFile(secretFile, `${password}\n${password}`);
  if (variant === 'invalid-utf8') await fs.writeFile(secretFile, Buffer.from([0xff, ...Buffer.from(password)]));
  process.env.FLUJO_ENCRYPTION_PASSPHRASE_FILE = configured;
  await expect(profile.readOperatorPassphrase()).rejects.toThrow('Operator encryption secret is unavailable or invalid');
  expect(await secure.initializeDefaultEncryption()).toBe(false);
  expect(await secure.isEncryptionInitialized()).toBe(false);
});

test('a linked operator file is rejected even when it points outside the data tree', async () => {
  const { profile } = await modules();
  const linked = path.join(root, 'linked-passphrase');
  await fs.symlink(secretFile, linked, 'file');
  process.env.FLUJO_ENCRYPTION_PASSPHRASE_FILE = linked;
  await expect(profile.readOperatorPassphrase()).rejects.toThrow('Operator encryption secret is unavailable or invalid');
});

test('an operator secret hard-linked into the data tree is rejected', async () => {
  const { profile } = await modules();
  await fs.mkdir(process.env.FLUJO_DATA_DIR!, { recursive: true });
  await fs.link(secretFile, path.join(process.env.FLUJO_DATA_DIR!, 'credential-copy'));
  process.env.FLUJO_ENCRYPTION_PASSPHRASE_FILE = secretFile;
  await expect(profile.readOperatorPassphrase()).rejects.toThrow('Operator encryption secret is unavailable or invalid');
});

(process.platform === 'win32' ? test.skip : test)('POSIX operator files reject group and other permissions', async () => {
  const { profile } = await modules();
  process.env.FLUJO_ENCRYPTION_PASSPHRASE_FILE = secretFile;
  await fs.chmod(secretFile, 0o644);
  await expect(profile.readOperatorPassphrase()).rejects.toThrow('Operator encryption secret is unavailable or invalid');
});

test('the encryption route refuses public setup and reports parser failures without private input', async () => {
  const { secure } = await modules();
  // Create only the selected workspace, without creating encryption metadata.
  await (await import('@/utils/workspace')).ensureWorkspaceDirs();
  const { POST } = await import('@/app/api/encryption/secure/route');
  const request = (body: string) => new NextRequest('http://localhost/api/encryption/secure', {
    method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' }, body });
  const publicSetup = await POST(request(JSON.stringify({ action: 'initialize', password: 'FLUJO~' })));
  expect(publicSetup.status).toBe(400);
  expect(await secure.isEncryptionInitialized()).toBe(false);
  const defaultSetup = await POST(request(JSON.stringify({ action: 'initialize_default' })));
  expect(defaultSetup.status).toBe(423);
  const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const response = await POST(request('{synthetic-private-parser-value'));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Encryption request failed' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-private-parser-value');
  } finally { log.mockRestore(); }
});

test('corrupt key metadata has fixed diagnostics, no parser payload and no automatic metadata copies', async () => {
  const { secure } = await modules();
  const db = path.join(process.env.FLUJO_DATA_DIR!, 'workspaces', 'default-workspace', 'db');
  await fs.mkdir(db, { recursive: true });
  const corrupt = '{"data_encryption_key":"synthetic-private-key-diagnostic",';
  const metadata = path.join(db, 'encryption_key.json');
  await fs.writeFile(metadata, corrupt);
  const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    expect(await secure.initializeDefaultEncryption()).toBe(false);
    expect(await secure.initializeEncryption(password)).toBe(false);
    await expect(secure.getEncryptionStatus()).rejects.toThrow('Encryption metadata is invalid');
    expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-private-key-diagnostic');
    expect(await fs.readFile(metadata, 'utf8')).toBe(corrupt);
    expect((await fs.readdir(db)).filter(name => name.includes('.corrupted.'))).toEqual([]);
  } finally { log.mockRestore(); }
});

test('ordinary environment views mask historical plaintext secrets for single and batch reads', async () => {
  const { secure, storage, keys } = await modules();
  await secure.initializeEncryption(password);
  await secure.authenticate(password);
  await storage.saveItem(keys.GLOBAL_ENV_VARS, {
    PRIVATE_VALUE: { value: 'synthetic-historical-plaintext', metadata: { isSecret: true } },
    PUBLIC_VALUE: { value: 'synthetic-public-value', metadata: { isSecret: false } },
  });
  const { GET } = await import('@/app/api/env/route');
  const request = (query: string) => new NextRequest(`http://localhost/api/env?${query}`, { headers: { host: 'localhost' } });
  const batch = await GET(request('includeSecrets=false'));
  expect(batch.status).toBe(200);
  const batchData = await batch.json();
  expect(batchData.variables.PRIVATE_VALUE.value).toBe('********');
  expect(batchData.variables.PUBLIC_VALUE.value).toBe('synthetic-public-value');
  expect(JSON.stringify(batchData)).not.toContain('synthetic-historical-plaintext');
  const single = await GET(request('key=PRIVATE_VALUE&includeSecrets=false'));
  expect(await single.json()).toEqual({ value: '********', metadata: { isSecret: true } });
});

test('missing key metadata beside credentials requires matching recovery and never mints a replacement', async () => {
  let { secure, storage, keys } = await modules();
  await secure.initializeEncryption(password);
  await secure.authenticate(password);
  const ciphertext = (await secure.encryptWithPassword('synthetic-recovery-credential'))!;
  const before = await storage.loadItem(keys.ENCRYPTION_KEY, null);
  await storage.saveItem(keys.MODELS, { model: { apiKey: `encrypted:${ciphertext}` } });
  const db = path.join(process.env.FLUJO_DATA_DIR!, 'workspaces', 'default-workspace', 'db');
  const models = await fs.readFile(path.join(db, 'models.json'), 'utf8');
  await fs.unlink(path.join(db, 'encryption_key.json'));
  restart();
  ({ secure, storage, keys } = await modules());
  expect(await secure.initializeEncryption('replacement-must-not-be-used')).toBe(false);
  expect(await secure.isEncryptionInitialized()).toBe(false);
  expect(await fs.readFile(path.join(db, 'models.json'), 'utf8')).toBe(models);
  expect(await secure.getEncryptionStatus()).toEqual({ initialized: false, type: null,
    locked: true, recoveryRequired: true, protection: 'interactive' });
  await storage.saveItem(keys.ENCRYPTION_KEY, before);
  expect(await secure.authenticate(password)).toBeTruthy();
  expect(await secure.decryptWithPassword(ciphertext)).toBe('synthetic-recovery-credential');
});

test('a historical model ApiKey without metadata requires recovery and is retained unchanged', async () => {
  const { secure, storage, keys } = await modules();
  await storage.saveItem(keys.MODELS, [{ Id: 'legacy-model', ApiKey: 'synthetic-legacy-private-key' }]);
  const file = path.join(process.env.FLUJO_DATA_DIR!, 'workspaces', 'default-workspace', 'db', 'models.json');
  const before = await fs.readFile(file, 'utf8');
  expect(await secure.initializeEncryption(password)).toBe(false);
  expect(await secure.isEncryptionInitialized()).toBe(false);
  expect(await fs.readFile(file, 'utf8')).toBe(before);
  expect((await secure.getEncryptionStatus()).recoveryRequired).toBe(true);
});
