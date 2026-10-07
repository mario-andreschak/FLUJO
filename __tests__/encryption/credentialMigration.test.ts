import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { preflightCredentialMigration, migrateCredentials, recoverCredentialMigration } from '@/backend/services/workspace/credentialMigration';
import { DEFAULT_PASSWORD, newKeyring, open, seal, unwrapKeyring, wrapKeyring } from '@/utils/encryption/format';
import { credentialMigrationPath, isCredentialMigrationPending } from '@/utils/encryption/credentialMigrationState';
import { openRecipientTransfer } from '@/utils/encryption/recipientTransfer';
import { authenticate, decryptWithPassword, encryptWithPassword, initializeEncryption, changeEncryptionPassword,
  CredentialMigrationRequiredError, getEncryptionStatus, isEncryptionLocked } from '@/utils/encryption/secure';
import { clearItem, loadItem, saveItem, writeFileAtomic } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { getWorkspaceDir, runWithWorkspace } from '@/utils/workspace';
import { spawnSync } from 'node:child_process';
import { NextRequest } from 'next/server';
import { POST as migrationRoute } from '@/app/api/credential-migration/route';
import { POST as secureRoute } from '@/app/api/encryption/secure/route';
import { issueOwnerCredential } from '@/backend/services/security/ownerCredentials';
import { readOAuthTokens, readOAuthClientInformation, readOAuthCodeVerifier, sealOAuthCredential } from '@/backend/services/mcp/oauthCredentialStorage';
import { captureWorkspaceSnapshot } from '@/backend/services/workspace/snapshotArchive';

jest.setTimeout(60_000);
const sourcePassphrase = 'source-private-passphrase';
const recoveryPassphrase = 'migration-private-recovery-passphrase';
const options = { sourcePassphrase, recoveryPassphrase };
let root: string;
let saved: Record<string, string | undefined>;
let sourceBytes: Map<string, Buffer>;
const fileFor = (store: string) => path.join(getWorkspaceDir('default-workspace'), 'db', `${store}.json`);
async function readStore(store: string) { return JSON.parse(await fs.readFile(fileFor(store), 'utf8')); }
beforeEach(async () => {
  saved = Object.fromEntries(['FLUJO_DATA_DIR', 'FLUJO_PARENT_DATA_DIR', 'FLUJO_ENCRYPTION_SECRET_FILE', 'FLUJO_WORKER_MODE', 'FLUJO_OWNER_AUTH_FILE', 'FLUJO_EXPOSURE_MODE'].map(key => [key, process.env[key]]));
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-credential-migration-'));
  process.env.FLUJO_DATA_DIR = root;
  delete process.env.FLUJO_PARENT_DATA_DIR; delete process.env.FLUJO_ENCRYPTION_SECRET_FILE; delete process.env.FLUJO_WORKER_MODE;
  await fs.mkdir(path.dirname(fileFor('models')), { recursive: true });
  const ring = newKeyring(randomBytes(16).toString('hex'));
  const iv = randomBytes(16);
  const legacy = createCipheriv('aes-128-cbc', Buffer.from(ring.legacyKey!, 'hex'), iv);
  const oldCipher = `${iv.toString('hex')}:${Buffer.concat([legacy.update('legacy-canary', 'utf8'), legacy.final()]).toString('base64')}`;
  const records = {
    encryption_key: await wrapKeyring(ring, 'user', sourcePassphrase, 'passphrase'),
    models: [{ id: 'new', ApiKey: `encrypted:${seal('v2-canary', ring.activeKey, 'flujo:secret:v2')}` },
      { id: 'legacy', ApiKey: oldCipher }, { id: 'plain', ApiKey: 'plaintext-canary' }, { id: 'failed', ApiKey: 'encrypted_failed:failed-canary' }],
    mcp_servers: { server: { transport: 'streamable', disabled: false, oauthTokens: { access_token: 'oauth-canary', token_type: 'Bearer', issuer: 'https://issuer.example' },
      headers: { 'X-Legacy': 'header-canary' }, env: { UNMARKED: { value: 'env-canary', metadata: { isSecret: false } } } } },
    global_env_vars: { UNMARKED: 'global-canary', MARKED: { value: `encrypted:${seal('global-v2-canary', ring.activeKey, 'flujo:secret:v2')}`, metadata: { isSecret: true } } },
    registry_account: { accessToken: 'registry-canary', refreshToken: 'encrypted_failed:refresh-canary' },
  };
  sourceBytes = new Map();
  for (const [store, value] of Object.entries(records)) {
    const bytes = Buffer.from(JSON.stringify(value)); sourceBytes.set(store, bytes);
    await fs.writeFile(fileFor(store), bytes, { mode: 0o600 });
  }
});
afterEach(async () => {
  global.__flujo_server_dek = undefined; global.__flujo_server_deks_by_workspace = undefined;
  global.__flujo_encryption_sessions = undefined;
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  // Absolute generated fixture root is outside the owned checkout.
  await fs.rm(root, { recursive: true, force: true });
});
async function pending(step: 'journal_written' | 'record_written' | 'before_commit') {
  const inventory = await preflightCredentialMigration(options);
  await expect(migrateCredentials({ ...options, checkpoint: async actual => { if (actual === step) throw new Error('Injected interruption'); } }, inventory.planToken)).rejects.toThrow('Injected interruption');
  expect(await isCredentialMigrationPending()).toBe(true);
}
async function assertMigrated(keyChanged = false) {
  expect(await isCredentialMigrationPending()).toBe(false);
  const metadata = await readStore('encryption_key');
  expect(metadata.key_protection).toBe('passphrase');
  const originalId = JSON.parse(sourceBytes.get('encryption_key')!.toString()).key_id;
  if (keyChanged) expect(metadata.key_id).not.toBe(originalId); else expect(metadata.key_id).toBe(originalId);
  const ring = await unwrapKeyring(metadata, recoveryPassphrase);
  const recover = (text: string) => { expect(text.startsWith('encrypted:v2:')).toBe(true); return open(text.slice('encrypted:'.length), ring.activeKey, 'flujo:secret:v2'); };
  expect((await readStore('models')).map((model: { ApiKey: string }) => recover(model.ApiKey))).toEqual(['v2-canary', 'legacy-canary', 'plaintext-canary', 'failed-canary']);
  const mcp = (await readStore('mcp_servers')).server;
  expect(mcp.disabled).toBe(false); // In-place migration preserves existing configuration behavior.
  expect(mcp.oauthTokens.ciphertext.startsWith('v2:')).toBe(true);
  expect(recover(mcp.headers['X-Legacy'].value)).toBe('header-canary');
  expect(recover(mcp.env.UNMARKED.value)).toBe('env-canary');
  expect(recover((await readStore('global_env_vars')).UNMARKED.value)).toBe('global-canary');
  expect(recover((await readStore('registry_account')).refreshToken)).toBe('refresh-canary');
  expect(await authenticate(sourcePassphrase)).toBeNull();
  expect(await authenticate(recoveryPassphrase)).not.toBeNull();
  expect((await readOAuthTokens(mcp))?.access_token).toBe('oauth-canary');
  expect(await decryptWithPassword((await readStore('models'))[0].ApiKey.slice('encrypted:'.length))).toBe('v2-canary');
}

test('read-only preflight reports counts, then mixed stores migrate with encrypted exact source backup', async () => {
  const inventory = await preflightCredentialMigration(options);
  expect(JSON.stringify(inventory)).not.toContain('canary');
  expect(inventory.stores.find(value => value.store === 'models')).toMatchObject({ credentials: 4, plaintext: 1, v1: 1, v2: 1, failedPlaintext: 1 });
  for (const [store, bytes] of sourceBytes) expect(await fs.readFile(fileFor(store))).toEqual(bytes);
  expect(await isCredentialMigrationPending()).toBe(false);
  expect(await migrateCredentials(options, inventory.planToken)).toMatchObject({ status: 'committed', stores: 5 });
  await assertMigrated();
  const files = await fs.readdir(path.dirname(fileFor('models')));
  const receipt = files.find(name => /^\.credential-migration\..+\.committed$/.test(name))!;
  const envelope = await fs.readFile(path.join(path.dirname(fileFor('models')), receipt));
  expect(envelope.toString()).not.toContain('canary');
  const bytes = await openRecipientTransfer(envelope, recoveryPassphrase);
  const journal = JSON.parse(bytes.toString()); bytes.fill(0);
  for (const [store, original] of sourceBytes) expect(Buffer.from(journal.entries[store].before, 'base64')).toEqual(original);
});

test.each(['journal_written', 'record_written', 'before_commit'] as const)('interruption at %s stays locked and resumes deterministically', async step => {
  await pending(step);
  expect(await isEncryptionLocked()).toBe(true);
  expect(await getEncryptionStatus()).toEqual({ initialized: true, locked: true, protection: 'migration-pending' });
  await expect(loadItem(StorageKey.MODELS, [])).rejects.toThrow(/migration is pending/);
  await expect(saveItem(StorageKey.MODELS, [])).rejects.toThrow(/migration is pending/);
  await expect(writeFileAtomic(fileFor('models'), '[]')).rejects.toThrow(/migration is pending/);
  await expect(clearItem(StorageKey.MODELS)).rejects.toThrow(/migration is pending/);
  expect(await authenticate(sourcePassphrase)).toBeNull();
  expect(await authenticate(recoveryPassphrase)).toBeNull();
  await expect(captureWorkspaceSnapshot('default-workspace', 0)).rejects.toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE' });
  expect(await recoverCredentialMigration(options)).toMatchObject({ status: 'committed' });
  await assertMigrated();
});

test('rollback after partial replacement restores every exact source byte and keeps an encrypted receipt', async () => {
  await pending('record_written');
  expect(await recoverCredentialMigration(options, true)).toMatchObject({ status: 'rolled-back' });
  expect(await isCredentialMigrationPending()).toBe(false);
  for (const [store, bytes] of sourceBytes) expect(await fs.readFile(fileFor(store))).toEqual(bytes);
  expect(await authenticate(sourcePassphrase)).not.toBeNull();
});

test('wrong recovery passphrase and tampered journal preserve partial records and pending marker', async () => {
  await pending('record_written');
  const partial = await fs.readFile(fileFor('models'));
  await expect(recoverCredentialMigration({ recoveryPassphrase: 'wrong-private-recovery-passphrase' })).rejects.toMatchObject({ code: 'RECOVERY_INVALID' });
  const original = await fs.readFile(credentialMigrationPath());
  const corrupt = Buffer.from(original); corrupt[45] ^= 1;
  await fs.writeFile(credentialMigrationPath(), corrupt);
  await expect(recoverCredentialMigration(options)).rejects.toMatchObject({ code: 'RECOVERY_INVALID' });
  expect(await fs.readFile(fileFor('models'))).toEqual(partial);
  expect(await isCredentialMigrationPending()).toBe(true);
});

test('unexpected current-file changes refuse both resume and rollback before any replacement', async () => {
  await pending('record_written');
  const other = await fs.readFile(fileFor('mcp_servers'));
  await fs.writeFile(fileFor('models'), '[{"ApiKey":"outside-canary"}]');
  for (const rollback of [false, true]) await expect(recoverCredentialMigration(options, rollback)).rejects.toMatchObject({ code: 'SOURCE_CHANGED', store: 'models' });
  expect(await fs.readFile(fileFor('mcp_servers'))).toEqual(other);
  expect(await isCredentialMigrationPending()).toBe(true);
});

test('corrupt credentials and corrupt metadata fail preflight without rewriting anything', async () => {
  await fs.writeFile(fileFor('models'), '[{"ApiKey":"encrypted:v2:invalid"}]');
  const corrupt = await fs.readFile(fileFor('models'));
  await expect(preflightCredentialMigration(options)).rejects.toMatchObject({ code: 'SOURCE_INVALID', store: 'models' });
  expect(await fs.readFile(fileFor('models'))).toEqual(corrupt);
  expect(await isCredentialMigrationPending()).toBe(false);
  await fs.writeFile(fileFor('encryption_key'), 'invalid JSON');
  await expect(preflightCredentialMigration(options)).rejects.toMatchObject({ code: 'SOURCE_INVALID', store: 'encryption_key' });
  expect(await fs.readFile(fileFor('encryption_key'), 'utf8')).toBe('invalid JSON');
});

test('stale preflight token refuses migration and creates no pending journal', async () => {
  const inventory = await preflightCredentialMigration(options);
  await fs.writeFile(fileFor('registry_account'), '{"accessToken":"changed-canary"}');
  await expect(migrateCredentials(options, inventory.planToken)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  expect(await isCredentialMigrationPending()).toBe(false);
  expect(await fs.readFile(fileFor('registry_account'), 'utf8')).toBe('{"accessToken":"changed-canary"}');
});

test('preflight tokens are independently salted and the issued token remains valid', async () => {
  const first = await preflightCredentialMigration(options);
  const second = await preflightCredentialMigration(options);
  expect(first.planToken).toMatch(/^[a-f0-9]{64}$/);
  expect(second.planToken).not.toBe(first.planToken);
  expect(await migrateCredentials(options, first.planToken)).toMatchObject({ status: 'committed' });
  await assertMigrated();
});

test('old deterministic preflight tokens require a new preflight without changing source bytes', async () => {
  const beforeHashes = [...sourceBytes].map(([store, bytes]) => [store, createHash('sha256').update(bytes).digest('hex')]);
  const legacyToken = createHash('sha256').update(JSON.stringify(beforeHashes)).digest('hex');
  await expect(migrateCredentials(options, legacyToken)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  expect(await isCredentialMigrationPending()).toBe(false);
  for (const [store, bytes] of sourceBytes) expect(await fs.readFile(fileFor(store))).toEqual(bytes);
});

test('the reviewed token refuses a different recovery passphrase without mutation', async () => {
  const inventory = await preflightCredentialMigration(options);
  await expect(migrateCredentials({ ...options, recoveryPassphrase: 'different-private-recovery-passphrase' }, inventory.planToken))
    .rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  expect(await isCredentialMigrationPending()).toBe(false);
  for (const [store, bytes] of sourceBytes) expect(await fs.readFile(fileFor(store))).toEqual(bytes);
});

test('the reviewed token refuses a different authenticated target protection', async () => {
  const inventory = await preflightCredentialMigration(options);
  const secretFile = `${root}.operator-secret`;
  await fs.writeFile(secretFile, randomBytes(48).toString('base64url'), { mode: 0o600, flag: 'wx' });
  process.env.FLUJO_ENCRYPTION_SECRET_FILE = secretFile;
  try {
    await expect(migrateCredentials({ ...options, protection: 'operator-file' }, inventory.planToken))
      .rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(await isCredentialMigrationPending()).toBe(false);
    for (const [store, bytes] of sourceBytes) expect(await fs.readFile(fileFor(store))).toEqual(bytes);
  } finally { await fs.unlink(secretFile); }
});

test('the reviewed token cannot migrate identical source bytes in another workspace', async () => {
  const inventory = await preflightCredentialMigration(options);
  const otherDb = path.join(getWorkspaceDir('other-workspace'), 'db');
  await fs.mkdir(otherDb, { recursive: true });
  for (const [store, bytes] of sourceBytes) await fs.writeFile(path.join(otherDb, `${store}.json`), bytes, { mode: 0o600 });
  await runWithWorkspace('other-workspace', async () => {
    await expect(migrateCredentials(options, inventory.planToken)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(await isCredentialMigrationPending()).toBe(false);
    for (const [store, bytes] of sourceBytes) expect(await fs.readFile(path.join(otherDb, `${store}.json`))).toEqual(bytes);
  });
});

test('final commit refuses a record reverted after verification; restart resume finishes it', async () => {
  const inventory = await preflightCredentialMigration(options);
  await expect(migrateCredentials({ ...options, checkpoint: async step => {
    if (step === 'before_commit') await fs.writeFile(fileFor('models'), sourceBytes.get('models')!);
  } }, inventory.planToken)).rejects.toMatchObject({ code: 'SOURCE_CHANGED', store: 'models' });
  expect(await isCredentialMigrationPending()).toBe(true);
  await recoverCredentialMigration(options);
  await assertMigrated();
});

test('v1 metadata and bare legacy ciphertext migrate privately while old ciphertext remains recoverable', async () => {
  const keyText = randomBytes(8).toString('hex');
  const iv = randomBytes(16);
  const wrapped = createCipheriv('aes-256-cbc', pbkdf2Sync(DEFAULT_PASSWORD, 'flujo_fixed_salt_v1', 100_000, 32, 'sha256'), iv);
  const metadata = { encryption_version: 1, encryption_type: 'default', data_encryption_salt: '', data_encryption_iv: iv.toString('hex'),
    data_encryption_key: Buffer.concat([wrapped.update(keyText, 'utf8'), wrapped.final()]).toString('base64') };
  const secretIv = randomBytes(16);
  const encrypted = createCipheriv('aes-128-cbc', Buffer.from(keyText, 'utf8'), secretIv);
  const legacy = `${secretIv.toString('hex')}:${Buffer.concat([encrypted.update('v1-metadata-canary', 'utf8'), encrypted.final()]).toString('base64')}`;
  await fs.writeFile(fileFor('encryption_key'), JSON.stringify(metadata));
  await fs.writeFile(fileFor('models'), JSON.stringify([{ ApiKey: legacy }, { ApiKey: 'encrypted_failed:v1-plaintext-canary' }]));
  await fs.writeFile(fileFor('global_env_vars'), '{"PLAIN":"global-canary"}');
  const inventory = await preflightCredentialMigration({ recoveryPassphrase });
  await migrateCredentials({ recoveryPassphrase }, inventory.planToken);
  expect((await readStore('encryption_key')).key_protection).toBe('passphrase');
  expect(await authenticate(DEFAULT_PASSWORD)).toBeNull();
  expect(await authenticate(recoveryPassphrase)).not.toBeNull();
  expect(await decryptWithPassword((await readStore('models'))[0].ApiKey.slice('encrypted:'.length))).toBe('v1-metadata-canary');
  expect(await decryptWithPassword(legacy)).toBe('v1-metadata-canary');
});

test('operator profile migration keeps the independent mount boundary and locks when it disappears', async () => {
  const mount = path.join(os.tmpdir(), `flujo-migration-secret-${randomBytes(16).toString('hex')}`);
  const secret = randomBytes(32).toString('base64url');
  try {
    await fs.writeFile(mount, secret, { mode: 0o600 });
    process.env.FLUJO_ENCRYPTION_SECRET_FILE = mount;
    const ring = await unwrapKeyring(await readStore('encryption_key'), sourcePassphrase);
    await fs.writeFile(fileFor('encryption_key'), JSON.stringify(await wrapKeyring(ring, 'user', secret, 'operator-file')));
    const operator = { recoveryPassphrase, protection: 'operator-file' as const };
    const inventory = await preflightCredentialMigration(operator);
    await migrateCredentials(operator, inventory.planToken);
    expect((await readStore('encryption_key')).key_protection).toBe('operator-file');
    expect(await isEncryptionLocked()).toBe(false);
    expect(await decryptWithPassword((await readStore('models'))[0].ApiKey.slice('encrypted:'.length))).toBe('v2-canary');
    await fs.unlink(mount);
    expect(await isEncryptionLocked()).toBe(true);
    await expect(decryptWithPassword((await readStore('models'))[0].ApiKey.slice('encrypted:'.length))).resolves.toBeNull();
  } finally { await fs.unlink(mount).catch(() => undefined); }
});

test('a new OS process resumes a partial journal, and a third process unlocks after restart', async () => {
  await pending('record_written');
  const args = [path.join(__dirname, 'fixtures/credential-migration-child.cjs'), process.cwd(), require.resolve('typescript')];
  for (const operation of ['resume', 'read']) {
    const result = spawnSync(process.execPath, args, { env: { ...process.env, LOG_LEVEL: 'error' }, windowsHide: true, encoding: 'utf8', timeout: 30_000,
      input: JSON.stringify({ operation, recoveryPassphrase, expected: ['v2-canary', 'legacy-canary', 'plaintext-canary', 'failed-canary'] }) });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.stderr).toBe('');
    expect(result.stdout).toContain('MIGRATION_SOURCE_PASS'); expect(result.stdout).not.toContain('canary');
  }
});

test('actual migration HTTP route requires owner secret authority, loopback, confirmation and a matching read-only preflight', async () => {
  const issued = issueOwnerCredential(['control:admin', 'secrets:read'], Date.now() + 60_000);
  const policy = path.join(root, 'owner-policy.json');
  await fs.writeFile(policy, JSON.stringify({ schemaVersion: 1, ownerId: 'migration-owner', credentials: [issued.record] }), { mode: 0o600 });
  process.env.FLUJO_OWNER_AUTH_FILE = policy; process.env.FLUJO_EXPOSURE_MODE = 'localhost';
  const headers = { host: 'localhost', authorization: `Bearer ${issued.token}` };
  const request = (body: Record<string, unknown>, suppliedHeaders = headers) => new NextRequest('http://localhost/api/credential-migration', {
    method: 'POST', headers: suppliedHeaders, body: JSON.stringify(body) });
  const input = { ...options, action: 'preflight' };
  expect((await migrationRoute(request(input, { host: 'localhost', authorization: '' }))).status).toBe(401);
  expect((await migrationRoute(request(input, { ...headers, origin: 'https://attacker.example' } as typeof headers))).status).toBe(403);
  const preflight = await migrationRoute(request(input));
  expect(preflight.status).toBe(200); expect(preflight.headers.get('cache-control')).toBe('no-store');
  const inventory = await preflight.json(); expect(JSON.stringify(inventory)).not.toContain('canary');
  expect((await migrationRoute(request({ ...options, action: 'migrate', planToken: inventory.planToken }))).status).toBe(400);
  expect(await isCredentialMigrationPending()).toBe(false);
  const migrated = await migrationRoute(request({ ...options, action: 'migrate', planToken: inventory.planToken, confirmMigration: true }));
  expect(migrated.status).toBe(200); expect(await migrated.json()).toMatchObject({ status: 'committed' });
  await assertMigrated();
});

test('a separate OS process rolls back partial migration and restores every original byte', async () => {
  await pending('record_written');
  const args = [path.join(__dirname, 'fixtures/credential-migration-child.cjs'), process.cwd(), require.resolve('typescript')];
  const result = spawnSync(process.execPath, args, { env: { ...process.env, LOG_LEVEL: 'error' }, windowsHide: true, encoding: 'utf8', timeout: 30_000,
    input: JSON.stringify({ operation: 'rollback', recoveryPassphrase }) });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.stderr).toBe('');
  expect(result.stdout).toContain('MIGRATION_SOURCE_PASS');
  expect(await isCredentialMigrationPending()).toBe(false);
  for (const [store, bytes] of sourceBytes) expect(await fs.readFile(fileFor(store))).toEqual(bytes);
  expect(await authenticate(sourcePassphrase)).not.toBeNull();
});

test('whole OAuth bundles and private provider extensions survive in-place migration through real runtime getters', async () => {
  await authenticate(sourcePassphrase);
  const sdk = { access_token: 'whole-access-canary', token_type: 'Bearer', issuer: 'https://issuer.example', extension: { secret: 'opaque-extension-canary' } };
  const client = { client_id: 'dynamic-client', client_secret: 'whole-client-secret-canary', issuer: 'https://issuer.example',
    jwks: { keys: [{ d: 'private-jwk-canary' }] } };
  const verifier = 'whole-verifier-canary';
  const source = (await readStore('mcp_servers')).server;
  source.oauthTokens = await sealOAuthCredential('tokens', sdk);
  source.oauthClientInformation = await sealOAuthCredential('client', client);
  source.oauthCodeVerifier = await sealOAuthCredential('verifier', verifier);
  await fs.writeFile(fileFor('mcp_servers'), JSON.stringify({ server: source }));
  const inventory = await preflightCredentialMigration(options);
  await migrateCredentials(options, inventory.planToken);
  await authenticate(recoveryPassphrase);
  const restored = (await readStore('mcp_servers')).server;
  expect(await readOAuthTokens(restored)).toEqual(sdk);
  expect(await readOAuthClientInformation(restored)).toEqual(client);
  expect(await readOAuthCodeVerifier(restored)).toBe(verifier);
  expect(restored.oauthTokens.ciphertext.startsWith('v2:')).toBe(true);
});

async function publicDefaultSource() {
  const ring = await unwrapKeyring(await readStore('encryption_key'), sourcePassphrase);
  const metadata = await wrapKeyring(ring, 'default', DEFAULT_PASSWORD);
  await fs.writeFile(fileFor('encryption_key'), JSON.stringify(metadata), { mode: 0o600 });
  sourceBytes.set('encryption_key', await fs.readFile(fileFor('encryption_key')));
  return await unwrapKeyring(metadata, DEFAULT_PASSWORD);
}
function ciphertexts(value: unknown): string[] {
  if (typeof value === 'string') return value.startsWith('encrypted:v2:') ? [value.slice('encrypted:'.length)]
    : value.startsWith('v2:') ? [value] : [];
  if (value && typeof value === 'object') return Object.values(value).flatMap(ciphertexts);
  return [];
}
test('public-default v2 migration retires the exposed active key for every live store and a cold OS reader decrypts with new private protection', async () => {
  const oldRing = await publicDefaultSource();
  const inventory = await preflightCredentialMigration(options);
  await migrateCredentials(options, inventory.planToken);
  await assertMigrated(true);
  const target = await unwrapKeyring(await readStore('encryption_key'), recoveryPassphrase);
  expect(target.activeKey).not.toBe(oldRing.activeKey);
  for (const store of ['models', 'mcp_servers', 'global_env_vars', 'registry_account']) {
    const values = ciphertexts(await readStore(store)); expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(() => open(value, oldRing.activeKey, 'flujo:secret:v2')).toThrow();
      expect(typeof open(value, target.activeKey, 'flujo:secret:v2')).toBe('string');
    }
  }
  const result = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/credential-migration-child.cjs'), process.cwd(), require.resolve('typescript')],
    { env: { ...process.env, LOG_LEVEL: 'error' }, windowsHide: true, encoding: 'utf8', timeout: 30_000,
      input: JSON.stringify({ operation: 'read', recoveryPassphrase, expected: ['v2-canary', 'legacy-canary', 'plaintext-canary', 'failed-canary'] }) });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.stderr).toBe('');
  expect(result.stdout).toContain('MIGRATION_SOURCE_PASS'); expect(result.stdout).not.toContain('canary');
});
test('interrupted public-default key retirement rolls back exact original bytes and protection', async () => {
  const original = await publicDefaultSource();
  const inventory = await preflightCredentialMigration(options);
  await expect(migrateCredentials({ ...options, checkpoint: async step => {
    if (step === 'record_written') throw new Error('Interrupted public-default migration');
  } }, inventory.planToken)).rejects.toThrow('Interrupted public-default migration');
  expect(await isCredentialMigrationPending()).toBe(true);
  await recoverCredentialMigration(options, true);
  for (const [store, bytes] of sourceBytes) expect(await fs.readFile(fileFor(store))).toEqual(bytes);
  const restored = await unwrapKeyring(await readStore('encryption_key'), DEFAULT_PASSWORD);
  expect(restored.activeKey).toBe(original.activeKey);
  expect(open((await readStore('models'))[0].ApiKey.slice('encrypted:'.length), restored.activeKey, 'flujo:secret:v2')).toBe('v2-canary');
});
test('already private v2 migration preserves the active key while changing its protection', async () => {
  const original = await unwrapKeyring(await readStore('encryption_key'), sourcePassphrase);
  const inventory = await preflightCredentialMigration(options);
  await migrateCredentials(options, inventory.planToken);
  expect((await unwrapKeyring(await readStore('encryption_key'), recoveryPassphrase)).activeKey).toBe(original.activeKey);
});

test('DEFAULT v2 initialization and password changes refuse metadata-only rewrapping without modifying any credential file', async () => {
  await publicDefaultSource();
  await expect(initializeEncryption(recoveryPassphrase)).rejects.toBeInstanceOf(CredentialMigrationRequiredError);
  await expect(changeEncryptionPassword(DEFAULT_PASSWORD, recoveryPassphrase)).rejects.toBeInstanceOf(CredentialMigrationRequiredError);
  for (const [store, bytes] of sourceBytes) expect(await fs.readFile(fileFor(store))).toEqual(bytes);
  expect(await isCredentialMigrationPending()).toBe(false);
});

test('the authorized secure HTTP route returns actionable migration refusal for DEFAULT v2', async () => {
  await publicDefaultSource();
  const issued = issueOwnerCredential(['control:admin', 'secrets:read'], Date.now() + 60_000);
  const policy = path.join(root, 'owner-policy.json');
  await fs.writeFile(policy, JSON.stringify({ schemaVersion: 1, ownerId: 'migration-owner', credentials: [issued.record] }), { mode: 0o600 });
  process.env.FLUJO_OWNER_AUTH_FILE = policy; process.env.FLUJO_EXPOSURE_MODE = 'localhost';
  for (const body of [{ action: 'initialize', password: recoveryPassphrase },
    { action: 'change_password', oldPassword: DEFAULT_PASSWORD, newPassword: recoveryPassphrase }]) {
    const request = new NextRequest('http://localhost/api/encryption/secure', {
      method: 'POST', headers: { host: 'localhost', authorization: `Bearer ${issued.token}` }, body: JSON.stringify(body),
    });
    const response = await secureRoute(request);
    expect(response.status).toBe(409);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ code: 'credential_migration_required', remediation: expect.stringContaining('migration preflight') });
  }
  for (const [store, bytes] of sourceBytes) expect(await fs.readFile(fileFor(store))).toEqual(bytes);
});

test('explicit retirement protects future credentials from copied DEFAULT metadata after historical USER rewrapping', async () => {
  const exposed = await publicDefaultSource();
  const copiedPublicMetadata = await readStore('encryption_key');
  await fs.writeFile(fileFor('encryption_key'), JSON.stringify(await wrapKeyring(exposed, 'user', sourcePassphrase, 'passphrase')));
  const retirement = { ...options, retireActiveKey: true };
  const inventory = await preflightCredentialMigration(retirement);
  expect(inventory).toMatchObject({ retireActiveKey: true, activeKeyWillChange: true });
  const oldToken = await authenticate(sourcePassphrase);
  if (!oldToken) throw new Error('Source authentication failed');
  await migrateCredentials(retirement, inventory.planToken);
  expect(await isEncryptionLocked()).toBe(true);
  await expect(encryptWithPassword('blocked-before-unlock')).rejects.toThrow('locked');
  await expect(encryptWithPassword('blocked-old-session', oldToken, true)).rejects.toThrow('metadata changed');
  await assertMigrated(true);
  const target = await unwrapKeyring(await readStore('encryption_key'), recoveryPassphrase);
  expect(target.activeKey).not.toBe(exposed.activeKey);
  const attacker = await unwrapKeyring(copiedPublicMetadata, DEFAULT_PASSWORD);
  expect(await authenticate(recoveryPassphrase)).not.toBeNull();
  await expect(encryptWithPassword('blocked-old-session-after-unlock', oldToken, true)).rejects.toThrow('metadata changed');
  const future = await encryptWithPassword('future-private-canary');
  if (!future) throw new Error('Future credential encryption failed');
  expect(open(future, target.activeKey, 'flujo:secret:v2')).toBe('future-private-canary');
  expect(() => open(future, attacker.activeKey, 'flujo:secret:v2')).toThrow();
  for (const store of ['models', 'mcp_servers', 'global_env_vars', 'registry_account']) {
    for (const ciphertext of ciphertexts(await readStore(store))) expect(() => open(ciphertext, attacker.activeKey, 'flujo:secret:v2')).toThrow();
  }
  const result = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/credential-migration-child.cjs'), process.cwd(), require.resolve('typescript')],
    { env: { ...process.env, LOG_LEVEL: 'error' }, windowsHide: true, encoding: 'utf8', timeout: 30_000,
      input: JSON.stringify({ operation: 'read', recoveryPassphrase, expected: ['v2-canary', 'legacy-canary', 'plaintext-canary', 'failed-canary'] }) });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.stderr).toBe('');
  expect(result.stdout).toContain('MIGRATION_SOURCE_PASS');
});

test.each([false, true])('a preflight cannot change the retirement choice (%s)', async retireActiveKey => {
  const inventory = await preflightCredentialMigration({ ...options, retireActiveKey });
  await expect(migrateCredentials({ ...options, retireActiveKey: !retireActiveKey }, inventory.planToken)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  expect(await isCredentialMigrationPending()).toBe(false);
  for (const [store, bytes] of sourceBytes) expect(await fs.readFile(fileFor(store))).toEqual(bytes);
});

test.each([false, true])('interrupted explicit retirement recovers the authenticated journal (rollback=%s)', async rollback => {
  const original = await unwrapKeyring(await readStore('encryption_key'), sourcePassphrase);
  const retirement = { ...options, retireActiveKey: true };
  const inventory = await preflightCredentialMigration(retirement);
  await expect(migrateCredentials({ ...retirement, checkpoint: async step => {
    if (step === 'record_written') throw new Error('Interrupted explicit key retirement');
  } }, inventory.planToken)).rejects.toThrow('Interrupted explicit key retirement');
  expect(await isCredentialMigrationPending()).toBe(true);
  // Recovery follows its authenticated after-image even without the request flag.
  await recoverCredentialMigration(options, rollback);
  expect(await isCredentialMigrationPending()).toBe(false);
  if (rollback) {
    for (const [store, bytes] of sourceBytes) expect(await fs.readFile(fileFor(store))).toEqual(bytes);
    expect((await unwrapKeyring(await readStore('encryption_key'), sourcePassphrase)).activeKey).toBe(original.activeKey);
  } else {
    await assertMigrated(true);
    expect((await unwrapKeyring(await readStore('encryption_key'), recoveryPassphrase)).activeKey).not.toBe(original.activeKey);
  }
});
