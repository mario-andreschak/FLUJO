import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installPrivateProfileFixture } from '../utils/privateProfileFixture';
import { MCPOAuthClientProvider } from '@/backend/services/mcp/oauth';
import { loadServerConfigs, saveConfig } from '@/backend/services/mcp/config';
import { lockServer } from '@/utils/encryption/session';
import { authenticate } from '@/utils/encryption/secure';
import { encryptApiKey } from '@/backend/services/model/encryption';
import { parseOAuthCredential, serializeOAuthCredential } from '@/backend/services/mcp/oauthCredentialStorage';
import type { MCPStreamableConfig } from '@/shared/types/mcp';

let fixture: Awaited<ReturnType<typeof installPrivateProfileFixture>>;
let config: MCPStreamableConfig;
const issuer = 'https://authorization.invalid';
const tokens = { access_token: 'access-canary', refresh_token: 'refresh-canary', id_token: 'identity-canary',
  token_type: 'bearer', issuer, expires_in: 1 };
const client = { client_id: 'client', client_secret: 'client-canary', issuer };
const provider = (value = config) => new MCPOAuthClientProvider(value, 'http://localhost:4200/api/oauth/callback');
async function reloaded() {
  const configs = await loadServerConfigs();
  if (!Array.isArray(configs)) throw new Error('Fixture configs unavailable');
  return configs.find(value => value.name === config.name) as MCPStreamableConfig;
}
beforeEach(async () => {
  fixture = await installPrivateProfileFixture();
  config = { name: 'encrypted-oauth', transport: 'streamable', serverUrl: 'https://mcp.invalid',
    env: {}, rootPath: '', disabled: true, _buildCommand: '', _installCommand: '' };
  await saveConfig(new Map([[config.name, config]]));
});
afterEach(async () => { await fixture?.restore(); });

test('actual persisted credentials are encrypted and a recreated unlocked provider returns SDK plaintext', async () => {
  const original = provider();
  await original.saveTokens(tokens);
  await original.saveClientInformation(client);
  await original.saveCodeVerifier('verifier-canary');
  const stored = await reloaded();
  const disk = await fs.readFile(path.join(fixture.root, 'workspaces/default-workspace/db/mcp_servers.json'), 'utf8');
  for (const secret of ['access-canary', 'refresh-canary', 'identity-canary', 'client-canary', 'verifier-canary']) {
    expect(disk).not.toContain(secret);
  }
  for (const value of [stored.oauthTokens, stored.oauthClientInformation, stored.oauthCodeVerifier]) {
    expect(value).toMatchObject({ format: 'flujo-oauth-v1', ciphertext: expect.stringMatching(/^v2:/) });
  }
  const restarted = provider(stored);
  await expect(restarted.tokens()).resolves.toMatchObject(tokens);
  await expect(restarted.clientInformation()).resolves.toEqual(client);
  await expect(restarted.codeVerifier()).resolves.toBe('verifier-canary');
  expect(stored.oauthTokens).toMatchObject({ format: 'flujo-oauth-v1' });
});

test('lock and unlock after persisted restart release no credential until the private profile unlocks', async () => {
  await provider().saveTokens(tokens);
  await provider().saveClientInformation(client);
  await provider().saveCodeVerifier('verifier-canary');
  const restarted = provider(await reloaded());
  lockServer();
  for (const read of [() => restarted.tokens(), () => restarted.clientInformation(), () => restarted.codeVerifier()]) {
    await expect(read()).rejects.toThrow('Stored OAuth credentials are unavailable');
  }
  expect(await authenticate('explicit-test-private-profile-passphrase')).toBeTruthy();
  await expect(restarted.tokens()).resolves.toMatchObject(tokens);
  await expect(restarted.clientInformation()).resolves.toEqual(client);
  await expect(restarted.codeVerifier()).resolves.toBe('verifier-canary');
});

test('a separate OS process unlocks persisted OAuth credentials without borrowing the source process key', async () => {
  await provider().saveTokens(tokens);
  await provider().saveClientInformation(client);
  await provider().saveCodeVerifier('verifier-canary');
  const result = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/oauth-provider-child.cjs'),
    process.cwd(), require.resolve('typescript')], {
    windowsHide: true, timeout: 30_000, encoding: 'utf8', env: { ...process.env, LOG_LEVEL: 'error' },
    input: JSON.stringify({ name: config.name, passphrase: 'explicit-test-private-profile-passphrase',
      access: tokens.access_token, refresh: tokens.refresh_token, identity: tokens.id_token,
      secret: client.client_secret, verifier: 'verifier-canary' }),
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('OAUTH_SOURCE_RESTART_PASS');
  expect(result.stderr).toBe('');
}, 40_000);

test('refresh rotation stores the replacement encrypted without destroying issuer or expiration metadata', async () => {
  await provider().saveTokens(tokens);
  const restarted = provider(await reloaded());
  await restarted.saveTokens({ ...tokens, access_token: 'rotated-access', refresh_token: 'rotated-refresh' });
  const stored = await reloaded();
  expect(stored.oauthTokens).toMatchObject({ format: 'flujo-oauth-v1' });
  await expect(provider(stored).tokens()).resolves.toMatchObject({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', issuer, expires_in: 1 });
});

test('legacy plaintext remains readable when unlocked and never mutates the stored object', async () => {
  config.oauthTokens = { ...tokens };
  config.oauthClientInformation = { ...client };
  config.oauthCodeVerifier = 'legacy-verifier';
  const before = JSON.stringify(config);
  await expect(provider().tokens()).resolves.toMatchObject(tokens);
  await expect(provider().clientInformation()).resolves.toEqual(client);
  await expect(provider().codeVerifier()).resolves.toBe('legacy-verifier');
  expect(JSON.stringify(config)).toBe(before);
  lockServer();
  await expect(provider().tokens()).rejects.toThrow('Stored OAuth credentials are unavailable');
});

test('fieldwise encrypted migration records decrypt at provider use without destructive storage rewriting', async () => {
  config.oauthTokens = { ...tokens, access_token: await encryptApiKey(tokens.access_token),
    refresh_token: await encryptApiKey(tokens.refresh_token), id_token: await encryptApiKey(tokens.id_token) };
  config.oauthClientInformation = { ...client, client_secret: await encryptApiKey(client.client_secret) };
  config.oauthCodeVerifier = await encryptApiKey('verifier-canary');
  const before = JSON.stringify(config);
  await expect(provider().tokens()).resolves.toMatchObject(tokens);
  await expect(provider().clientInformation()).resolves.toEqual(client);
  await expect(provider().codeVerifier()).resolves.toBe('verifier-canary');
  expect(JSON.stringify(config)).toBe(before);
});

test('historical failed-encryption plaintext markers require unlock and are replaced only by a new sealed save', async () => {
  config.oauthTokens = { ...tokens, access_token: `encrypted_failed:${tokens.access_token}`,
    refresh_token: `encrypted_failed:${tokens.refresh_token}`, id_token: `encrypted_failed:${tokens.id_token}` };
  config.oauthClientInformation = { ...client, client_secret: `encrypted_failed:${client.client_secret}` };
  config.oauthCodeVerifier = 'encrypted_failed:verifier-canary';
  const legacy = JSON.stringify(config);
  await expect(provider().tokens()).resolves.toMatchObject(tokens);
  await expect(provider().clientInformation()).resolves.toEqual(client);
  await expect(provider().codeVerifier()).resolves.toBe('verifier-canary');
  expect(JSON.stringify(config)).toBe(legacy);
  lockServer();
  await expect(provider().tokens()).rejects.toThrow('Stored OAuth credentials are unavailable');
  await expect(provider().clientInformation()).rejects.toThrow('Stored OAuth credentials are unavailable');
  await expect(provider().codeVerifier()).rejects.toThrow('Stored OAuth credentials are unavailable');
  expect(await authenticate('explicit-test-private-profile-passphrase')).toBeTruthy();
  config.oauthCodeVerifier = 'encrypted_failed:';
  await expect(provider().codeVerifier()).rejects.toThrow('Stored OAuth credentials are unavailable');
  await provider().saveTokens(tokens);
  await provider().saveClientInformation(client);
  await provider().saveCodeVerifier('verifier-canary');
  const disk = await fs.readFile(path.join(fixture.root, 'workspaces/default-workspace/db/mcp_servers.json'), 'utf8');
  expect(disk).not.toContain('encrypted_failed:');
  expect(disk).not.toContain('canary');
  for (const value of [config.oauthTokens, config.oauthClientInformation, config.oauthCodeVerifier]) {
    expect(value).toMatchObject({ format: 'flujo-oauth-v1', ciphertext: expect.stringMatching(/^v2:/) });
  }
});

test('transfer serialization can rebind a decoded full SDK value while rejecting a forged source workspace or purpose', () => {
  const value = { ...tokens, extension: { nested: ['private-extension', 42] } };
  const source = serializeOAuthCredential('tokens', value, 'source-workspace');
  const decoded = parseOAuthCredential('tokens', source, 'source-workspace');
  expect(() => parseOAuthCredential('tokens', source, 'recipient-workspace')).toThrow('Stored OAuth credentials are unavailable');
  expect(() => parseOAuthCredential('client', source, 'source-workspace')).toThrow('Stored OAuth credentials are unavailable');
  const recipient = serializeOAuthCredential('tokens', decoded, 'recipient-workspace');
  expect(parseOAuthCredential('tokens', recipient, 'recipient-workspace')).toEqual(value);
  expect(() => parseOAuthCredential('tokens', recipient, 'source-workspace')).toThrow('Stored OAuth credentials are unavailable');
});

test('a different registered client cannot inherit the previous private JWKS or extension fields', async () => {
  await provider().saveClientInformation({ ...client, redirect_uris: ['http://localhost:4200/api/oauth/callback'],
    jwks: { keys: [{ kty: 'oct', k: 'private-jwk' }] } });
  await provider().saveClientInformation({ ...client, client_id: 'replacement-client' });
  const returned = await provider().clientInformation();
  expect(returned?.client_id).toBe('replacement-client');
  expect(returned).not.toHaveProperty('jwks');
});

test.each(['tokens', 'client', 'verifier'] as const)('locked %s writes preserve all previous disk and active values', async kind => {
  const diskPath = path.join(fixture.root, 'workspaces/default-workspace/db/mcp_servers.json');
  const beforeDisk = await fs.readFile(diskPath);
  const beforeActive = JSON.stringify(config);
  lockServer();
  const operation = kind === 'tokens' ? provider().saveTokens(tokens)
    : kind === 'client' ? provider().saveClientInformation(client) : provider().saveCodeVerifier('verifier-canary');
  await expect(operation).rejects.toThrow('OAuth credential encryption failed');
  expect(await fs.readFile(diskPath)).toEqual(beforeDisk);
  expect(JSON.stringify(config)).toBe(beforeActive);
});

test('corrupt encrypted credentials never return ciphertext, placeholders or partial token sets', async () => {
  config.oauthTokens = { ...tokens, refresh_token: 'encrypted:v2:corrupt' };
  await expect(provider().tokens()).rejects.toThrow('Stored OAuth credentials are unavailable');
  config.oauthClientInformation = { ...client, client_secret: 'encrypted:v2:corrupt' };
  await expect(provider().clientInformation()).rejects.toThrow('Stored OAuth credentials are unavailable');
  config.oauthCodeVerifier = 'encrypted:v2:corrupt';
  await expect(provider().codeVerifier()).rejects.toThrow('Stored OAuth credentials are unavailable');
});
