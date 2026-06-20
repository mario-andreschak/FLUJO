/**
 * Tests for the FLUJO-as-MCP-server proxy forwarding (#17A).
 * The route's transport plumbing is the official SDK + fetch-to-node and is
 * verified with a real client; here we pin the forwarding logic we own.
 */

// Self-contained mock (factory can't close over outer consts — see jest-test-harness notes).
jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    connectServer: jest.fn(),
    listServerTools: jest.fn(),
    callTool: jest.fn(),
    loadServerConfigs: jest.fn(),
  },
}));

import {
  isLocalRequest,
  isServerExposed,
  proxyListTools,
  proxyCallTool,
} from '@/backend/services/mcp/proxyForward';
import { mcpService } from '@/backend/services/mcp';

const svc = mcpService as unknown as {
  connectServer: jest.Mock;
  listServerTools: jest.Mock;
  callTool: jest.Mock;
  loadServerConfigs: jest.Mock;
};

beforeEach(() => jest.clearAllMocks());

describe('isLocalRequest (DNS-rebind guard)', () => {
  it('allows localhost-family hosts with no origin (native clients)', () => {
    expect(isLocalRequest('localhost:4200', null)).toBe(true);
    expect(isLocalRequest('127.0.0.1:4200', null)).toBe(true);
    expect(isLocalRequest('[::1]:4200', null)).toBe(true);
    expect(isLocalRequest('localhost', null)).toBe(true);
  });

  it('rejects non-localhost hosts (rebinding vector)', () => {
    expect(isLocalRequest('evil.com:4200', null)).toBe(false);
    expect(isLocalRequest('192.168.1.5:4200', null)).toBe(false);
    expect(isLocalRequest(null, null)).toBe(false);
  });

  it('rejects a non-local Origin even when Host is localhost (browser attack)', () => {
    expect(isLocalRequest('localhost:4200', 'http://evil.com')).toBe(false);
    expect(isLocalRequest('localhost:4200', 'http://localhost:3000')).toBe(true);
  });
});

describe('isServerExposed', () => {
  it('true only when the server exists, is enabled, and is opted in', async () => {
    svc.loadServerConfigs.mockResolvedValue([
      { name: 'a', disabled: false, exposeAsMcpServer: true },
      { name: 'b', disabled: true, exposeAsMcpServer: true },
      { name: 'c', disabled: false, exposeAsMcpServer: false },
      { name: 'd', disabled: false },
    ]);
    expect(await isServerExposed('a')).toBe(true);
    expect(await isServerExposed('b')).toBe(false); // disabled
    expect(await isServerExposed('c')).toBe(false); // not opted in
    expect(await isServerExposed('d')).toBe(false); // flag absent
    expect(await isServerExposed('missing')).toBe(false);
  });

  it('returns false when configs cannot be loaded', async () => {
    svc.loadServerConfigs.mockResolvedValue({ error: 'boom' });
    expect(await isServerExposed('a')).toBe(false);
  });
});

describe('proxyListTools', () => {
  it('returns the downstream tools on success', async () => {
    svc.connectServer.mockResolvedValue({ success: true });
    svc.listServerTools.mockResolvedValue({
      tools: [{ name: 'echo', description: '', inputSchema: { type: 'object' } }],
    });
    const r = await proxyListTools('srv');
    expect(r.tools).toHaveLength(1);
    expect(r.tools[0].name).toBe('echo');
  });

  it('throws when the downstream connection fails', async () => {
    svc.connectServer.mockResolvedValue({ success: false, error: 'down' });
    await expect(proxyListTools('srv')).rejects.toThrow(/down/);
    expect(svc.listServerTools).not.toHaveBeenCalled();
  });

  it('throws when listing fails', async () => {
    svc.connectServer.mockResolvedValue({ success: true });
    svc.listServerTools.mockResolvedValue({ tools: [], error: 'list failed' });
    await expect(proxyListTools('srv')).rejects.toThrow(/list failed/);
  });
});

describe('proxyCallTool', () => {
  it('passes the downstream CallToolResult through on success', async () => {
    svc.connectServer.mockResolvedValue({ success: true });
    svc.callTool.mockResolvedValue({
      success: true,
      data: { content: [{ type: 'text', text: 'hi' }] },
    });
    const r = await proxyCallTool('srv', 'echo', { x: 1 });
    expect(r.isError).toBeUndefined();
    expect(r.content).toEqual([{ type: 'text', text: 'hi' }]);
    expect(svc.callTool).toHaveBeenCalledWith('srv', 'echo', { x: 1 });
  });

  it('maps a tool failure to an MCP error result', async () => {
    svc.connectServer.mockResolvedValue({ success: true });
    svc.callTool.mockResolvedValue({ success: false, error: 'kaboom' });
    const r = await proxyCallTool('srv', 'echo', {});
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('kaboom');
  });

  it('maps a connection failure to an MCP error result (no throw)', async () => {
    svc.connectServer.mockResolvedValue({ success: false, error: 'unreachable' });
    const r = await proxyCallTool('srv', 'echo', {});
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('unreachable');
    expect(svc.callTool).not.toHaveBeenCalled();
  });
});
