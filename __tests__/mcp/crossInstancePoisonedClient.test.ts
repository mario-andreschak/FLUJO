/**
 * Regression tests for the poisoned-client bug behind planned executions failing with
 * "Failed to call tool: This operation was aborted" until a FLUJO restart.
 *
 * The chain: an OAuth token refresh changes a streamable server's config key, so the next
 * connectServer (in whichever module instance runs it) tears down the old client and builds
 * a fresh one. Teardown closes the transport, which aborts its internal AbortController —
 * after which every send() on that transport rejects instantly with AbortError. With a
 * PRIVATE per-instance client map, every OTHER instance (notably the scheduler's) kept the
 * closed client and fed it to each trigger poll forever; the trigger-UI test worked because
 * it ran in the instance holding the fresh client.
 *
 * Fixed by (a) global-backing the client map so a teardown anywhere is visible everywhere,
 * and (b) getClient evicting a client whose connection is already closed, so callTool's
 * missing-client pre-call reconnect kicks in (safe: nothing has been sent yet).
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

const callToolMock = jest.fn();
jest.mock('@/backend/services/mcp/tools', () => ({
  listServerTools: jest.fn(async () => ({ tools: [] })),
  callTool: (...args: unknown[]) => callToolMock(...args),
}));

const createNewClientMock = jest.fn();
jest.mock('@/backend/services/mcp/connection', () => ({
  createNewClient: (...args: unknown[]) => createNewClientMock(...args),
  createTransport: jest.fn(() => ({})),
  shouldRecreateClient: jest.fn(() => ({ needsNewClient: false })),
  safelyCloseClient: jest.fn(async () => undefined),
}));

import { MCPService } from '@/backend/services/mcp';

/** A fake client whose transport carries a real AbortController, like every SDK transport. */
const makeClient = () => {
  const controller = new AbortController();
  const client = {
    connect: jest.fn(async () => undefined),
    close: jest.fn(async () => undefined),
    transport: { _abortController: controller },
  } as any;
  return { client, abort: () => controller.abort() };
};

beforeEach(() => {
  createNewClientMock.mockReset();
  callToolMock.mockReset();
  global.__mcp_clients?.clear();
  global.__mcp_active_transports?.clear();
  global.__mcp_connecting?.clear();
  global.__mcp_starting_up = false;
});

describe('cross-instance client teardown', () => {
  it('a disconnect in instance B removes the client from instance A too', async () => {
    const first = makeClient();
    createNewClientMock.mockReturnValueOnce(first.client);

    const instanceA = new MCPService();
    await instanceA.connectServer('srv');
    expect(instanceA.getClient('srv')).toBe(first.client);

    // Another module instance (e.g. the one serving an API route) tears the client down.
    const instanceB = new MCPService();
    await instanceB.disconnectServer('srv');

    // Instance A must NOT keep serving the closed client (the bug: its private map did).
    expect(instanceA.getClient('srv')).toBeUndefined();
  });

  it('callTool after a cross-instance teardown reconnects and uses the FRESH client', async () => {
    const first = makeClient();
    const second = makeClient();
    createNewClientMock.mockReturnValueOnce(first.client).mockReturnValueOnce(second.client);

    const instanceA = new MCPService();
    await instanceA.connectServer('srv');

    const instanceB = new MCPService();
    await instanceB.disconnectServer('srv');
    first.abort(); // what a real transport.close() does

    callToolMock.mockResolvedValueOnce({ success: true, data: { ok: 1 } });
    const result = await instanceA.callTool('srv', 'demo', {});

    expect(result.success).toBe(true);
    expect(callToolMock).toHaveBeenCalledTimes(1);
    // The tool ran on the freshly built client, never on the closed one.
    expect(callToolMock.mock.calls[0][0]).toBe(second.client);
    expect(createNewClientMock).toHaveBeenCalledTimes(2);
  });
});

describe('closed-client eviction in getClient', () => {
  it('evicts a client whose transport abort signal has fired and reports no client', () => {
    const poisoned = makeClient();
    poisoned.abort();
    global.__mcp_clients!.set('srv', poisoned.client);

    const svc = new MCPService();
    expect(svc.getClient('srv')).toBeUndefined();
    // Evicted, not just hidden: the shared map no longer holds the corpse.
    expect(global.__mcp_clients!.has('srv')).toBe(false);
  });

  it('callTool never invokes a tool on a client with an aborted transport', async () => {
    const poisoned = makeClient();
    poisoned.abort();
    global.__mcp_clients!.set('srv', poisoned.client);

    const fresh = makeClient();
    createNewClientMock.mockReturnValueOnce(fresh.client);
    callToolMock.mockResolvedValueOnce({ success: true, data: { ok: 1 } });

    const svc = new MCPService();
    const result = await svc.callTool('srv', 'demo', {});

    expect(result.success).toBe(true);
    expect(callToolMock).toHaveBeenCalledTimes(1);
    expect(callToolMock.mock.calls[0][0]).toBe(fresh.client);
  });

  it('leaves a healthy client untouched', () => {
    const healthy = makeClient();
    global.__mcp_clients!.set('srv', healthy.client);

    const svc = new MCPService();
    expect(svc.getClient('srv')).toBe(healthy.client);
    expect(global.__mcp_clients!.has('srv')).toBe(true);
  });
});

describe('transport handler registration order', () => {
  it('registers onclose/onerror BEFORE client.connect so the SDK chains its own handlers', async () => {
    // The SDK's Protocol.connect() wraps handlers already present on the transport and
    // chains them ahead of its own cleanup (_onclose rejects pending requests, detaches
    // the transport). Handlers assigned AFTER connect replace that wrapper — the Client
    // then never notices its transport closed, which is what turned closed connections
    // into instant AbortError ("This operation was aborted") instead of "Not connected".
    let handlersAtConnectTime: { onclose: unknown; onerror: unknown } | undefined;
    const client = {
      connect: jest.fn(async (transport: any) => {
        handlersAtConnectTime = { onclose: transport.onclose, onerror: transport.onerror };
      }),
      close: jest.fn(async () => undefined),
      transport: { _abortController: new AbortController() },
    } as any;
    createNewClientMock.mockReturnValueOnce(client);

    const svc = new MCPService();
    const result = await svc.connectServer('srv');

    expect(result.success).toBe(true);
    expect(typeof handlersAtConnectTime?.onclose).toBe('function');
    expect(typeof handlersAtConnectTime?.onerror).toBe('function');
  });
});
