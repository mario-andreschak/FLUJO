import { NextRequest } from 'next/server';
import type { MCPStreamableConfig } from '@/shared/types/mcp';
jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: async () => null }));
jest.mock('@/backend/services/mcp/config', () => ({ loadServerConfigs: jest.fn() }));
jest.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({ auth: jest.fn() }));
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { loadServerConfigs } from '@/backend/services/mcp/config';
import { POST } from '@/app/api/oauth/initiate/route';

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(loadServerConfigs).mockResolvedValue([{ name: 'existing', transport: 'streamable',
    serverUrl: 'https://mcp.example.test/mcp', oauthClientId: 'synthetic-client' } as MCPStreamableConfig]);
});
it('returns a recoverable form action for a missing issuer instead of a server error or JSON instructions', async () => {
  jest.mocked(auth).mockRejectedValue(Object.assign(new Error('Open connection settings'), { name: 'OAuthIssuerRequired' }));
  const response = await POST(new NextRequest('http://localhost:4200/api/oauth/initiate', {
    method: 'POST', body: JSON.stringify({ serverName: 'existing' }), headers: { 'content-type': 'application/json' },
  }));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ needsClientCredentials: true, needsOAuthIssuer: true, serverName: 'existing' });
});
