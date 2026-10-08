import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createTransport } from '@/backend/services/mcp/connection';
import { MCPOAuthClientProvider } from '@/backend/services/mcp/oauth';
import type { MCPStreamableConfig } from '@/shared/types/mcp';

jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug: jest.fn(), info: jest.fn(), verbose: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));

test.each(['http://127.0.0.1:8787/mcp', 'https://mcp.example.com:8443/mcp'])
('normal SDK transport retains the configured OAuth provider for %s', async serverUrl => {
  const config: MCPStreamableConfig = { name: 'manual-oauth', transport: 'streamable', serverUrl,
    rootPath: 'mcp-servers/manual-oauth', env: {}, disabled: false, _buildCommand: '', _installCommand: '',
    oauthClientId: 'synthetic-public-client-id', oauthScopes: ['read', 'write'],
    oauthIssuer: 'https://authorization.example.test' };
  const transport = createTransport(config);
  expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
  // Check the real installed SDK constructor's inputs; no connection, provider
  // request, storage mutation or authentication success is claimed by this test.
  const sdk = transport as unknown as { _url: URL; _authProvider: MCPOAuthClientProvider };
  expect(sdk._url.href).toBe(serverUrl);
  expect(sdk._authProvider).toBeInstanceOf(MCPOAuthClientProvider);
  expect(await sdk._authProvider.clientInformation()).toEqual({ client_id: 'synthetic-public-client-id', client_secret: undefined,
    issuer: 'https://authorization.example.test' });
  expect(sdk._authProvider.clientMetadata.scope).toBe('read write');
  await transport.close();
});
