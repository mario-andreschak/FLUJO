import { NextRequest } from 'next/server';
import { runWithWorkspace } from '@/utils/workspace';
import type { MCPStreamableConfig } from '@/shared/types/mcp';

jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: async () => null }));
jest.mock('@/backend/services/mcp/config', () => ({ loadServerConfigs: jest.fn(), saveConfig: jest.fn() }));
jest.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({ auth: jest.fn() }));

import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { loadServerConfigs, saveConfig } from '@/backend/services/mcp/config';
import { GET, POST } from '@/app/api/oauth/callback/route';
import { MCPOAuthClientProvider } from '@/backend/services/mcp/oauth';

const issuer = 'https://authorization.invalid/tenant';
const state = 's'.repeat(43);
let config: MCPStreamableConfig;
beforeEach(() => {
  jest.clearAllMocks();
  config = { name: 'issuer-callback', transport: 'streamable', serverUrl: 'https://resource.invalid/mcp',
    oauthState: state, oauthStateWorkspace: 'callback-test', oauthStateCreatedAt: Date.now(),
    oauthStateDiscovery: { authorizationServerUrl: issuer, authorizationServerMetadata: {
      issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', response_types_supported: ['code'],
      authorization_response_iss_parameter_supported: true,
    } },
  } as unknown as MCPStreamableConfig;
  jest.mocked(loadServerConfigs).mockResolvedValue([config]);
  jest.mocked(saveConfig).mockResolvedValue({ success: true });
  jest.mocked(auth).mockResolvedValue('AUTHORIZED');
});

async function callback(method: 'GET' | 'POST', params: Record<string, string>) {
  const body = new URLSearchParams({ state, ...params });
  const request = new NextRequest('http://localhost/api/oauth/callback' + (method === 'GET' ? '?' + body : ''),
    method === 'GET' ? undefined : { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  return runWithWorkspace('callback-test', () => method === 'GET' ? GET(request) : POST(request));
}

test.each(['GET', 'POST'] as const)('%s rejects mismatched or missing issuer before success/error processing', async method => {
  const cases: Record<string, string>[] = [{ code: 'synthetic-code', iss: issuer + '/' }, { code: 'synthetic-code' }, { error: 'access_denied', iss: 'https://other.invalid' }];
  for (const params of cases) {
    const response = await callback(method, params);
    expect(new URL(response.headers.get('location')!).searchParams.get('oauth_error')).toBe('invalid_issuer');
    expect(auth).not.toHaveBeenCalled();
  }
});

test.each(['GET', 'POST'] as const)('%s accepts exact issuer, pins original discovery and consumes the transaction', async method => {
  const response = await callback(method, { code: 'synthetic-code', iss: issuer });
  expect(new URL(response.headers.get('location')!).searchParams.get('oauth_success')).toBe(config.name);
  const provider = jest.mocked(auth).mock.calls[0][0] as MCPOAuthClientProvider;
  expect(provider.discoveryState()?.authorizationServerUrl).toBe(issuer);
  expect(config.oauthState).toBeUndefined();
  expect(config.oauthStateDiscovery).toBeUndefined();
});

test('optional issuer absence is accepted only for discovery that did not require it', async () => {
  (config.oauthStateDiscovery!.authorizationServerMetadata as Record<string, unknown>).authorization_response_iss_parameter_supported = false;
  await callback('GET', { code: 'synthetic-code' });
  expect(auth).toHaveBeenCalledTimes(1);
});

test('DCR distinguishes local native callbacks from hosted web callbacks', () => {
  expect(new MCPOAuthClientProvider(config, 'http://localhost:4200/api/oauth/callback').clientMetadata).toMatchObject({ application_type: 'native' });
  expect(new MCPOAuthClientProvider(config, 'https://flujo.invalid/api/oauth/callback').clientMetadata).toMatchObject({ application_type: 'web' });
});
