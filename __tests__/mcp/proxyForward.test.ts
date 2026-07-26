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
    listServerResources: jest.fn(),
    listServerResourceTemplates: jest.fn(),
    readResource: jest.fn(),
  },
}));

import {
  isLocalRequest,
  isServerExposed,
  proxyListTools,
  proxyCallTool,
  proxyListResources,
  proxyListResourceTemplates,
  proxyReadResource,
} from '@/backend/services/mcp/proxyForward';
import { mcpService } from '@/backend/services/mcp';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

const svc = mcpService as unknown as {
  connectServer: jest.Mock;
  listServerTools: jest.Mock;
  callTool: jest.Mock;
  loadServerConfigs: jest.Mock;
  listServerResources: jest.Mock;
  listServerResourceTemplates: jest.Mock;
  readResource: jest.Mock;
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

describe('proxyListResources', () => {
  it('returns the downstream resources on success', async () => {
    svc.connectServer.mockResolvedValue({ success: true });
    svc.listServerResources.mockResolvedValue({
      resources: [{ uri: 'flujo://run/abc/123', name: 'my-resource' }],
    });
    const r = await proxyListResources('srv');
    expect(r.resources).toHaveLength(1);
    expect(r.resources[0].uri).toBe('flujo://run/abc/123');
  });

  it('throws when the downstream connection fails', async () => {
    svc.connectServer.mockResolvedValue({ success: false, error: 'down' });
    await expect(proxyListResources('srv')).rejects.toThrow(/down/);
    expect(svc.listServerResources).not.toHaveBeenCalled();
  });

  it('throws when listing resources fails', async () => {
    svc.connectServer.mockResolvedValue({ success: true });
    svc.listServerResources.mockResolvedValue({ resources: [], error: 'list failed' });
    await expect(proxyListResources('srv')).rejects.toThrow(/list failed/);
  });
});

describe('proxyListResourceTemplates', () => {
  it('returns the downstream resource templates on success', async () => {
    svc.connectServer.mockResolvedValue({ success: true });
    svc.listServerResourceTemplates.mockResolvedValue({
      resourceTemplates: [{ uriTemplate: 'flujo://run/{conv}/{id}', name: 'run-resource' }],
    });
    const r = await proxyListResourceTemplates('srv');
    expect(r.resourceTemplates).toHaveLength(1);
    expect(r.resourceTemplates[0].uriTemplate).toBe('flujo://run/{conv}/{id}');
  });

  it('throws when the downstream connection fails', async () => {
    svc.connectServer.mockResolvedValue({ success: false, error: 'conn-err' });
    await expect(proxyListResourceTemplates('srv')).rejects.toThrow(/conn-err/);
    expect(svc.listServerResourceTemplates).not.toHaveBeenCalled();
  });
});

describe('proxyReadResource', () => {
  const resourceResult = {
    contents: [{ uri: 'flujo://run/abc/123', text: 'hello', mimeType: 'text/plain' }],
  };

  it('returns the ReadResourceResult on success', async () => {
    svc.connectServer.mockResolvedValue({ success: true });
    svc.readResource.mockResolvedValue({ success: true, data: resourceResult });
    const r = await proxyReadResource('srv', 'flujo://run/abc/123');
    expect(r).toEqual(resourceResult);
    expect(svc.readResource).toHaveBeenCalledWith('srv', 'flujo://run/abc/123');
  });

  it('throws a generic Error when the downstream connection fails (not McpError)', async () => {
    svc.connectServer.mockResolvedValue({ success: false, error: 'unreachable' });
    await expect(proxyReadResource('srv', 'flujo://run/abc/123')).rejects.toThrow(/unreachable/);
    // Must be a plain Error, not McpError — connection failure is an InternalError (-32603)
    await expect(proxyReadResource('srv', 'flujo://run/abc/123')).rejects.not.toBeInstanceOf(McpError);
    expect(svc.readResource).not.toHaveBeenCalled();
  });

  it('throws McpError(-32602) when the resource is not found / URI is invalid', async () => {
    svc.connectServer.mockResolvedValue({ success: true });
    svc.readResource.mockResolvedValue({ success: false, error: 'not found', statusCode: 404 });
    let thrown: unknown;
    try {
      await proxyReadResource('srv', 'flujo://run/abc/missing');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).code).toBe(ErrorCode.InvalidParams); // -32602
    expect((thrown as McpError).message).toContain('flujo://run/abc/missing');
  });

  it('throws McpError(-32602) when result.data is absent (success=true but no data)', async () => {
    svc.connectServer.mockResolvedValue({ success: true });
    svc.readResource.mockResolvedValue({ success: true, data: null });
    let thrown: unknown;
    try {
      await proxyReadResource('srv', 'flujo://run/abc/empty');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).code).toBe(ErrorCode.InvalidParams);
  });
});
