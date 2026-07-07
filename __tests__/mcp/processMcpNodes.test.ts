/**
 * Regression test for ToolHandler.processMCPNodes.
 *
 * Background: a ProcessNode wired to an MCP server gets that server's tools from
 * processMCPNodes(). The original implementation silently `continue`d whenever tool
 * listing returned zero tools - including the failure case where the underlying MCP
 * connection had gone stale. The node then ran with ONLY its handoff tool and the model
 * (truthfully) reported it had no tools. This made tools appear to "randomly" come and go.
 *
 * These tests pin the corrected contract:
 *   - a connection failure is propagated, not swallowed
 *   - a tool-listing failure is propagated, not swallowed
 *   - a genuinely empty (but successful) tool list is still treated as success
 *   - enabled tools are namespaced and returned on the happy path
 */

// processMCPNodes talks to the singleton MCP service; stub it so we control connect/list.
jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    connectServer: jest.fn(),
    listServerTools: jest.fn(),
    getServerStatus: jest.fn(),
    setNodeRoots: jest.fn(),
  },
}));

import { ToolHandler } from '@/backend/execution/flow/handlers/ToolHandler';
import { encodeToolName } from '@/backend/execution/flow/handlers/toolNamespace';
import { mcpService } from '@/backend/services/mcp';

const mockService = mcpService as unknown as {
  connectServer: jest.Mock;
  listServerTools: jest.Mock;
  getServerStatus: jest.Mock;
};

const mcpNode = (boundServer: string, enabledTools: string[]) => ({
  id: 'mcp-node-1',
  properties: { boundServer, enabledTools },
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ToolHandler.processMCPNodes', () => {
  it('returns namespaced tools filtered by enabledTools on the happy path', async () => {
    mockService.connectServer.mockResolvedValue({ success: true });
    mockService.listServerTools.mockResolvedValue({
      tools: [
        { name: 'demo_read', description: 'read source', inputSchema: { type: 'object' } },
        { name: 'demo_search', description: 'search', inputSchema: { type: 'object' } },
        { name: 'not_enabled', description: 'nope', inputSchema: {} },
      ],
    });

    const result = await ToolHandler.processMCPNodes({
      mcpNodes: [mcpNode('demo-mcp-server', ['demo_read', 'demo_search'])] as any,
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    const names = result.value.availableTools.map(t => t.name);
    // Tools are namespaced with the OpenAI-safe scheme (#16) and carry server +
    // originalName so the call can be decoded later.
    expect(names).toEqual([
      encodeToolName('demo-mcp-server', 'demo_read'),
      encodeToolName('demo-mcp-server', 'demo_search'),
    ]);
    expect(result.value.availableTools.map(t => ({ server: t.server, originalName: t.originalName }))).toEqual([
      { server: 'demo-mcp-server', originalName: 'demo_read' },
      { server: 'demo-mcp-server', originalName: 'demo_search' },
    ]);
    for (const name of names) {
      expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
  });

  it('propagates a connection failure instead of silently returning no tools', async () => {
    mockService.connectServer.mockResolvedValue({ success: false, error: 'server down' });

    const result = await ToolHandler.processMCPNodes({
      mcpNodes: [mcpNode('demo-mcp-server', ['demo_read'])] as any,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error.code).toBe('server_connection_failed');
    // We must NOT have proceeded to list tools after a failed connect.
    expect(mockService.listServerTools).not.toHaveBeenCalled();
  });

  it('propagates a tool-listing failure instead of silently returning no tools', async () => {
    mockService.connectServer.mockResolvedValue({ success: true });
    // Mirrors a dead streamable-HTTP session that even the reconnect/retry could not recover.
    mockService.listServerTools.mockResolvedValue({ tools: [], error: 'fetch failed' });

    const result = await ToolHandler.processMCPNodes({
      mcpNodes: [mcpNode('demo-mcp-server', ['demo_read'])] as any,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error.code).toBe('list_tools_failed');
  });

  it('treats a successful-but-empty tool list as success (no enabled tools available)', async () => {
    mockService.connectServer.mockResolvedValue({ success: true });
    mockService.listServerTools.mockResolvedValue({ tools: [] });

    const result = await ToolHandler.processMCPNodes({
      mcpNodes: [mcpNode('demo-mcp-server', ['demo_read'])] as any,
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.value.availableTools).toEqual([]);
  });
});
