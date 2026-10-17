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
        const workspace = new URL(request.url).searchParams.get('workspace')
          || request.headers.get('x-flujo-workspace') || 'default-workspace';
        return runWithWorkspace(workspace, () => handler(request, ...rest));
      },
  };
});

import { GET, POST } from '@/app/api/oauth/callback/route';

describe('MCP OAuth callback workspace binding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    saveConfigMock.mockResolvedValue({ success: true });
    authMock.mockResolvedValue('AUTHORIZED');
  });
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

  it.each(['GET', 'POST'] as const)('%s routes a stable CIMD callback using its state and rejects replay', async method => {
    const state = 'team-a.' + 'a'.repeat(43);
    const config = {
      name: 'server-a', transport: 'streamable', serverUrl: 'https://mcp.example.test',
      oauthState: state, oauthStateWorkspace: 'team-a', oauthStateCreatedAt: Date.now(),
      oauthStateDiscovery: { authorizationServerUrl: 'https://auth.example.test', authorizationServerMetadata: {
        issuer: 'https://auth.example.test', authorization_endpoint: 'https://auth.example.test/authorize',
        token_endpoint: 'https://auth.example.test/token', response_types_supported: ['code'],
      } },
    };
    loadServerConfigsMock.mockResolvedValue([config]);
    const params = new URLSearchParams({ state, code: 'synthetic-code' });
    const request = () => new NextRequest('http://localhost:4200/api/oauth/callback' + (method === 'GET' ? '?' + params : ''),
      method === 'GET' ? undefined : { method: 'POST', body: params });
    const response = await (method === 'GET' ? GET(request()) : POST(request()));
    const location = new URL(response.headers.get('location')!);
    expect(location.searchParams.get('workspace')).toBe('team-a');
    expect(location.searchParams.get('oauth_success')).toBe('server-a');
    expect(authMock).toHaveBeenCalledTimes(1);
    const replay = await (method === 'GET' ? GET(request()) : POST(request()));
    expect(new URL(replay.headers.get('location')!).searchParams.get('oauth_error')).toBe('invalid_state');
    expect(authMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a changed workspace hint even when a nonce exists in another workspace', async () => {
    const nonce = 'a'.repeat(43);
    loadServerConfigsMock.mockResolvedValue([{
      name: 'server-a', transport: 'streamable', serverUrl: 'https://mcp.example.test',
      oauthState: `team-a.${nonce}`, oauthStateWorkspace: 'team-a', oauthStateCreatedAt: Date.now(),
    }]);
    const response = await GET(new NextRequest(
      `http://localhost:4200/api/oauth/callback?state=team-b.${nonce}&code=synthetic-code`,
    ));
    expect(new URL(response.headers.get('location')!).searchParams.get('oauth_error')).toBe('invalid_state');
    expect(saveConfigMock).not.toHaveBeenCalled();
    expect(authMock).not.toHaveBeenCalled();
  });
});
