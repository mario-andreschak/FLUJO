/**
 * Regression tests for issue #54: a disabled MCP server must never spawn.
 *
 * connectServerInternal() is the single choke point where clients + transports are
 * created — every self-heal / lazy-connect path (scheduler mcp-poll, chat tool calls,
 * flow prep, API routes) funnels into it. It now hard-gates on the STORED config's
 * `disabled` flag, so none of those paths can resurrect a disabled server. On top of
 * that, callTool/listServerTools/listWithReconnect early-out with a precise error
 * instead of attempting a pointless reconnect.
 */

jest.mock('@/backend/utils/resolveGlobalVars', () => ({
  resolveGlobalVars: jest.fn(async (v: unknown) => v),
}));

// Stored configs are the source of truth for `disabled`: 'srv' is enabled, 'dead' is disabled.
jest.mock('@/backend/services/mcp/config', () => ({
  loadServerConfigs: jest.fn(async () => [
    { name: 'srv', transport: 'stdio', command: 'x', args: [], env: {}, disabled: false },
    { name: 'dead', transport: 'stdio', command: 'x', args: [], env: {}, disabled: true },
  ]),
  saveConfig: jest.fn(async () => ({ success: true })),
}));

const listToolsMock = jest.fn();
const callToolMock = jest.fn();
jest.mock('@/backend/services/mcp/tools', () => ({
  listServerTools: (...args: unknown[]) => listToolsMock(...args),
  callTool: (...args: unknown[]) => callToolMock(...args),
}));

const listResourcesMock = jest.fn();
jest.mock('@/backend/services/mcp/resources', () => ({
  listServerResources: (...args: unknown[]) => listResourcesMock(...args),
  listServerResourceTemplates: jest.fn(async () => ({ resourceTemplates: [] })),
  readResource: jest.fn(async () => ({ success: false, error: 'not mocked' })),
}));

const createNewClientMock = jest.fn();
const createTransportMock = jest.fn((..._args: unknown[]) => ({}));
jest.mock('@/backend/services/mcp/connection', () => ({
  createNewClient: (...args: unknown[]) => createNewClientMock(...args),
  createTransport: (...args: unknown[]) => createTransportMock(...args),
  shouldRecreateClient: jest.fn(() => ({ needsNewClient: false })),
  safelyCloseClient: jest.fn(async () => undefined),
}));

import { MCPService } from '@/backend/services/mcp';

const makeClient = () => ({
  connect: jest.fn(async () => undefined),
  close: jest.fn(async () => undefined),
  transport: {},
});

beforeEach(() => {
  createNewClientMock.mockReset();
  createNewClientMock.mockReturnValue(makeClient());
  createTransportMock.mockClear();
  listToolsMock.mockReset();
  callToolMock.mockReset();
  listResourcesMock.mockReset();
  global.__mcp_recovery?.clear();
});

describe('disabled-server hard gate (issue #54)', () => {
  it('connectServer(name) refuses to create a client/transport for a disabled server', async () => {
    const svc = new MCPService();

    const result = await svc.connectServer('dead');

    expect(result.success).toBe(false);
    expect(result.error).toContain('disabled');
    expect(createNewClientMock).not.toHaveBeenCalled();
    expect(createTransportMock).not.toHaveBeenCalled();
  });

  it('trusts the STORED config over a stale caller-passed object claiming disabled: false', async () => {
    const svc = new MCPService();

    // Flow handlers pass node-bound config objects; a stale snapshot must not
    // override the stored truth that the server is disabled.
    const result = await svc.connectServer({
      name: 'dead',
      transport: 'stdio',
      command: 'x',
      args: [],
      env: {},
      disabled: false,
    } as never);

    expect(result.success).toBe(false);
    expect(result.error).toContain('disabled');
    expect(createNewClientMock).not.toHaveBeenCalled();
    expect(createTransportMock).not.toHaveBeenCalled();
  });

  it('honours disabled on a passed config object when no stored config exists', async () => {
    const svc = new MCPService();

    const result = await svc.connectServer({
      name: 'unknown-server',
      transport: 'stdio',
      command: 'x',
      args: [],
      env: {},
      disabled: true,
    } as never);

    expect(result.success).toBe(false);
    expect(result.error).toContain('disabled');
    expect(createTransportMock).not.toHaveBeenCalled();
  });

  it('callTool early-outs on a disabled server: no reconnect, no tool invocation', async () => {
    const svc = new MCPService(); // empty client map — the reported scheduler scenario

    const result = await svc.callTool('dead', 'demo', {});

    expect(result.success).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(result.error).toContain('disabled');
    expect(createNewClientMock).not.toHaveBeenCalled(); // no forceReconnect spawn
    expect(callToolMock).not.toHaveBeenCalled(); // tool never ran
  });

  it('listServerTools early-outs on a disabled server with a loud error', async () => {
    const svc = new MCPService();

    const result = await svc.listServerTools('dead');

    expect(result.tools).toEqual([]);
    expect(result.error).toContain('disabled');
    expect(listToolsMock).not.toHaveBeenCalled();
    expect(createNewClientMock).not.toHaveBeenCalled();
  });

  it('listServerResources (listWithReconnect) early-outs on a disabled server', async () => {
    const svc = new MCPService();

    const result = await svc.listServerResources('dead');

    expect(result.resources).toEqual([]);
    expect(result.error).toContain('disabled');
    expect(listResourcesMock).not.toHaveBeenCalled();
    expect(createNewClientMock).not.toHaveBeenCalled();
  });

  it('regression: an ENABLED server still connects and executes tools', async () => {
    const svc = new MCPService();

    const connect = await svc.connectServer('srv');
    expect(connect.success).toBe(true);
    expect(createNewClientMock).toHaveBeenCalledTimes(1);

    callToolMock.mockResolvedValueOnce({ success: true, data: { ok: 1 } });
    const result = await svc.callTool('srv', 'demo', {});
    expect(result.success).toBe(true);
    expect(callToolMock).toHaveBeenCalledTimes(1);
  });
});
