import fs from 'node:fs/promises';
import { NextRequest } from 'next/server';
import { POST as exportRoute } from '@/app/api/credential-transfer/route';
import { POST as restoreRoute } from '@/app/api/credential-transfer/restore/route';
import { loadServerConfigs } from '@/backend/services/mcp/config';
import { issueOwnerCredential } from '@/backend/services/security/ownerCredentials';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { exportCredentialTransfer, restoreCredentialTransfer } from '@/backend/services/workspace/credentialTransfer';
import { metadataRevision, newKeyring, open, seal, serializeKeyring, unwrapKeyring, wrapKeyring } from '@/utils/encryption/format';
import { unlockServer } from '@/utils/encryption/session';
import { getWorkspaceDir, runWithWorkspace } from '@/utils/workspace';
import { openRecipientTransfer, sealRecipientTransfer } from '@/utils/encryption/recipientTransfer';

jest.setTimeout(60_000);
const recipientPassword = 'recipient-envelope-test-passphrase';
const localPassword = 'recipient-local-test-passphrase';
let root: string;
let saved: Record<string, string | undefined>;
let sourceBytes: Map<string, Buffer>;
beforeEach(async () => {
  saved = Object.fromEntries(['FLUJO_DATA_DIR', 'FLUJO_PARENT_DATA_DIR', 'FLUJO_ENCRYPTION_SECRET_FILE', 'FLUJO_OWNER_AUTH_FILE', 'FLUJO_EXPOSURE_MODE'].map(key => [key, process.env[key]]));
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-recipient-transfer-'));
  process.env.FLUJO_DATA_DIR = root;
  delete process.env.FLUJO_PARENT_DATA_DIR;
  delete process.env.FLUJO_ENCRYPTION_SECRET_FILE;
  const db = path.join(getWorkspaceDir('default-workspace'), 'db');
  await fs.mkdir(db, { recursive: true });
  const legacyKey = randomBytes(16).toString('hex');
  const ring = newKeyring(legacyKey);
  const metadata = await wrapKeyring(ring, 'user', 'source-private-passphrase', 'passphrase');
  const iv = randomBytes(16);
  const legacy = createCipheriv('aes-128-cbc', Buffer.from(legacyKey, 'hex'), iv);
  const oldCipher = `${iv.toString('hex')}:${Buffer.concat([legacy.update('legacy-canary', 'utf8'), legacy.final()]).toString('base64')}`;
  const records = {
    encryption_key: metadata,
    models: [{ id: 'new', ApiKey: `encrypted:${seal('v2-canary', ring.activeKey, 'flujo:secret:v2')}` }, { id: 'legacy', ApiKey: oldCipher }, { id: 'failed', ApiKey: 'encrypted_failed:plaintext-canary' }],
    mcp_servers: { server: { transport: 'streamable', oauthTokens: { access_token: 'oauth-canary' }, headers: { 'X-Legacy': 'header-canary' }, env: { UNMARKED: { value: 'env-canary', metadata: { isSecret: false } } } } },
    global_env_vars: { UNMARKED: 'global-canary', LEGACY_ENCRYPTED: `encrypted:${seal('global-legacy-envelope-canary', ring.activeKey, 'flujo:secret:v2')}`, MARKED: { value: `encrypted:${seal('global-v2-canary', ring.activeKey, 'flujo:secret:v2')}`, metadata: { isSecret: true } } },
    registry_account: { accessToken: 'registry-canary', refreshToken: 'encrypted_failed:refresh-canary' },
  };
  sourceBytes = new Map();
  for (const [key, record] of Object.entries(records)) {
    const bytes = Buffer.from(JSON.stringify(record));
    sourceBytes.set(key, bytes);
    await fs.writeFile(path.join(db, `${key}.json`), bytes, { mode: 0o600 });
  }
  runWithWorkspace('default-workspace', () => unlockServer(serializeKeyring(ring, metadataRevision(metadata))));
});
afterEach(async () => {
  global.__flujo_server_dek = undefined;
  global.__flujo_server_deks_by_workspace = undefined;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  // root is an absolute, generated fixture directory, never a workspace checkout.
  await fs.rm(root, { recursive: true, force: true });
});
async function exported() { return runWithWorkspace('default-workspace', () => exportCredentialTransfer(recipientPassword)); }
async function readStore(workspace: string, key: string) { return JSON.parse(await fs.readFile(path.join(getWorkspaceDir(workspace), 'db', `${key}.json`), 'utf8')); }

test('mixed v1/v2/plaintext credentials restore under a distinct recipient key without source metadata', async () => {
  const envelope = await exported();
  expect(envelope.toString()).not.toContain('canary');
  const plaintext = await openRecipientTransfer(envelope, recipientPassword);
  expect(JSON.parse(plaintext.toString()).records).not.toHaveProperty('encryption_key');
  plaintext.fill(0);
  await restoreCredentialTransfer(envelope, recipientPassword, 'recipient', localPassword);
  const metadata = await readStore('recipient', 'encryption_key');
  const recipientRing = await unwrapKeyring(metadata, localPassword);
  const sourceMetadata = JSON.parse(sourceBytes.get('encryption_key')!.toString());
  expect(metadata.key_id).not.toBe(sourceMetadata.key_id);
  expect(metadata.key_protection).toBe('passphrase');
  const models = await readStore('recipient', 'models');
  const recover = (value: string) => open(value.slice('encrypted:'.length), recipientRing.activeKey, 'flujo:secret:v2');
  expect(models.map((model: { ApiKey: string }) => recover(model.ApiKey))).toEqual(['v2-canary', 'legacy-canary', 'plaintext-canary']);
  const mcp = (await readStore('recipient', 'mcp_servers')).server;
  expect(mcp.disabled).toBe(true);
  const loaded = await runWithWorkspace('recipient', () => loadServerConfigs());
  expect(Array.isArray(loaded)).toBe(true);
  expect(loaded).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'server', disabled: true })]));
  expect(recover(mcp.oauthTokens.access_token)).toBe('oauth-canary');
  expect(recover(mcp.headers['X-Legacy'].value)).toBe('header-canary');
  expect(mcp.headers['X-Legacy'].metadata.isSecret).toBe(true);
  expect(recover(mcp.env.UNMARKED.value)).toBe('env-canary');
  expect(mcp.env.UNMARKED.metadata.isSecret).toBe(true);
  const env = await readStore('recipient', 'global_env_vars');
  expect(recover(env.UNMARKED.value)).toBe('global-canary');
  expect(recover(env.MARKED.value)).toBe('global-v2-canary');
  expect(recover(env.LEGACY_ENCRYPTED.value)).toBe('global-legacy-envelope-canary');
  expect(recover((await readStore('recipient', 'registry_account')).refreshToken)).toBe('refresh-canary');
  for (const [key, bytes] of sourceBytes) expect(await fs.readFile(path.join(getWorkspaceDir('default-workspace'), 'db', `${key}.json`))).toEqual(bytes);
});

test('wrong password, corruption and expired transfers publish no workspace', async () => {
  const envelope = await exported();
  await expect(restoreCredentialTransfer(envelope, 'incorrect-recipient-passphrase', 'wrong', localPassword)).rejects.toThrow();
  const corrupt = Buffer.from(envelope); corrupt[45] ^= 1;
  await expect(restoreCredentialTransfer(corrupt, recipientPassword, 'corrupt', localPassword)).rejects.toThrow();
  const bytes = await openRecipientTransfer(envelope, recipientPassword);
  const payload = JSON.parse(bytes.toString()); bytes.fill(0);
  payload.createdAt -= 48 * 60 * 60 * 1000; payload.expiresAt -= 48 * 60 * 60 * 1000;
  const expired = await sealRecipientTransfer(Buffer.from(JSON.stringify(payload)), recipientPassword);
  await expect(restoreCredentialTransfer(expired, recipientPassword, 'expired', localPassword)).rejects.toThrow();
  for (const name of ['wrong', 'corrupt', 'expired']) await expect(fs.stat(getWorkspaceDir(name))).rejects.toMatchObject({ code: 'ENOENT' });
});

test.each(['file_written', 'before_publish'])('interruption at %s preserves source and removes unpublished staging', async step => {
  const envelope = await exported();
  await expect(restoreCredentialTransfer(envelope, recipientPassword, 'interrupted', localPassword, {
    checkpoint: async actual => { if (actual === step) throw new Error('Injected interruption'); },
  })).rejects.toThrow('Injected interruption');
  await expect(fs.stat(getWorkspaceDir('interrupted'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await fs.readdir(path.join(root, 'workspaces'))).some(name => name.startsWith('.credential-transfer-'))).toBe(false);
  expect(await fs.readFile(path.join(getWorkspaceDir('default-workspace'), 'db/models.json'))).toEqual(sourceBytes.get('models'));
});

test('never overwrites an existing or case-equivalent recipient workspace', async () => {
  const envelope = await exported();
  await fs.mkdir(getWorkspaceDir('Recipient'));
  await fs.writeFile(path.join(getWorkspaceDir('Recipient'), 'retained'), 'existing-data');
  await expect(restoreCredentialTransfer(envelope, recipientPassword, 'recipient', localPassword)).rejects.toThrow();
  expect(await fs.readFile(path.join(getWorkspaceDir('Recipient'), 'retained'), 'utf8')).toBe('existing-data');
});

test('corrupt source ciphertext refuses export and retains the exact record', async () => {
  const file = path.join(getWorkspaceDir('default-workspace'), 'db/models.json');
  const bytes = Buffer.from('[{"id":"bad","ApiKey":"encrypted:v2:corrupt"}]');
  await fs.writeFile(file, bytes);
  await expect(exported()).rejects.toThrow();
  expect(await fs.readFile(file)).toEqual(bytes);
});

test('a fresh recipient OS process restores and a third process unlocks after restart without source key access', async () => {
  const file = path.join(root, 'transfer.flujo-transfer');
  await fs.writeFile(file, await exported(), { mode: 0o600 });
  const args = [path.join(__dirname, 'fixtures/recipient-transfer-child.cjs'), process.cwd(), require.resolve('typescript')];
  const env = { ...process.env, LOG_LEVEL: 'error' };
  for (const operation of ['restore', 'read']) {
    const result = spawnSync(process.execPath, args, { env, windowsHide: true, encoding: 'utf8', timeout: 30_000,
      input: JSON.stringify({ operation, file, transferPassphrase: recipientPassword, workspace: 'child-recipient', localPassphrase: localPassword,
        expected: ['v2-canary', 'legacy-canary', 'plaintext-canary'] }) });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('RECIPIENT_SOURCE_PASS');
    expect(result.stdout).not.toContain('canary');
  }
});

async function operatorHeaders(scopes: ('control:admin' | 'secrets:read')[] = ['control:admin', 'secrets:read']) {
  const issued = issueOwnerCredential(scopes, Date.now() + 60_000);
  const policy = path.join(root, 'owner-policy.json');
  await fs.writeFile(policy, JSON.stringify({ schemaVersion: 1, ownerId: 'transfer-owner', credentials: [issued.record] }), { mode: 0o600 });
  process.env.FLUJO_OWNER_AUTH_FILE = policy;
  process.env.FLUJO_EXPOSURE_MODE = 'localhost';
  return { host: 'localhost', authorization: `Bearer ${issued.token}` };
}
function exportRequest(headers: Record<string, string>, confirm = true) {
  return new NextRequest('http://localhost/api/credential-transfer', { method: 'POST', headers,
    body: JSON.stringify({ recipientPassphrase: recipientPassword, confirmCredentialTransfer: confirm }) });
}
test('actual export route requires owner secret authority, loopback, confirmation and unlocked source', async () => {
  const headers = await operatorHeaders();
  expect((await exportRoute(exportRequest({ host: 'localhost' }))).status).toBe(401);
  expect((await exportRoute(exportRequest({ ...headers, origin: 'https://attacker.example' }))).status).toBe(403);
  expect((await exportRoute(exportRequest(headers, false))).status).toBe(400);
  const response = await exportRoute(exportRequest(headers));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const binary = Buffer.from(await response.arrayBuffer());
  expect(binary.toString()).not.toContain('canary');
  const payload = await openRecipientTransfer(binary, recipientPassword);
  expect(JSON.parse(payload.toString()).records.mcp_servers).toHaveProperty('server');
  payload.fill(0);
  const insufficient = await operatorHeaders(['control:admin']);
  expect((await exportRoute(exportRequest(insufficient))).status).toBe(403);
  const restored = await operatorHeaders();
  global.__flujo_server_dek = undefined;
  global.__flujo_server_deks_by_workspace = undefined;
  expect((await exportRoute(exportRequest(restored))).status).toBe(423);
});
test('actual restore route creates a fresh private workspace while source remains locked', async () => {
  const envelope = await exported();
  const headers = await operatorHeaders();
  global.__flujo_server_dek = undefined;
  global.__flujo_server_deks_by_workspace = undefined;
  const request = (confirmation: boolean, name: string) => {
    const form = new FormData();
    form.set('file', new File([new Uint8Array(envelope)], 'transfer.flujo-transfer'));
    form.set('recipientPassphrase', recipientPassword);
    form.set('localPassphrase', localPassword);
    form.set('workspace', name);
    form.set('confirmCredentialTransfer', String(confirmation));
    return new NextRequest('http://localhost/api/credential-transfer/restore', { method: 'POST', headers, body: form });
  };
  expect((await restoreRoute(request(false, 'refused'))).status).toBe(400);
  await expect(fs.stat(getWorkspaceDir('refused'))).rejects.toMatchObject({ code: 'ENOENT' });
  const response = await restoreRoute(request(true, 'http-recipient'));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ success: true, workspace: 'http-recipient', encryptionProtection: 'passphrase' });
  expect(await fs.readFile(path.join(getWorkspaceDir('default-workspace'), 'db/encryption_key.json'))).toEqual(sourceBytes.get('encryption_key'));
});

test('legacy MCP array records normalize to production keyed maps while malformed entries fail closed', async () => {
  const file = path.join(getWorkspaceDir('default-workspace'), 'db/mcp_servers.json');
  await fs.writeFile(file, JSON.stringify([{ name: 'legacy-array', oauthTokens: { access_token: 'legacy-array-canary' } }]));
  await restoreCredentialTransfer(await exported(), recipientPassword, 'legacy-array-recipient', localPassword);
  const records = await readStore('legacy-array-recipient', 'mcp_servers');
  expect(Array.isArray(records)).toBe(false);
  expect(records['legacy-array'].disabled).toBe(true);
  const loaded = await runWithWorkspace('legacy-array-recipient', () => loadServerConfigs());
  expect(loaded).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'legacy-array', disabled: true })]));
  const ring = await unwrapKeyring(await readStore('legacy-array-recipient', 'encryption_key'), localPassword);
  expect(open(records['legacy-array'].oauthTokens.access_token.slice('encrypted:'.length), ring.activeKey, 'flujo:secret:v2')).toBe('legacy-array-canary');
  await fs.writeFile(file, '{"invalid":"not-a-config"}');
  await expect(exported()).rejects.toThrow();
  expect(await fs.readFile(file, 'utf8')).toBe('{"invalid":"not-a-config"}');
});

test.each([
  { records: [{ name: 'duplicate' }, { name: 'duplicate' }] },
  { records: [{ name: '' }] },
  { records: [{ name: '   ' }] },
  { records: [{}] },
])('legacy arrays with ambiguous or missing names refuse export without source changes: %j', async ({ records }) => {
  const file = path.join(getWorkspaceDir('default-workspace'), 'db/mcp_servers.json');
  const bytes = Buffer.from(JSON.stringify(records));
  await fs.writeFile(file, bytes);
  await expect(exported()).rejects.toThrow();
  expect(await fs.readFile(file)).toEqual(bytes);
});
