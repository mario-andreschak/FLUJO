import { auth as authV1 } from '@modelcontextprotocol/sdk/client/auth.js';
import { auth as authV2 } from '@modelcontextprotocol/client';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { MCPStreamableConfig } from '@/shared/types/mcp';
import { runWithWorkspace } from '@/utils/workspace';
import { installPrivateProfileFixture, unlockPrivateFixtureInCurrentWorkspace } from '../utils/privateProfileFixture';

const mockLoadConfigs = jest.fn();
const mockSaveConfigs = jest.fn();
jest.mock('@/backend/services/mcp/config', () => ({
  loadServerConfigs: () => mockLoadConfigs(), saveConfig: (configs: unknown) => mockSaveConfigs(configs),
}));

import { MCPOAuthClientProvider, matchesOAuthState, oauthStateWorkspace } from '@/backend/services/mcp/oauth';
import { FLUJO_OAUTH_CLIENT_METADATA_URL, resolveOAuthClientMetadataUrl } from '@/backend/services/mcp/oauthClientMetadata';
import hostedMetadata from '../../githubpages/oauth/client-metadata.json';

const issuer = 'https://auth.cimd.example/tenant';
const serverUrl = 'https://mcp.cimd.example/mcp';
const callback = 'http://localhost:4200/api/oauth/callback';
let config: MCPStreamableConfig;
let privateFixture: Awaited<ReturnType<typeof installPrivateProfileFixture>>;
const originalMetadataUrl = process.env.FLUJO_OAUTH_CLIENT_METADATA_URL;

beforeEach(async () => {
  delete process.env.FLUJO_OAUTH_CLIENT_METADATA_URL;
  privateFixture = await installPrivateProfileFixture();
  await mkdir(path.join(privateFixture.root, 'workspaces', 'team-a', 'db'), { recursive: true });
  await runWithWorkspace('team-a', () => unlockPrivateFixtureInCurrentWorkspace());
  config = { name: 'cimd-test', transport: 'streamable', serverUrl, disabled: true,
    rootPath: '', env: {}, _buildCommand: '', _installCommand: '' };
  mockLoadConfigs.mockReset().mockResolvedValue([config]);
  mockSaveConfigs.mockReset().mockResolvedValue({ success: true });
});
afterEach(async () => {
  if (originalMetadataUrl === undefined) delete process.env.FLUJO_OAUTH_CLIENT_METADATA_URL;
  else process.env.FLUJO_OAUTH_CLIENT_METADATA_URL = originalMetadataUrl;
  await privateFixture?.restore();
});

function authorizationServer(cimd: boolean, dcr = true) {
  const requests: Array<{ url: string; body: URLSearchParams; method: string }> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = new URLSearchParams(String(init?.body ?? ''));
    requests.push({ url: url.href, body, method: init?.method ?? 'GET' });
    const value = url.pathname.endsWith('/token')
      ? { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_in: 3600 }
      : url.pathname.endsWith('/register')
        ? { client_id: 'legacy-dcr', client_secret: 'synthetic-secret', redirect_uris: [`${callback}?workspace=team-a`] }
        : url.pathname.includes('oauth-protected-resource')
          ? { resource: serverUrl, authorization_servers: [issuer], scopes_supported: ['read'] }
          : { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
            response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
            ...(cimd ? { client_id_metadata_document_supported: true } : {}),
            ...(dcr ? { registration_endpoint: `${issuer}/register` } : {}) };
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  };
  return { fetchFn, requests };
}

describe.each([['v1', authV1], ['v2', authV2]] as const)('%s CIMD authorization', (_version, auth) => {
  it.each([true, false])('uses CIMD with DCR advertised=%s and exchanges without a client secret', async dcr => {
    const { fetchFn, requests } = authorizationServer(true, dcr);
    const provider = new MCPOAuthClientProvider(config, `${callback}?workspace=team-a`);
    await expect(runWithWorkspace('team-a', () => auth(provider, { serverUrl, fetchFn })))
      .rejects.toMatchObject({ name: 'OAuthAuthenticationRequired' });
    const authorization = new URL(config.authorizationUrl!);
    expect(authorization.searchParams.get('client_id')).toBe(FLUJO_OAUTH_CLIENT_METADATA_URL);
    expect(hostedMetadata.redirect_uris).toContain(authorization.searchParams.get('redirect_uri'));
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(requests.some(request => request.url.endsWith('/register'))).toBe(false);
    const state = authorization.searchParams.get('state')!;
    expect(oauthStateWorkspace(state)).toBe('team-a');
    expect(matchesOAuthState(config, state, 'team-a')).toBe(true);
    expect(matchesOAuthState(config, state.replace('team-a', 'team-b'), 'team-b')).toBe(false);

    const resumed = new MCPOAuthClientProvider(config, `${callback}?workspace=team-a`, config.oauthStateDiscovery);
    await expect(runWithWorkspace('team-a', () => auth(resumed, { serverUrl, fetchFn, authorizationCode: 'synthetic-code' })))
      .resolves.toBe('AUTHORIZED');
    const tokenRequest = requests.find(request => request.url.endsWith('/token'))!;
    expect(tokenRequest.body.get('client_id')).toBe(FLUJO_OAUTH_CLIENT_METADATA_URL);
    expect(tokenRequest.body.get('redirect_uri')).toBe(callback);
    expect(tokenRequest.body.has('client_secret')).toBe(false);
    expect(tokenRequest.body.get('code_verifier')).toBeTruthy();
    await expect(runWithWorkspace('team-a', () => resumed.tokens()))
      .resolves.toMatchObject({ access_token: 'synthetic-access', issuer });
  });

  it('retains DCR registration and workspace redirects when CIMD is not advertised', async () => {
    const { fetchFn, requests } = authorizationServer(false);
    const provider = new MCPOAuthClientProvider(config, `${callback}?workspace=team-a`);
    await expect(runWithWorkspace('team-a', () => auth(provider, { serverUrl, fetchFn })))
      .rejects.toMatchObject({ name: 'OAuthAuthenticationRequired' });
    const authorization = new URL(config.authorizationUrl!);
    expect(authorization.searchParams.get('client_id')).toBe('legacy-dcr');
    expect(authorization.searchParams.get('redirect_uri')).toBe(`${callback}?workspace=team-a`);
    expect(config.oauthState).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(requests.some(request => request.url.endsWith('/register'))).toBe(true);
  });

  it('preserves an existing issuer-bound registration when the server adds CIMD', async () => {
    config.oauthClientInformation = { client_id: 'existing-client', issuer };
    const { fetchFn, requests } = authorizationServer(true);
    const provider = new MCPOAuthClientProvider(config, `${callback}?workspace=team-a`);
    await expect(auth(provider, { serverUrl, fetchFn })).rejects.toMatchObject({ name: 'OAuthAuthenticationRequired' });
    expect(new URL(config.authorizationUrl!).searchParams.get('client_id')).toBe('existing-client');
    expect(provider.redirectUrl).toBe(`${callback}?workspace=team-a`);
    expect(requests.some(request => request.url.endsWith('/register'))).toBe(false);
  });
});

it('requires deployment metadata for callbacks outside the published allowlist', () => {
  expect(resolveOAuthClientMetadataUrl('https://my-flujo.example/api/oauth/callback')).toBeUndefined();
  expect(resolveOAuthClientMetadataUrl('http://localhost:4300/api/oauth/callback')).toBeUndefined();
  process.env.FLUJO_OAUTH_CLIENT_METADATA_URL = 'https://my-flujo.example/client.json';
  expect(resolveOAuthClientMetadataUrl('https://my-flujo.example/api/oauth/callback')).toBe('https://my-flujo.example/client.json');
});

it.each(['http://example.com/client.json', 'https://example.com/', 'https://user:secret@example.com/client.json',
  'https://example.com/client.json#fragment', ' https://example.com/client.json', ''])('rejects invalid configured document URL %s', url => {
  process.env.FLUJO_OAUTH_CLIENT_METADATA_URL = url;
  expect(() => resolveOAuthClientMetadataUrl(callback)).toThrow(/FLUJO_OAUTH_CLIENT_METADATA_URL/);
});

it.each(['../team-a.' + 'a'.repeat(43), '.'.concat('a'.repeat(43)), 'team-a.short', 'CON.' + 'a'.repeat(43)])(
  'rejects malformed workspace routing state %s', state => {
    expect(oauthStateWorkspace(state)).toBeUndefined();
  },
);

it('treats malformed stored state as an invalid callback instead of throwing', () => {
  config.oauthState = 42 as unknown as string;
  config.oauthStateWorkspace = 'team-a';
  config.oauthStateCreatedAt = Date.now();
  expect(matchesOAuthState(config, 'team-a.' + 'a'.repeat(43), 'team-a')).toBe(false);
});
