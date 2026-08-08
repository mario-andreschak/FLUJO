import { NextRequest } from 'next/server';

const loadServerConfigsMock = jest.fn();
const saveConfigMock = jest.fn(async (_configs?: unknown) => ({ success: true }));
const authMock = jest.fn();

jest.mock('@/backend/services/mcp/config', () => ({
  loadServerConfigs: (...args: unknown[]) => loadServerConfigsMock(...args),
  saveConfig: (configs: unknown) => saveConfigMock(configs),
}));
jest.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({
  auth: (...args: unknown[]) => authMock(...args),
}));
jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: jest.fn(async () => null),
}));
jest.mock('@/app/api/_workspace', () => {
  const { runWithWorkspace } = jest.requireActual('@/utils/workspace');
  return {
    withWorkspaceRoute: (handler: (...args: unknown[]) => unknown) =>
      (request: Request, ...rest: unknown[]) => {
        const workspace = new URL(request.url).searchParams.get('workspace') || 'default-workspace';
        return runWithWorkspace(workspace, () => handler(request, ...rest));
      },
  };
});

import { GET } from '@/app/api/oauth/callback/route';

describe('MCP OAuth callback workspace binding', () => {
  it('rejects a valid state when the callback URL selects another workspace', async () => {
    const state = 'a'.repeat(43);
    loadServerConfigsMock.mockResolvedValue([{
      name: 'server-a',
      transport: 'streamable',
      serverUrl: 'https://mcp.example.test',
      oauthState: state,
      oauthStateWorkspace: 'team-a',
      oauthStateCreatedAt: Date.now(),
    }]);

    const response = await GET(new NextRequest(
      `http://localhost/api/oauth/callback?workspace=team-b&code=code&state=${state}`,
    ));

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get('location')!);
    expect(location.searchParams.get('workspace')).toBe('team-b');
    expect(location.searchParams.get('oauth_error')).toBe('invalid_state');
    expect(saveConfigMock).not.toHaveBeenCalled();
    expect(authMock).not.toHaveBeenCalled();
  });
});
