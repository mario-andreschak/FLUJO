import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { MCPStreamableConfig } from '@/shared/types/mcp';
import { MCPOAuthClientProvider } from '@/backend/services/mcp/oauth';
import { MCPService } from '@/backend/services/mcp';
import { loadServerConfigs, saveConfig } from '@/backend/services/mcp/config';
import { getServerDek, lockServer, unlockServer } from '@/utils/encryption/session';
import { getWorkspaceDataDir, runWithWorkspace } from '@/utils/workspace';
import { sealOAuthCredential } from '@/backend/services/mcp/oauthCredentialStorage';
import { encryptWithPassword, isEncryptionLocked } from '@/utils/encryption/secure';
import { loadItem, saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import type { EncryptionMetadata } from '@/utils/encryption/format';
import { enrollPrivateEncryptionFixture } from '../utils/privateEncryptionFixture';

const tokens = {
  access_token: 'synthetic-access-private', refresh_token: 'synthetic-refresh-private',
  token_type: 'bearer', expires_in: 60, id_token: 'synthetic-id-private',
  extension: { nested: ['synthetic-extension-private', 42042] },
} as OAuthTokens;
const client: OAuthClientInformationFull = {
  client_id: 'client', client_secret: 'synthetic-client-private',
  redirect_uris: ['http://127.0.0.1:4200/api/oauth/callback'],
  jwks: { keys: [{ kty: 'oct', k: 'synthetic-registration-jwk-private' }] },
};
let config: MCPStreamableConfig;
let provider: MCPOAuthClientProvider;
const redirect = 'http://127.0.0.1:4200/api/oauth/callback';
const disk = () => fs.readFile(path.join(getWorkspaceDataDir(), 'db', 'mcp_servers.json'), 'utf8');

beforeEach(async () => {
  await enrollPrivateEncryptionFixture();
  config = { name: 'private-oauth', transport: 'streamable', serverUrl: 'https://oauth.invalid/mcp',
    disabled: true, rootPath: '', env: {}, _buildCommand: '', _installCommand: '' };
  await saveConfig(new Map([[config.name, config]]));
  provider = new MCPOAuthClientProvider(config, redirect);
});

test('real persisted OAuth writes contain authenticated ciphertext and preserve complete SDK values after reload', async () => {
  await provider.saveTokens(tokens);
  await provider.saveClientInformation(client);
  await provider.saveCodeVerifier('synthetic-verifier-private');
  const stored = await disk();
  for (const secret of ['synthetic-access-private', 'synthetic-refresh-private', 'synthetic-id-private',
    'synthetic-extension-private', 'synthetic-client-private', 'synthetic-verifier-private',
    'synthetic-registration-jwk-private', '42042']) {
    expect(stored).not.toContain(secret);
  }
  expect(stored).toContain('v2:');
  const loaded = await loadServerConfigs();
  if (!Array.isArray(loaded)) throw new Error('Fixture config read failed');
  const restored = new MCPOAuthClientProvider(loaded[0] as MCPStreamableConfig, redirect);
  await expect(restored.tokens()).resolves.toMatchObject(tokens);
  await expect(restored.clientInformation()).resolves.toMatchObject(client);
  await expect(restored.codeVerifier()).resolves.toBe('synthetic-verifier-private');
});

test('locked credential saves fail without replacing persisted or active credentials', async () => {
  await provider.saveTokens(tokens);
  const before = await disk();
  const active = JSON.stringify(config);
  lockServer();
  await expect(provider.saveTokens(tokens)).rejects.toThrow();
  expect(await disk()).toBe(before);
  expect(JSON.stringify(config)).toBe(active);
});

test('locked credential reads fail and retain the encrypted records', async () => {
  await provider.saveTokens(tokens);
  await provider.saveClientInformation(client);
  await provider.saveCodeVerifier('synthetic-verifier-private');
  const before = await disk();
  lockServer();
  await expect(provider.tokens()).rejects.toThrow();
  await expect(provider.clientInformation()).rejects.toThrow();
  await expect(provider.codeVerifier()).rejects.toThrow();
  expect(await disk()).toBe(before);
});

test('legacy plaintext is readable without destructive automatic migration', async () => {
  const extended = { ...tokens, format: 'provider-format', ciphertext: 'synthetic-provider-extension' };
  config.oauthTokens = extended;
  config.oauthClientInformation = client;
  config.oauthCodeVerifier = 'synthetic-verifier-private';
  await saveConfig(new Map([[config.name, config]]));
  const before = await disk();
  await expect(provider.tokens()).resolves.toMatchObject(extended);
  await expect(provider.clientInformation()).resolves.toMatchObject(client);
  await expect(provider.codeVerifier()).resolves.toBe('synthetic-verifier-private');
  expect(await disk()).toBe(before);
});

test('legacy plaintext and manually registered client secrets cannot bypass a locked workspace', async () => {
  config.oauthTokens = tokens;
  config.oauthClientInformation = client;
  config.oauthCodeVerifier = 'synthetic-verifier-private';
  await saveConfig(new Map([[config.name, config]]));
  const before = await disk();
  lockServer();
  await expect(provider.tokens()).rejects.toThrow('Stored OAuth credentials are unavailable');
  await expect(provider.clientInformation()).rejects.toThrow('Stored OAuth credentials are unavailable');
  await expect(provider.codeVerifier()).rejects.toThrow('Stored OAuth credentials are unavailable');
  const manual = new MCPOAuthClientProvider({ ...config, oauthClientInformation: undefined,
    oauthClientId: 'manual', oauthClientSecret: 'synthetic-manual-private' }, redirect);
  await expect(manual.clientInformation()).rejects.toThrow('Stored OAuth credentials are unavailable');
  expect(await disk()).toBe(before);
});

test('an encrypted record copied to a different workspace is refused', async () => {
  await provider.saveTokens(tokens);
  await runWithWorkspace('copied-workspace', async () => {
    await enrollPrivateEncryptionFixture();
    const copied = new MCPOAuthClientProvider({ ...config }, redirect);
    await expect(copied.tokens()).rejects.toThrow();
  });
});

test('workspace binding refuses a copied envelope even when its key metadata was deliberately copied', async () => {
  await provider.saveTokens(tokens);
  const metadata = await loadItem<EncryptionMetadata | null>(StorageKey.ENCRYPTION_KEY, null);
  const dek = getServerDek();
  if (!metadata || !dek) throw new Error('Fixture key unavailable');
  await runWithWorkspace('copied-key-workspace', async () => {
    await saveItem(StorageKey.ENCRYPTION_KEY, metadata);
    unlockServer(dek);
    expect(await isEncryptionLocked()).toBe(false);
    const copied = new MCPOAuthClientProvider({ ...config }, redirect);
    await expect(copied.tokens()).rejects.toThrow('Stored OAuth credentials are unavailable');
  });
});

test('an authenticated credential copied to a different OAuth purpose is refused', async () => {
  await provider.saveTokens(tokens);
  const stored = config.oauthTokens;
  if (!stored || !('ciphertext' in stored) || typeof stored.ciphertext !== 'string') throw new Error('Expected fixture envelope');
  config.oauthClientInformation = { format: 'flujo-oauth-v1', ciphertext: stored.ciphertext };
  await expect(provider.clientInformation()).rejects.toThrow('Stored OAuth credentials are unavailable');
});

test.each(['tokens', 'client', 'verifier'] as const)('authenticated ciphertext tampering is refused for %s without rewriting storage', async kind => {
  await provider.saveTokens(tokens);
  await provider.saveClientInformation(client);
  await provider.saveCodeVerifier('synthetic-verifier-private');
  const key = kind === 'tokens' ? 'oauthTokens' : kind === 'client' ? 'oauthClientInformation' : 'oauthCodeVerifier';
  const envelope = config[key];
  if (!envelope || typeof envelope !== 'object' || !('ciphertext' in envelope)) throw new Error('Expected fixture envelope');
  const parts = envelope.ciphertext.split(':');
  parts[2] = `${parts[2][0] === '0' ? '1' : '0'}${parts[2].slice(1)}`;
  config[key] = { format: 'flujo-oauth-v1', ciphertext: parts.join(':') };
  const before = await disk();
  await expect(kind === 'tokens' ? provider.tokens() : kind === 'client' ? provider.clientInformation() : provider.codeVerifier())
    .rejects.toThrow('Stored OAuth credentials are unavailable');
  expect(await disk()).toBe(before);
});

test('oversized serialization fails before any credential replacement', async () => {
  await provider.saveTokens(tokens);
  const before = await disk();
  const active = JSON.stringify(config);
  await expect(provider.saveTokens({ ...tokens, access_token: 'x'.repeat(256 * 1024) }))
    .rejects.toThrow('OAuth credential encryption failed');
  expect(await disk()).toBe(before);
  expect(JSON.stringify(config)).toBe(active);
});

test('malformed claimed envelopes fail closed with fixed diagnostics', async () => {
  config.oauthTokens = { format: 'flujo-oauth-v1', ciphertext: 'v2:synthetic-private-parser-input' };
  try { await provider.tokens(); throw new Error('Expected refusal'); } catch (error) {
    expect((error as Error).message).toBe('Stored OAuth credentials are unavailable. Unlock this workspace or restore matching credentials.');
    expect((error as Error).cause).toBeUndefined();
  }
});

test('authenticated but malformed provider payloads are refused', async () => {
  const ciphertext = await encryptWithPassword(JSON.stringify({ format: 'flujo-oauth-v1', kind: 'tokens',
    workspace: 'default-workspace', value: { access_token: 42, token_type: 'bearer' } }));
  if (!ciphertext) throw new Error('Fixture encryption failed');
  config.oauthTokens = { format: 'flujo-oauth-v1', ciphertext };
  await expect(provider.tokens()).rejects.toThrow('Stored OAuth credentials are unavailable');
});

test('malformed new SDK values never replace previous credentials', async () => {
  const before = await disk();
  await expect(sealOAuthCredential('tokens', { access_token: 42, token_type: 'bearer' }))
    .rejects.toThrow('OAuth credential encryption failed');
  await expect(sealOAuthCredential('client', { client_id: 'client', client_secret: {} }))
    .rejects.toThrow('OAuth credential encryption failed');
  await expect(sealOAuthCredential('verifier', undefined)).rejects.toThrow('OAuth credential encryption failed');
  expect(await disk()).toBe(before);
});

test('encrypted expired tokens retain refresh readiness through the real status reader', async () => {
  await provider.saveTokens({ ...tokens, expires_in: -1 });
  config.disabled = false;
  config.oauthScopes = ['read'];
  await saveConfig(new Map([[config.name, config]]));
  const status = await new MCPService().getServerStatus(config.name);
  expect(status.status).not.toBe('requires_authentication');
  await expect(provider.tokens()).resolves.toMatchObject({ access_token: tokens.access_token, refresh_token: tokens.refresh_token });
});

test('explicit invalidation removes encrypted OAuth credentials and retains unrelated config', async () => {
  await provider.saveTokens(tokens);
  await provider.saveClientInformation(client);
  await provider.saveCodeVerifier('synthetic-verifier-private');
  await provider.invalidateCredentials('all');
  await expect(provider.tokens()).resolves.toBeUndefined();
  await expect(provider.clientInformation()).resolves.toBeUndefined();
  await expect(provider.codeVerifier()).rejects.toThrow();
  const stored = JSON.parse(await disk())[config.name];
  expect(stored.oauthTokens).toBeUndefined();
  expect(stored.oauthClientInformation).toBeUndefined();
  expect(stored.oauthCodeVerifier).toBeUndefined();
  expect(stored.serverUrl).toBe(config.serverUrl);
});
