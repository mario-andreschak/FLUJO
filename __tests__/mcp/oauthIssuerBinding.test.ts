import { auth as authV1, fetchToken as fetchTokenV1 } from '@modelcontextprotocol/sdk/client/auth.js';
import { auth as authV2, fetchToken as fetchTokenV2, type OAuthClientProvider as BetaOAuthClientProvider } from '@modelcontextprotocol/client';
import type { MCPStreamableConfig } from '@/shared/types/mcp';

const mockLoadConfigs = jest.fn();
const mockSaveConfigs = jest.fn();
const mockDecrypt = jest.fn();
jest.mock('@/backend/services/mcp/config', () => ({
  loadServerConfigs: () => mockLoadConfigs(), saveConfig: (configs: unknown) => mockSaveConfigs(configs),
}));
jest.mock('@/backend/utils/resolveGlobalVars', () => ({ resolveAndDecryptApiKey: (value: string) => mockDecrypt(value) }));
jest.mock('@/utils/logger', () => ({ createLogger: () => ({
  info: jest.fn(), verbose: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn(),
}) }));

import { MCPOAuthClientProvider } from '@/backend/services/mcp/oauth';
import { isOAuthAuthenticationError } from '@/utils/mcp/utils';

const trustedIssuer = 'https://authorization.example.test/tenant/';
const changedIssuer = 'https://changed-authorization.example.test/tenant/';
const serverUrl = 'https://mcp.example.test/mcp';
const redirectUri = 'http://127.0.0.1:4200/api/oauth/callback';
const oldTokens = { access_token: 'synthetic-old-access', refresh_token: 'synthetic-old-refresh', token_type: 'bearer' };
const oldClient = { client_id: 'synthetic-old-client', client_secret: 'synthetic-old-client-secret' };

let config: MCPStreamableConfig;
let provider: MCPOAuthClientProvider;
beforeEach(() => {
  mockLoadConfigs.mockReset();
  mockSaveConfigs.mockReset().mockResolvedValue({ success: true });
  mockDecrypt.mockReset().mockResolvedValue('synthetic-manual-secret');
  config = { name: 'issuer-test', transport: 'streamable', serverUrl, disabled: true, rootPath: '', env: {},
    _buildCommand: '', _installCommand: '',
    oauthClientInformation: { ...oldClient }, oauthTokens: { ...oldTokens }, oauthCodeVerifier: 'synthetic-verifier' };
  mockLoadConfigs.mockResolvedValue([config]);
  provider = new MCPOAuthClientProvider(config, redirectUri);
});

it('withholds legacy credentials without deleting or stamping them from configuration', async () => {
  config.oauthIssuer = trustedIssuer;
  const before = JSON.stringify(config);
  await expect(provider.clientInformation()).resolves.toBeUndefined();
  await expect(provider.tokens()).resolves.toBeUndefined();
  expect(JSON.stringify(config)).toBe(before);
  expect(mockSaveConfigs).not.toHaveBeenCalled();
});

it.each([undefined, null, '', '   ', 42])('withholds malformed credential issuer %s', async issuer => {
  config.oauthClientInformation = { ...oldClient, issuer } as unknown as MCPStreamableConfig['oauthClientInformation'];
  config.oauthTokens = { ...oldTokens, issuer } as unknown as MCPStreamableConfig['oauthTokens'];
  await expect(provider.clientInformation()).resolves.toBeUndefined();
  await expect(provider.tokens()).resolves.toBeUndefined();
  expect(mockSaveConfigs).not.toHaveBeenCalled();
});

it('retains an exact SDK issuer and registration metadata across a narrower client save', async () => {
  await provider.saveClientInformation({ ...oldClient, issuer: trustedIssuer,
    redirect_uris: [redirectUri], client_name: 'synthetic-registration', scope: 'read write' });
  const metadata = config.oauthClientMetadata;
  await provider.saveClientInformation({ ...oldClient, issuer: trustedIssuer });
  expect(config.oauthClientInformation?.issuer).toBe(trustedIssuer);
  expect(config.oauthClientMetadata).toBe(metadata);
  const saved = (mockSaveConfigs.mock.calls[1][0] as Map<string, MCPStreamableConfig>).get(config.name)!;
  expect(saved.oauthClientInformation?.issuer).toBe(trustedIssuer);
  expect(saved.oauthClientMetadata).toEqual(metadata);
});

it('keeps issuer and expiration tracking only after a successful token save', async () => {
  await provider.saveTokens({ ...oldTokens, issuer: trustedIssuer, expires_in: 3600 });
  expect(config.oauthTokens?.issuer).toBe(trustedIssuer);
  expect((config.oauthTokens as { issued_at?: number }).issued_at).toEqual(expect.any(Number));
  const before = JSON.stringify(config);
  mockSaveConfigs.mockResolvedValueOnce({ success: false, error: 'synthetic-storage-secret' });
  await expect(provider.saveTokens({ ...oldTokens, issuer: changedIssuer })).rejects.toThrow('OAuth credential persistence failed');
  expect(JSON.stringify(config)).toBe(before);
});

it.each([undefined, '', 'not-a-url', 'https://user:password@example.test', 'https://authorization.example.test?query=1'])
('refuses pre-registered credentials before resolving a secret when trusted issuer is %s', async oauthIssuer => {
  config.oauthClientId = 'synthetic-manual-client';
  config.oauthClientSecret = 'encrypted:synthetic-secret';
  config.oauthIssuer = oauthIssuer;
  const before = JSON.stringify(config);
  let rejected: unknown;
  try { await provider.clientInformation(); } catch (error) { rejected = error; }
  expect(rejected).toMatchObject({ name: 'OAuthIssuerRequired', message: expect.stringContaining('Set oauthIssuer') });
  expect(isOAuthAuthenticationError(rejected)).toBe(true);
  expect(String(rejected)).not.toContain(config.oauthClientSecret);
  expect(mockDecrypt).not.toHaveBeenCalled();
  expect(mockSaveConfigs).not.toHaveBeenCalled();
  expect(JSON.stringify(config)).toBe(before);
});

it('binds manual credentials only to operator configuration while ignoring v2 discovery context', async () => {
  config.oauthClientId = 'synthetic-manual-client';
  config.oauthClientSecret = 'encrypted:synthetic-secret';
  config.oauthIssuer = trustedIssuer;
  const beta: BetaOAuthClientProvider = provider;
  await expect(beta.clientInformation({ issuer: changedIssuer })).resolves.toEqual({
    client_id: 'synthetic-manual-client', client_secret: 'synthetic-manual-secret', issuer: trustedIssuer,
  });
  await expect(beta.tokens({ issuer: changedIssuer })).resolves.toBeUndefined();
  expect(mockSaveConfigs).not.toHaveBeenCalled();
});

/** All discovery/registration/token responses are synthetic; this never performs network I/O. */
function syntheticFetch(issuer: string) {
  const requests: { url: string; method: string; body: string; headers: string }[] = [];
  const metadata = { issuer, authorization_endpoint: `${issuer}authorize`, token_endpoint: `${issuer}token`,
    registration_endpoint: `${issuer}register`, response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_post'] };
  const fetchFn: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    requests.push({ url: url.href, method: options?.method ?? 'GET', body: String(options?.body ?? ''),
      headers: JSON.stringify(Array.from(new Headers(options?.headers).entries())) });
    const body = options?.method === 'POST'
      ? url.pathname.endsWith('/register')
        ? { client_id: 'synthetic-fresh-client', client_secret: 'synthetic-fresh-secret', redirect_uris: [redirectUri] }
        : { access_token: 'synthetic-refreshed-access', refresh_token: 'synthetic-refreshed-refresh', token_type: 'bearer',
          expires_in: 3600, issuer: changedIssuer }
      : url.pathname.includes('oauth-protected-resource')
        ? { resource: 'https://mcp.example.test', authorization_servers: [issuer], scopes_supported: ['read'] }
        : metadata;
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  return { fetchFn, requests, metadata };
}

describe.each([['v1', authV1, fetchTokenV1], ['v2', authV2, fetchTokenV2]] as const)
('%s patched SDK credential binding', (_version, auth, fetchToken) => {
  it('starts fresh interactive authorization without sending legacy client or refresh secrets', async () => {
    const { fetchFn, requests } = syntheticFetch(trustedIssuer);
    await expect(auth(provider, { serverUrl, fetchFn })).rejects.toMatchObject({ name: 'OAuthAuthenticationRequired' });
    const sent = JSON.stringify(requests);
    expect(sent).not.toContain(oldClient.client_secret);
    expect(sent).not.toContain(oldTokens.refresh_token);
    expect(requests.filter(request => request.method === 'POST').map(request => request.url)).toEqual([`${trustedIssuer}register`]);
    expect(config.oauthClientInformation?.issuer).toBe(trustedIssuer);
    expect(new URL(config.authorizationUrl!).searchParams.get('client_id')).toBe('synthetic-fresh-client');
    expect(config.oauthState).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('does not send previously pinned secrets when discovery changes issuer', async () => {
    config.oauthClientInformation = { ...oldClient, issuer: trustedIssuer };
    config.oauthTokens = { ...oldTokens, issuer: trustedIssuer };
    const { fetchFn, requests } = syntheticFetch(changedIssuer);
    await expect(auth(provider, { serverUrl, fetchFn })).rejects.toMatchObject({ name: 'OAuthAuthenticationRequired' });
    expect(JSON.stringify(requests)).not.toContain(oldClient.client_secret);
    expect(JSON.stringify(requests)).not.toContain(oldTokens.refresh_token);
    expect(requests.some(request => request.url.endsWith('/token'))).toBe(false);
  });

  it('refreshes valid pinned credentials and overwrites a forged wire issuer with the SDK stamp', async () => {
    config.oauthClientInformation = { ...oldClient, issuer: trustedIssuer };
    config.oauthTokens = { ...oldTokens, issuer: trustedIssuer, expires_in: 1 };
    const { fetchFn, requests } = syntheticFetch(trustedIssuer);
    await expect(auth(provider, { serverUrl, fetchFn })).resolves.toBe('AUTHORIZED');
    expect(requests.filter(request => request.method === 'POST').map(request => request.url)).toEqual([`${trustedIssuer}token`]);
    expect(requests.find(request => request.method === 'POST')?.body).toContain(oldTokens.refresh_token);
    expect(config.oauthTokens).toMatchObject({ issuer: trustedIssuer, refresh_token: 'synthetic-refreshed-refresh' });
    await expect(provider.tokens()).resolves.toBe(config.oauthTokens);
  });

  it('rejects mismatched manual credentials before a token request or verifier read', async () => {
    config.oauthClientId = 'synthetic-manual-client';
    config.oauthClientSecret = 'encrypted:synthetic-secret';
    config.oauthIssuer = trustedIssuer;
    const { fetchFn, requests, metadata } = syntheticFetch(changedIssuer);
    const verifier = jest.spyOn(provider, 'codeVerifier');
    await expect(fetchToken(provider, changedIssuer, { metadata, authorizationCode: 'synthetic-code', fetchFn })).rejects.toThrow();
    expect(requests).toEqual([]);
    expect(verifier).not.toHaveBeenCalled();
  });
});
