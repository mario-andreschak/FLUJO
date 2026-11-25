import { NextRequest } from 'next/server';
import type { MCPStreamableConfig } from '@/shared/types/mcp';
jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: async () => null }));
jest.mock('@/backend/services/mcp/config', () => ({ loadServerConfigs: jest.fn() }));
jest.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({
  ...jest.requireActual('@modelcontextprotocol/sdk/client/auth.js'), auth: jest.fn(),
}));
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { loadServerConfigs } from '@/backend/services/mcp/config';
import { POST } from '@/app/api/oauth/initiate/route';

const initiate = () => POST(new NextRequest('http://localhost:4200/api/oauth/initiate', {
  method: 'POST', body: JSON.stringify({ serverName: 'existing' }), headers: { 'content-type': 'application/json' },
}));

let challenge: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(loadServerConfigs).mockResolvedValue([{ name: 'existing', transport: 'streamable',
    serverUrl: 'https://mcp.example.test/mcp', oauthClientId: 'synthetic-client' } as MCPStreamableConfig]);
  challenge = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
});
afterEach(() => challenge.mockRestore());

it('returns a recoverable form action for a missing issuer instead of a server error or JSON instructions', async () => {
  jest.mocked(auth).mockRejectedValue(Object.assign(new Error('Open connection settings'), { name: 'OAuthIssuerRequired' }));
  const response = await initiate();
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ needsClientCredentials: true, needsOAuthIssuer: true, serverName: 'existing' });
});

it('starts sign-in from the server challenge, as a connection 401 would', async () => {
  challenge.mockResolvedValue(new Response(null, { status: 401, headers: {
    'www-authenticate': 'Bearer resource_metadata="https://mcp.example.test/meta/custom", scope="files:read"',
  } }));
  jest.mocked(auth).mockResolvedValue('AUTHORIZED');
  const response = await initiate();
  expect(await response.json()).toMatchObject({ alreadyAuthorized: true });
  const [url, init] = challenge.mock.calls[0];
  expect(String(url)).toBe('https://mcp.example.test/mcp');
  expect(new Headers(init.headers).has('authorization')).toBe(false);
  expect(jest.mocked(auth).mock.calls[0][1]).toMatchObject({
    serverUrl: 'https://mcp.example.test/mcp', scope: 'files:read',
    resourceMetadataUrl: new URL('https://mcp.example.test/meta/custom'),
  });
});

it('explains a server whose sign-in cannot confirm S256 PKCE as a fixable provider problem', async () => {
  jest.mocked(auth).mockRejectedValue(Object.assign(new Error('does not confirm the S256 code check'), { name: 'OAuthPkceUnsupported' }));
  const response = await initiate();
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining('S256'), serverName: 'existing' });
});
