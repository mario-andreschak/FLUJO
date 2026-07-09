/**
 * Regression test for MCPService.getServerStatus during startup.
 *
 * On launch, FLUJO connects enabled MCP servers one at a time, which can take a
 * few seconds. Previously a server that hadn't been reached yet reported
 * "configured but not connected" (status: 'error') - so every card on the MCP
 * page showed a scary error until the user manually refreshed. getServerStatus
 * now reports a transient 'connecting' status while the backend is still
 * starting up (or an attempt is in flight), which the MCP page renders as a
 * spinner and auto-polls until it settles.
 *
 * These tests drive the real MCPService against mocked config/connection/tools
 * layers, and control the global startup flags the service reads.
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
  listServerTools: jest.fn(),
  callTool: jest.fn(),
}));

jest.mock('@/backend/services/mcp/connection', () => ({
  createNewClient: jest.fn(),
  createTransport: jest.fn(() => ({})),
  shouldRecreateClient: jest.fn(() => ({ needsNewClient: false })),
  safelyCloseClient: jest.fn(async () => undefined),
}));

// Hit on the error-fallback path only; keep it cheap and output-less so the
// fallback resolves to the generic "not connected" error.
jest.mock('@/utils/mcp/directExecution', () => ({
  executeCommand: jest.fn(async () => ({ commandOutput: '' })),
}));

import { MCPService } from '@/backend/services/mcp';

beforeEach(() => {
  // Reset the cross-instance globals the service reads, so each test starts clean.
  global.__mcp_clients?.clear();
  global.__mcp_connecting?.clear();
  global.__mcp_starting_up = false;
});

describe('MCPService.getServerStatus startup "connecting" state', () => {
  it('reports "connecting" for an enabled, not-yet-connected server while the backend is starting up', async () => {
    global.__mcp_starting_up = true;
    const svc = new MCPService();

    const status = await svc.getServerStatus('srv');

    expect(status.status).toBe('connecting');
  });

  it('reports "connecting" while a connection attempt is in flight, even after startup completes', async () => {
    global.__mcp_starting_up = false;
    global.__mcp_connecting!.add('srv');
    const svc = new MCPService();

    const status = await svc.getServerStatus('srv');

    expect(status.status).toBe('connecting');
  });

  it('does NOT mask a real connection failure as "connecting" during startup', async () => {
    global.__mcp_starting_up = true;
    const svc = new MCPService();
    // Simulate a failed attempt having recorded its error (as connectServer does).
    (svc as unknown as { lastConnectionError: Map<string, string> })
      .lastConnectionError.set('srv', 'spawn x ENOENT');

    const status = await svc.getServerStatus('srv');

    expect(status.status).toBe('error');
    expect(status.message).toContain('spawn x ENOENT');
  });

  it('falls back to "error" once startup is complete and the server never connected', async () => {
    global.__mcp_starting_up = false;
    const svc = new MCPService();

    const status = await svc.getServerStatus('srv');

    expect(status.status).toBe('error');
  });
});
