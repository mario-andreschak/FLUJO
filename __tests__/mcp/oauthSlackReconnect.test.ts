import { auth as authV1 } from '@modelcontextprotocol/sdk/client/auth.js';
import { auth as authV2 } from '@modelcontextprotocol/client';
import type { MCPStreamableConfig } from '@/shared/types/mcp';
import { installPrivateProfileFixture } from '../utils/privateProfileFixture';
import { knownOAuthIssuer } from '@/utils/mcp/oauthIssuer';

const mockLoad = jest.fn();
const mockSave = jest.fn();
jest.mock('@/backend/services/mcp/config', () => ({
  loadServerConfigs: () => mockLoad(), saveConfig: (value: unknown) => mockSave(value),
}));
jest.mock('@/utils/logger', () => ({ createLogger: () => ({
  info: jest.fn(), debug: jest.fn(), verbose: jest.fn(), warn: jest.fn(), error: jest.fn(),
}) }));
import { MCPOAuthClientProvider } from '@/backend/services/mcp/oauth';

const issuer = 'https://mcp.slack.com';
const callback = 'http://localhost:4200/api/oauth/callback?workspace=default-workspace';
let fixture: Awaited<ReturnType<typeof installPrivateProfileFixture>>;
let config: MCPStreamableConfig;
beforeEach(async () => {
  fixture = await installPrivateProfileFixture();
  config = { name: 'mcp-slack-com', transport: 'streamable', serverUrl: `${issuer}/mcp`,
    rootPath: '', env: {}, disabled: true, _buildCommand: '', _installCommand: '',
    oauthClientId: 'synthetic-slack-client', oauthClientSecret: 'synthetic-slack-secret',
    oauthScopes: ['read'], oauthTokens: { access_token: 'synthetic-legacy-access',
      refresh_token: 'synthetic-legacy-refresh', token_type: 'bearer', scope: 'channels:read,chat:write' } };
  mockLoad.mockReset().mockResolvedValue([config]);
  mockSave.mockReset().mockResolvedValue({ success: true });
});
afterEach(async () => { await fixture?.restore(); });

it.each([
  'http://mcp.slack.com/mcp', 'https://mcp.slack.com.evil.test/mcp', 'https://evil.test/mcp',
  'https://mcp.slack.com:444/mcp', 'https://user:secret@mcp.slack.com/mcp',
  'https://mcp.slack.com/mcp?redirect=evil', 'https://mcp.slack.com/other',
])('does not trust a Slack lookalike or alternate endpoint: %s', async serverUrl => {
  expect(knownOAuthIssuer(serverUrl)).toBeUndefined();
  config.serverUrl = serverUrl;
  await expect(new MCPOAuthClientProvider(config, callback).clientInformation())
    .rejects.toMatchObject({ name: 'OAuthIssuerRequired' });
});

it('keeps an explicit issuer authoritative and rejects malformed overrides', async () => {
  config.oauthIssuer = 'https://configured.example.test';
  await expect(new MCPOAuthClientProvider(config, callback).clientInformation())
    .resolves.toMatchObject({ issuer: config.oauthIssuer });
  config.oauthIssuer = 'not-a-url';
  await expect(new MCPOAuthClientProvider(config, callback).clientInformation())
    .rejects.toMatchObject({ name: 'OAuthIssuerRequired' });
});

describe.each([['v1', authV1], ['v2', authV2]] as const)('%s Slack reconnect', (_name, auth) => {
  it('reauthorizes an old connection without config edits, then persists and refreshes bound tokens', async () => {
    const requests: Array<{ url: string; method: string; body: string }> = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? 'GET', body: String(init?.body ?? '') });
      const data = url.includes('/api/oauth.v2.user.access')
        ? { access_token: 'synthetic-fresh-access', refresh_token: 'synthetic-fresh-refresh', token_type: 'bearer', scope: 'channels:read,chat:write' }
        : url.includes('oauth-protected-resource')
          ? { resource: issuer, authorization_servers: [issuer], scopes_supported: ['channels:read', 'chat:write', 'files:write'] }
          : { issuer, authorization_endpoint: 'https://slack.com/oauth/v2_user/authorize',
            token_endpoint: 'https://slack.com/api/oauth.v2.user.access', response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_post'] };
      return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
    };
    const provider = new MCPOAuthClientProvider(config, callback);
    await expect(auth(provider, { serverUrl: config.serverUrl, fetchFn }))
      .rejects.toMatchObject({ name: 'OAuthAuthenticationRequired' });
    const authorization = new URL(config.authorizationUrl!);
    expect(authorization.origin).toBe('https://slack.com');
    expect(authorization.searchParams.get('client_id')).toBe(config.oauthClientId);
    expect(authorization.searchParams.get('scope')).toBe('channels:read chat:write');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(config.oauthIssuer).toBeUndefined();
    expect(requests.every(request => request.method === 'GET')).toBe(true);
    expect(JSON.stringify(requests)).not.toContain('synthetic-slack-secret');
    expect(JSON.stringify(requests)).not.toContain('synthetic-legacy');
    await expect(provider.tokens()).resolves.toBeUndefined();

    const resumed = new MCPOAuthClientProvider(config, callback, config.oauthStateDiscovery);
    await expect(auth(resumed, { serverUrl: config.serverUrl, authorizationCode: 'synthetic-code', fetchFn }))
      .resolves.toBe('AUTHORIZED');
    expect(config.oauthTokens).toMatchObject({ format: 'flujo-oauth-v1' });
    const reloaded = new MCPOAuthClientProvider(config, callback);
    await expect(reloaded.tokens()).resolves.toMatchObject({ issuer, refresh_token: 'synthetic-fresh-refresh' });
    await expect(auth(reloaded, { serverUrl: config.serverUrl, fetchFn })).resolves.toBe('AUTHORIZED');
    const posts = requests.filter(request => request.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts.every(request => request.url === 'https://slack.com/api/oauth.v2.user.access')).toBe(true);
    expect(posts[1].body).toContain('synthetic-fresh-refresh');
    expect(JSON.stringify(requests)).not.toContain('synthetic-legacy');
  });

  it('withholds the old Slack client if discovery changes issuer', async () => {
    const requests: string[] = [];
    const changed = 'https://changed.example.test';
    const fetchFn: typeof fetch = async (input, init) => {
      requests.push(`${init?.method ?? 'GET'} ${String(input)} ${String(init?.body ?? '')}`);
      const data = String(input).includes('oauth-protected-resource')
        ? { resource: issuer, authorization_servers: [changed] }
        : { issuer: changed, authorization_endpoint: `${changed}/authorize`, token_endpoint: `${changed}/token`,
          response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] };
      return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
    };
    await expect(auth(new MCPOAuthClientProvider(config, callback), { serverUrl: config.serverUrl, fetchFn })).rejects.toThrow();
    expect(requests.every(request => request.startsWith('GET '))).toBe(true);
    expect(requests.join('\n')).not.toContain('synthetic-slack-secret');
    expect(requests.join('\n')).not.toContain('synthetic-legacy');
  });
});
