import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { MCPService } from '@/backend/services/mcp';
import { MCPOAuthClientProvider } from '@/backend/services/mcp/oauth';
import { loadServerConfigs } from '@/backend/services/mcp/config';
import { saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import type { MCPStreamableConfig } from '@/shared/types/mcp';

const serverUrl = 'https://mcp.oauth-test.example/mcp';

beforeEach(async () => {
  await saveItem(StorageKey.MCP_SERVERS, {});
});

it('uses manual credentials added after the original save when the server cannot do DCR', async () => {
  const service = new MCPService();
  await service.updateServerConfig('manual-client', {
    name: 'manual-client', transport: 'streamable', serverUrl, disabled: true,
    rootPath: '', env: {},
  });
  await service.updateServerConfig('manual-client', {
    oauthClientId: 'client-entered-later', oauthClientSecret: 'synthetic-client-secret',
    oauthIssuer: 'https://mcp.oauth-test.example',
  } as Partial<MCPStreamableConfig>);

  const loaded = await loadServerConfigs();
  expect(Array.isArray(loaded)).toBe(true);
  const config = (loaded as MCPStreamableConfig[]).find(server => server.name === 'manual-client')!;
  expect(config.oauthClientSecret).toMatch(/^encrypted:/);
  expect(config.oauthClientInformation).toBeUndefined();
  const provider = new MCPOAuthClientProvider(config, 'http://127.0.0.1:43420/api/oauth/callback');
  await expect(provider.clientInformation()).resolves.toEqual({
    client_id: 'client-entered-later', client_secret: 'synthetic-client-secret',
    issuer: 'https://mcp.oauth-test.example',
  });

  const requests: { url: string; method: string }[] = [];
  const fetchFn: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    requests.push({ url: url.href, method: options?.method || 'GET' });
    const metadata = url.pathname.includes('oauth-protected-resource') ? {
      resource: 'https://mcp.oauth-test.example',
      authorization_servers: ['https://mcp.oauth-test.example'],
      scopes_supported: ['channels:history', 'groups:history'],
    } : {
      issuer: 'https://mcp.oauth-test.example',
      authorization_endpoint: 'https://mcp.oauth-test.example/authorize',
      token_endpoint: 'https://mcp.oauth-test.example/token',
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
      // No registration_endpoint: this server rejects Dynamic Client Registration.
    };
    return new Response(JSON.stringify(metadata), { headers: { 'content-type': 'application/json' } });
  };

  await expect(auth(provider, { serverUrl, fetchFn })).rejects.toMatchObject({
    name: 'OAuthAuthenticationRequired',
  });
  expect(requests.every(request => request.method === 'GET')).toBe(true);
  const authorization = new URL(config.authorizationUrl!);
  expect(authorization.searchParams.get('client_id')).toBe('client-entered-later');
  expect(authorization.searchParams.get('scope')).toBe('channels:history groups:history');
  expect(authorization.href).not.toContain('synthetic-client-secret');
});
