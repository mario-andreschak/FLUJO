/**
 * Cross-instance client visibility.
 *
 * In production (`next start`) — and in dev after hot reloads — Next.js evaluates the MCP
 * service module once per module graph, so several MCPService instances coexist. The
 * instance that runs startup and CONNECTS the servers is usually NOT the one serving a
 * given request.
 *
 * Historically each instance kept a private client map seeded ("recovered") from a shared
 * global map once at construction, then bridged on demand in getClient. Both variants left
 * stale views behind. The client map is now global-backed (`global.__mcp_clients`): every
 * instance reads and writes the SAME map, so a client connected by any instance is
 * immediately visible to all others — including instances constructed before the connect.
 */

jest.mock('@/backend/utils/resolveGlobalVars', () => ({
  resolveGlobalVars: jest.fn(async (v: unknown) => v),
}));

jest.mock('@/backend/services/mcp/config', () => ({
  loadServerConfigs: jest.fn(async () => [
    { name: 'srv', transport: 'stdio', command: 'x', args: [], env: {}, disabled: false },
  ]),
  saveConfig: jest.fn(async () => ({ success: true })),
}));

jest.mock('@/backend/services/mcp/tools', () => ({
  listServerTools: jest.fn(async () => ({ tools: [] })),
  callTool: jest.fn(),
}));

jest.mock('@/backend/services/mcp/connection', () => ({
  createNewClient: jest.fn(),
  createTransport: jest.fn(() => ({})),
  resolveConfigHeaders: jest.fn(async (config: unknown) => config),
  shouldRecreateClient: jest.fn(() => ({ needsNewClient: false })),
  safelyCloseClient: jest.fn(async () => undefined),
}));

import { MCPService } from '@/backend/services/mcp';

const fakeClient = { transport: {}, close: jest.fn() } as any;

beforeEach(() => {
  global.__mcp_clients?.clear();
  global.__mcp_connecting?.clear();
  global.__mcp_starting_up = false; // startup finished
});

describe('cross-instance client visibility', () => {
  it('getClient sees a client another instance registered AFTER this instance was constructed', () => {
    // Instance B is constructed while the shared map is still empty (mirrors a route
    // instance created before/around startup).
    const instanceB = new MCPService();
    expect(instanceB.getClient('srv')).toBeUndefined();

    // The startup instance later connects 'srv' and registers it in the shared map.
    global.__mcp_clients!.set('srv', fakeClient);

    // Instance B must see it live (the bug: a private per-instance copy stayed empty).
    expect(instanceB.getClient('srv')).toBe(fakeClient);
  });

  it('getServerStatus reports "connected" for a server connected by another instance', async () => {
    const instanceB = new MCPService();
    global.__mcp_clients!.set('srv', fakeClient);

    const status = await instanceB.getServerStatus('srv');
    expect(status.status).toBe('connected');
  });
});
