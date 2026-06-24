/**
 * Regression test for MCPService.callTool self-healing.
 *
 * A client in the map does not guarantee a live session: after a FLUJO restart, an expired
 * streamable-HTTP session, or a crashed process, the cached client is stale and callTool
 * fails with a connection-level error (no client / not found / 404). callTool now forces one
 * reconnect-and-retry — this is what lets a flow run right after a restart instead of failing.
 *
 * Crucially, it must NOT retry a tool that legitimately errored (e.g. bad args), to avoid
 * double-executing a tool with side effects.
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

const makeClient = () => ({
  connect: jest.fn(async () => undefined),
  close: jest.fn(async () => undefined),
  transport: {},
});

beforeEach(() => {
  createNewClientMock.mockReset();
  callToolMock.mockReset();
  global.__mcp_recovery?.clear();
});

describe('MCPService.callTool', () => {
  it('returns the result directly on success (no reconnect)', async () => {
    createNewClientMock.mockReturnValue(makeClient());
    const svc = new MCPService();
    await svc.connectServer('srv');

    callToolMock.mockResolvedValueOnce({ success: true, data: { ok: 1 } });

    const result = await svc.callTool('srv', 'demo', {});
    expect(result.success).toBe(true);
    expect(callToolMock).toHaveBeenCalledTimes(1);
    expect(createNewClientMock).toHaveBeenCalledTimes(1); // only the seed
  });

  it('reconnects and retries once on a connection-level failure (404 / not found)', async () => {
    createNewClientMock.mockReturnValue(makeClient());
    const svc = new MCPService();
    await svc.connectServer('srv');

    callToolMock
      .mockResolvedValueOnce({ success: false, error: 'Server srv not found', statusCode: 404 })
      .mockResolvedValueOnce({ success: true, data: { ok: 1 } });

    const result = await svc.callTool('srv', 'demo', {});
    expect(result.success).toBe(true);
    expect(callToolMock).toHaveBeenCalledTimes(2);
    expect(createNewClientMock).toHaveBeenCalledTimes(2); // seed + reconnect
  });

  it('does NOT retry a tool that legitimately errored (avoids double-execution)', async () => {
    createNewClientMock.mockReturnValue(makeClient());
    const svc = new MCPService();
    await svc.connectServer('srv');

    callToolMock.mockResolvedValueOnce({ success: false, error: 'Invalid arguments', statusCode: 400 });

    const result = await svc.callTool('srv', 'demo', {});
    expect(result.success).toBe(false);
    expect(callToolMock).toHaveBeenCalledTimes(1); // no retry
    expect(createNewClientMock).toHaveBeenCalledTimes(1);
  });
});
