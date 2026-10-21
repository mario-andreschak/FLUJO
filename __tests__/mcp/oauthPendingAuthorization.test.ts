import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { MCPStreamableConfig } from '@/shared/types/mcp';
import { installPrivateProfileFixture } from '../utils/privateProfileFixture';
const mockLoad = jest.fn();
const mockSave = jest.fn();
jest.mock('@/backend/services/mcp/config', () => ({
  loadServerConfigs: () => mockLoad(), saveConfig: (value: unknown) => mockSave(value),
}));
jest.mock('@/utils/logger', () => ({ createLogger: () => ({
  info: jest.fn(), debug: jest.fn(), verbose: jest.fn(), warn: jest.fn(), error: jest.fn(),
}) }));
import { MCPOAuthClientProvider, MCP_OAUTH_STATE_TTL_MS } from '@/backend/services/mcp/oauth';

const issuer = 'https://auth.example.test';
const callback = 'http://localhost:4200/api/oauth/callback?workspace=default-workspace';
const discovery: OAuthDiscoveryState = { authorizationServerUrl: issuer,
  authorizationServerMetadata: { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, response_types_supported: ['code'] } };
let fixture: Awaited<ReturnType<typeof installPrivateProfileFixture>>;
let stored: MCPStreamableConfig;
beforeEach(async () => {
  fixture = await installPrivateProfileFixture();
  stored = { name: 'pending', serverUrl: 'https://mcp.example.test/mcp', transport: 'streamable',
    rootPath: '', env: {}, disabled: true, _buildCommand: '', _installCommand: '' };
  mockLoad.mockReset().mockImplementation(async () => [structuredClone(stored)]);
  mockSave.mockReset().mockImplementation(async (map: Map<string, MCPStreamableConfig>) => {
    stored = structuredClone(map.get('pending')!); return { success: true };
  });
});
afterEach(async () => { await fixture?.restore(); });

async function start(config = structuredClone(stored)) {
  const provider = new MCPOAuthClientProvider(config, callback, discovery);
  const state = provider.state();
  await provider.saveCodeVerifier('first-verifier');
  const url = new URL(`${issuer}/authorize`);
  url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri', callback);
  await expect(provider.redirectToAuthorization(url)).rejects.toMatchObject({ name: 'OAuthAuthenticationRequired' });
  return { provider, state, url: url.href };
}

it('reuses a pending sign-in when a stale background reconnect tries to replace its verifier', async () => {
  const stale = structuredClone(stored);
  const first = await start();
  const background = new MCPOAuthClientProvider(stale, callback, discovery);
  background.state();
  await expect(background.saveCodeVerifier('background-verifier')).rejects.toMatchObject({ name: 'OAuthAuthenticationRequired' });
  expect(stale.authorizationUrl).toBe(first.url);
  expect(stored.oauthState).toBe(first.state);
  await expect(new MCPOAuthClientProvider(stored, callback).codeVerifier()).resolves.toBe('first-verifier');
});

it('keeps a pending nonce and verifier when a stale token refresh is persisted', async () => {
  const stale = structuredClone(stored);
  const first = await start();
  await new MCPOAuthClientProvider(stale, callback).saveTokens({ issuer, access_token: 'new-access', token_type: 'bearer' });
  expect(stored.oauthState).toBe(first.state);
  expect(stored.authorizationUrl).toBe(first.url);
  await expect(new MCPOAuthClientProvider(stored, callback).codeVerifier()).resolves.toBe('first-verifier');
});

it('allows a new sign-in after the pending transaction expires', async () => {
  const first = await start();
  stored.oauthStateCreatedAt = Date.now() - MCP_OAUTH_STATE_TTL_MS - 1;
  const second = await start();
  expect(second.state).not.toBe(first.state);
  expect(stored.oauthState).toBe(second.state);
});

it('does not overwrite a simultaneous authorization whose URL is still being saved', async () => {
  const first = new MCPOAuthClientProvider(structuredClone(stored), callback, discovery);
  const second = new MCPOAuthClientProvider(structuredClone(stored), callback, discovery);
  const state = first.state();
  second.state();
  const results = await Promise.allSettled([first.saveCodeVerifier('first-verifier'), second.saveCodeVerifier('second-verifier')]);
  expect(results[0].status).toBe('fulfilled');
  expect(results[1]).toMatchObject({ status: 'rejected', reason: { name: 'OAuthAuthorizationInProgress' } });
  expect(stored.oauthState).toBe(state);
});
