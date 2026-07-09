/**
 * Regression test for MCPService.listServerTools self-healing.
 *
 * A client object sitting in the service's `clients` map does NOT guarantee a live
 * connection: streamable-HTTP / SSE sessions expire server-side, processes die, networks
 * blip - and transport.onclose/onerror do not always fire, so a dead client can linger in
 * the map indefinitely. Previously the first failed listTools() call surfaced as an empty
 * tool list, which upstream silently turned into "this node has no MCP tools".
 *
 * listServerTools now forces a single reconnect-and-retry when listing fails (tool listing
 * is idempotent, so retrying is safe). These tests drive the real MCPService against mocked
 * connection/tools/config layers so no real process or network is involved.
 */

// Keep the service hermetic: no disk, no network, no real child processes.
jest.mock('@/backend/utils/resolveGlobalVars', () => ({
  resolveGlobalVars: jest.fn(async (v: unknown) => v),
}));

jest.mock('@/backend/services/mcp/config', () => ({
  loadServerConfigs: jest.fn(async () => [
    { name: 'srv', transport: 'stdio', command: 'x', args: [], env: {}, disabled: false },
  ]),
  saveConfig: jest.fn(async () => ({ success: true })),
}));

// listTools is what actually hits the (mock) server; we script its success/failure per call.
const listToolsMock = jest.fn();
jest.mock('@/backend/services/mcp/tools', () => ({
  listServerTools: (...args: unknown[]) => listToolsMock(...args),
  callTool: jest.fn(),
}));

// createNewClient is called once per (re)connect, so its call count tells us whether a
// fresh client was built. Each call returns a brand-new fake client.
const createNewClientMock = jest.fn();
jest.mock('@/backend/services/mcp/connection', () => ({
  createNewClient: (...args: unknown[]) => createNewClientMock(...args),
  createTransport: jest.fn(() => ({})),
  shouldRecreateClient: jest.fn(() => ({ needsNewClient: false })),
  safelyCloseClient: jest.fn(async () => undefined),
}));

import { MCPService } from '@/backend/services/mcp';

const makeClient = (over: Record<string, unknown> = {}) => ({
  connect: jest.fn(async () => undefined),
  close: jest.fn(async () => undefined),
  transport: {},
  ...over,
});

beforeEach(() => {
  // Clear queued return values from previous tests, and wipe the cross-instance recovery map
  // so a client seeded in one test does not get recovered into the next MCPService.
  createNewClientMock.mockReset();
  listToolsMock.mockReset();
  global.__mcp_clients?.clear();
});

describe('MCPService.listServerTools', () => {
  it('returns tools directly when the connection is healthy', async () => {
    createNewClientMock.mockReturnValue(makeClient());
    const svc = new MCPService();
    await svc.connectServer('srv'); // seed a live client

    listToolsMock.mockResolvedValueOnce({
      tools: [{ name: 'demo_read', description: '', inputSchema: {} }],
    });

    const result = await svc.listServerTools('srv');

    expect(result.error).toBeUndefined();
    expect(result.tools).toHaveLength(1);
    // No reconnect needed: only the initial seed built a client.
    expect(createNewClientMock).toHaveBeenCalledTimes(1);
    expect(listToolsMock).toHaveBeenCalledTimes(1);
  });

  it('reconnects and retries once when the cached client is stale, then recovers the tools', async () => {
    createNewClientMock.mockReturnValue(makeClient());
    const svc = new MCPService();
    await svc.connectServer('srv'); // seed a (soon-to-be-stale) client

    listToolsMock
      .mockResolvedValueOnce({ tools: [], error: 'fetch failed' }) // stale session
      .mockResolvedValueOnce({ tools: [{ name: 'demo_read', description: '', inputSchema: {} }] }); // after reconnect

    const result = await svc.listServerTools('srv');

    expect(result.error).toBeUndefined();
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('demo_read');
    // A fresh client was built for the reconnect (seed + reconnect = 2).
    expect(createNewClientMock).toHaveBeenCalledTimes(2);
    // listTools was attempted before AND after the reconnect.
    expect(listToolsMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces an error (does not hang or pretend success) when the reconnect itself fails', async () => {
    createNewClientMock
      .mockReturnValueOnce(makeClient()) // seed succeeds
      .mockReturnValueOnce(makeClient({ connect: jest.fn(async () => { throw new Error('connect boom'); }) })); // reconnect fails

    const svc = new MCPService();
    await svc.connectServer('srv'); // seed

    listToolsMock.mockResolvedValueOnce({ tools: [], error: 'fetch failed' });

    const result = await svc.listServerTools('srv');

    expect(result.tools).toHaveLength(0);
    expect(result.error).toBeTruthy();
    // We did not retry listTools because the reconnect never produced a usable client.
    expect(listToolsMock).toHaveBeenCalledTimes(1);
  });
});
