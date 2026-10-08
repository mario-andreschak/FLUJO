/**
 * Regression test: editing a CONNECTED, still-enabled server re-applies its config.
 *
 * MCP capabilities (notably roots / workspace folders) are negotiated at connect time, so a
 * config change on a running server only takes effect on reconnect. Previously
 * handleConnectionStateChange had no branch for "connected and staying connected", so e.g.
 * assigning a root to the filesystem server silently did nothing until a manual restart.
 * Now updateServerConfig re-runs connectServer, which rebuilds only if shouldRecreateClient
 * says the config actually changed.
 */

jest.mock('@/backend/utils/resolveGlobalVars', () => ({
  resolveGlobalVars: jest.fn(async (v: unknown) => v),
}));

const loadServerConfigsMock = jest.fn();
const saveConfigMock = jest.fn(async (_configs: unknown) => ({ success: true }));
jest.mock('@/backend/services/mcp/config', () => ({
  loadServerConfigs: (...a: unknown[]) => loadServerConfigsMock(...a),
  saveConfig: (configs: unknown) => saveConfigMock(configs),
}));

jest.mock('@/backend/services/mcp/tools', () => ({
  listServerTools: jest.fn(async () => ({ tools: [] })),
  callTool: jest.fn(),
}));

const createNewClientMock = jest.fn();
const shouldRecreateClientMock = jest.fn();
const safelyCloseClientMock = jest.fn();
const probeOAuthSupportMock = jest.fn();
jest.mock('@/backend/services/mcp/connection', () => ({
  createNewClient: (...a: unknown[]) => createNewClientMock(...a),
  createTransport: jest.fn(() => ({})),
  resolveConfigHeaders: jest.fn(async (config: unknown) => config),
  shouldRecreateClient: (...a: unknown[]) => shouldRecreateClientMock(...a),
  safelyCloseClient: (...a: unknown[]) => safelyCloseClientMock(...a),
}));
jest.mock('@/utils/mcp/oauthProbe', () => ({
  probeOAuthSupport: (...a: unknown[]) => probeOAuthSupportMock(...a),
}));

import { MCPService } from '@/backend/services/mcp';

const makeClient = () => ({ connect: jest.fn(async () => undefined), close: jest.fn(), transport: {} });

beforeEach(() => {
  createNewClientMock.mockReset().mockReturnValue(makeClient());
  shouldRecreateClientMock.mockReset().mockReturnValue({ needsNewClient: false });
  safelyCloseClientMock.mockReset().mockResolvedValue(undefined);
  probeOAuthSupportMock.mockReset().mockResolvedValue({ oauthCapable: true });
  saveConfigMock.mockClear();
  loadServerConfigsMock.mockReset().mockResolvedValue([
    { name: 'srv', transport: 'stdio', command: 'x', args: [], env: {}, disabled: false },
  ]);
  global.__mcp_clients?.clear();
  global.__mcp_active_transports?.clear();
});

describe('updateServerConfig on a connected, still-enabled server', () => {
  it('rebuilds the connection when the config meaningfully changed (e.g. a new root)', async () => {
    const svc = new MCPService();
    await svc.connectServer('srv'); // seed: createNewClient x1
    expect(createNewClientMock).toHaveBeenCalledTimes(1);

    // Simulate "config changed" so connectServer should rebuild.
    shouldRecreateClientMock.mockReturnValue({ needsNewClient: true, reason: 'Roots configuration changed' });

    await svc.updateServerConfig('srv', { roots: ['/some/workspace'] } as any);

    // The connected server was re-applied: stale client closed + a fresh client built.
    expect(safelyCloseClientMock).toHaveBeenCalled();
    expect(createNewClientMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT rebuild when nothing meaningful changed (cheap no-op)', async () => {
    const svc = new MCPService();
    await svc.connectServer('srv'); // createNewClient x1

    // shouldRecreateClient stays false -> connectServer short-circuits as "already connected".
    await svc.updateServerConfig('srv', { exposeAsMcpServer: true } as any);

    expect(createNewClientMock).toHaveBeenCalledTimes(1); // no rebuild
    expect(safelyCloseClientMock).not.toHaveBeenCalled();
  });

  it('persists env global bindings verbatim instead of baking their current value', async () => {
    const svc = new MCPService();
    await svc.updateServerConfig('srv', {
      env: {
        GITHUB_TOKEN: {
          value: '${global:GITHUB_TOKEN}',
          metadata: { isSecret: true },
        },
      },
    } as any);

    const savedMap = saveConfigMock.mock.calls[0][0] as Map<string, {
      env: Record<string, unknown>;
    }>;
    expect(savedMap.get('srv')?.env.GITHUB_TOKEN).toEqual({
      value: '${global:GITHUB_TOKEN}',
      metadata: { isSecret: true },
    });
  });
});

describe('static Authorization header OAuth-scope cleanup', () => {
  const headerAuthenticatedServer = (overrides: Record<string, unknown> = {}) => ({
    name: 'github',
    transport: 'streamable',
    serverUrl: 'https://api.githubcopilot.com/mcp/',
    headers: {
      Authorization: {
        value: 'encrypted:rotated-pat',
        metadata: { isSecret: true },
      },
    },
    oauthScopes: ['read'],
    disabled: false,
    rootPath: '',
    env: {},
    ...overrides,
  });

  it('removes the legacy inferred scope after the header establishes a live connection', async () => {
    const config = headerAuthenticatedServer();
    loadServerConfigsMock.mockResolvedValue([config]);
    const svc = new MCPService();

    const result = await svc.connectServer('github');

    expect(result.success).toBe(true);
    const savedMap = saveConfigMock.mock.calls[0][0] as Map<string, {
      oauthScopes?: string[];
      headers?: unknown;
    }>;
    expect(savedMap.get('github')?.oauthScopes).toBeUndefined();
    expect(savedMap.get('github')?.headers).toEqual(config.headers);
  });

  it('preserves scopes when durable OAuth state exists', async () => {
    loadServerConfigsMock.mockResolvedValue([
      headerAuthenticatedServer({ oauthClientId: 'registered-client' }),
    ]);
    const svc = new MCPService();

    const result = await svc.connectServer('github');

    expect(result.success).toBe(true);
    expect(saveConfigMock).not.toHaveBeenCalled();
  });

  it('does not infer or persist OAuth when an explicit Authorization header is rejected', async () => {
    loadServerConfigsMock.mockResolvedValue([
      headerAuthenticatedServer({ oauthScopes: undefined }),
    ]);
    createNewClientMock.mockReturnValue({
      ...makeClient(),
      connect: jest.fn(async () => {
        throw Object.assign(new Error('HTTP 401 Unauthorized'), { code: 401 });
      }),
    });
    const svc = new MCPService();

    const result = await svc.connectServer('github');

    expect(result.success).toBe(false);
    expect(result.requiresAuthentication).toBe(true);
    expect(probeOAuthSupportMock).not.toHaveBeenCalled();
    expect(saveConfigMock).not.toHaveBeenCalled();
  });
});
