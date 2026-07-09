/**
 * Regression test for MCPService.callTool self-healing.
 *
 * After a FLUJO restart (or a dropped connection that cleared the client map) the cached
 * client is missing and a tool call would fail. callTool now reconnects BEFORE invoking the
 * tool, but ONLY when there is no client at all — so the tool has not run yet and this can
 * never double-execute a side-effecting tool.
 *
 * It must NOT reconnect-and-retry based on the *result* of a call: tools.ts maps MCP
 * -32601 (method-not-found) and tool errors whose text contains "not found"/"404" to
 * statusCode 404, none of which mean the connection is dead. Retrying those would
 * double-execute a tool that already ran.
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
  resolveConfigHeaders: jest.fn(async (config: unknown) => config),
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
  global.__mcp_clients?.clear();
});

describe('MCPService.callTool', () => {
  it('calls the tool directly when a client is present (no reconnect)', async () => {
    createNewClientMock.mockReturnValue(makeClient());
    const svc = new MCPService();
    await svc.connectServer('srv');

    callToolMock.mockResolvedValueOnce({ success: true, data: { ok: 1 } });

    const result = await svc.callTool('srv', 'demo', {});
    expect(result.success).toBe(true);
    expect(callToolMock).toHaveBeenCalledTimes(1);
    expect(createNewClientMock).toHaveBeenCalledTimes(1); // only the seed connect
  });

  it('reconnects BEFORE calling when there is no client (e.g. after a restart)', async () => {
    // No connectServer() first -> clients map is empty, mirroring a fresh process.
    createNewClientMock.mockReturnValue(makeClient());
    const svc = new MCPService();

    callToolMock.mockResolvedValueOnce({ success: true, data: { ok: 1 } });

    const result = await svc.callTool('srv', 'demo', {});
    expect(result.success).toBe(true);
    // The reconnect built a client, then the tool ran exactly once.
    expect(createNewClientMock).toHaveBeenCalledTimes(1);
    expect(callToolMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT reconnect or retry when a present client returns a 404/"not found" tool error', async () => {
    createNewClientMock.mockReturnValue(makeClient());
    const svc = new MCPService();
    await svc.connectServer('srv'); // client present

    // A live server answering "method not found" (-32601) or a tool whose own error says
    // "not found" — must NOT trigger a reconnect or a second (double) execution.
    callToolMock.mockResolvedValueOnce({ success: false, error: 'Failed to call tool: record not found', statusCode: 404 });

    const result = await svc.callTool('srv', 'demo', {});
    expect(result.success).toBe(false);
    expect(callToolMock).toHaveBeenCalledTimes(1); // no retry -> no double execution
    expect(createNewClientMock).toHaveBeenCalledTimes(1); // only the seed -> no reconnect
  });
});
