/**
 * Regression test for the "all servers show 'configured but not connected' right after
 * startup" bug.
 *
 * In production (`next start`) the module instance that runs startup and CONNECTS the MCP
 * servers is usually NOT the instance that serves the status API. Connected clients live in
 * the shared `global.__mcp_recovery` map, but the serving instance only bulk-copied it ONCE
 * at construction (when it was still empty), so it never saw the servers the startup
 * instance connected afterwards — and reported a misleading error for healthy servers.
 *
 * getClient now adopts a client from the global recovery map on demand, so any instance
 * sees a server connected by any other instance.
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
  shouldRecreateClient: jest.fn(() => ({ needsNewClient: false })),
  safelyCloseClient: jest.fn(async () => undefined),
}));

import { MCPService } from '@/backend/services/mcp';

const fakeClient = { transport: {}, close: jest.fn() } as any;

beforeEach(() => {
  global.__mcp_recovery?.clear();
  global.__mcp_connecting?.clear();
  global.__mcp_starting_up = false; // startup finished
});

describe('cross-instance client adoption', () => {
  it('getClient adopts a client added to the global recovery map AFTER construction', () => {
    // Instance B is constructed while the global map is still empty (mirrors a route
    // instance created before/around startup).
    const instanceB = new MCPService();
    expect(instanceB.getClient('srv')).toBeUndefined();

    // The startup instance later connects 'srv' and registers it globally.
    global.__mcp_recovery!.set('srv', fakeClient);

    // Instance B must now see it (the bug: old code returned undefined forever).
    expect(instanceB.getClient('srv')).toBe(fakeClient);
  });

  it('getServerStatus reports "connected" for a server connected by another instance', async () => {
    const instanceB = new MCPService();
    global.__mcp_recovery!.set('srv', fakeClient);

    const status = await instanceB.getServerStatus('srv');
    expect(status.status).toBe('connected');
  });
});
