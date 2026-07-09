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
jest.mock('@/backend/services/mcp/config', () => ({
  loadServerConfigs: (...a: unknown[]) => loadServerConfigsMock(...a),
  saveConfig: jest.fn(async () => ({ success: true })),
}));

jest.mock('@/backend/services/mcp/tools', () => ({
  listServerTools: jest.fn(async () => ({ tools: [] })),
  callTool: jest.fn(),
}));

const createNewClientMock = jest.fn();
const shouldRecreateClientMock = jest.fn();
const safelyCloseClientMock = jest.fn();
jest.mock('@/backend/services/mcp/connection', () => ({
  createNewClient: (...a: unknown[]) => createNewClientMock(...a),
  createTransport: jest.fn(() => ({})),
  resolveConfigHeaders: jest.fn(async (config: unknown) => config),
  shouldRecreateClient: (...a: unknown[]) => shouldRecreateClientMock(...a),
  safelyCloseClient: (...a: unknown[]) => safelyCloseClientMock(...a),
}));

import { MCPService } from '@/backend/services/mcp';

const makeClient = () => ({ connect: jest.fn(async () => undefined), close: jest.fn(), transport: {} });

beforeEach(() => {
  createNewClientMock.mockReset().mockReturnValue(makeClient());
  shouldRecreateClientMock.mockReset().mockReturnValue({ needsNewClient: false });
  safelyCloseClientMock.mockReset().mockResolvedValue(undefined);
  loadServerConfigsMock.mockReset().mockResolvedValue([
    { name: 'srv', transport: 'stdio', command: 'x', args: [], env: {}, disabled: false },
  ]);
  global.__mcp_clients?.clear();
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
});
