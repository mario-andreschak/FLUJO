/**
 * Tests for mcpResourceTools (issue #239).
 *
 * Pins:
 *  - buildMCPResourceTools returns [] when all servers have enabledResources: []
 *  - buildMCPResourceTools returns list_mcp_resources when resources exist
 *  - buildMCPResourceTools returns [] when all servers return empty lists
 *  - executeMCPResourceTool('list_mcp_resources') returns merged resources
 *  - executeMCPResourceTool applies URI filter when enabledResources is string[]
 *  - isMCPResourceToolName returns true only for list_mcp_resources
 *  - executeNativeReadResource: small text returned inline
 *  - executeNativeReadResource: URI not from any bound server → error
 *  - executeNativeReadResource: URI disallowed by enabledResources: [] → error
 */

// Mock mcpService before any imports
const mockListServerResources = jest.fn();
const mockListServerResourceTemplates = jest.fn();
const mockReadResource = jest.fn();
const mockWriteRunResource = jest.fn();

jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    listServerResources: (...args: unknown[]) => mockListServerResources(...args),
    listServerResourceTemplates: (...args: unknown[]) => mockListServerResourceTemplates(...args),
    readResource: (...args: unknown[]) => mockReadResource(...args),
  },
}));

jest.mock('@/backend/services/runResources', () => ({
  writeRunResource: (...args: unknown[]) => mockWriteRunResource(...args),
}));

// DEFAULT_RUN_RESOURCE_SETTINGS mock
jest.mock('@/shared/types/runResources', () => ({
  DEFAULT_RUN_RESOURCE_SETTINGS: {
    textThresholdChars: 100, // Small threshold for testing
    autoCaptureEnabled: true,
    maxResourceBytes: 50 * 1024 * 1024,
    maxConversationBytes: 256 * 1024 * 1024,
    replaceLargeTextWithStub: false,
  },
}));

import {
  buildMCPResourceTools,
  executeMCPResourceTool,
  executeNativeReadResource,
  isMCPResourceToolName,
  LIST_MCP_RESOURCES_TOOL_NAME,
} from '@/backend/execution/flow/handlers/mcpResourceTools';
import type { MCPNodeReference } from '@/backend/execution/flow/types';

// Helper: build a minimal MCPNodeReference
const mcpRef = (
  boundServer: string,
  enabledResources?: string[] | 'all',
): MCPNodeReference => ({
  id: `mcp-${boundServer}`,
  properties: { boundServer, enabledResources },
});

const sampleResource = (uri: string) => ({ uri, name: uri, description: '', mimeType: 'text/plain' });

beforeEach(() => {
  jest.clearAllMocks();
  // Default: no resources
  mockListServerResources.mockResolvedValue({ resources: [] });
  mockListServerResourceTemplates.mockResolvedValue({ resourceTemplates: [] });
});

// ---------------------------------------------------------------------------
// isMCPResourceToolName
// ---------------------------------------------------------------------------

describe('isMCPResourceToolName', () => {
  it('returns true for list_mcp_resources', () => {
    expect(isMCPResourceToolName(LIST_MCP_RESOURCES_TOOL_NAME)).toBe(true);
  });

  it('returns false for other names', () => {
    expect(isMCPResourceToolName('read_resource')).toBe(false);
    expect(isMCPResourceToolName('write_resource')).toBe(false);
    expect(isMCPResourceToolName('mcp_foo_bar')).toBe(false);
    expect(isMCPResourceToolName('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildMCPResourceTools
// ---------------------------------------------------------------------------

describe('buildMCPResourceTools', () => {
  it('returns [] when no mcpNodes', async () => {
    const tools = await buildMCPResourceTools([]);
    expect(tools).toEqual([]);
  });

  it('returns [] when all nodes have enabledResources: []', async () => {
    const tools = await buildMCPResourceTools([mcpRef('server-a', [])]);
    expect(tools).toEqual([]);
    expect(mockListServerResources).not.toHaveBeenCalled();
  });

  it('returns [] when all servers return empty resource lists', async () => {
    const tools = await buildMCPResourceTools([mcpRef('server-a', 'all')]);
    expect(tools).toEqual([]);
  });

  it('returns list_mcp_resources when a server has resources', async () => {
    mockListServerResources.mockResolvedValue({ resources: [sampleResource('file://test.txt')] });
    const tools = await buildMCPResourceTools([mcpRef('server-a', 'all')]);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe(LIST_MCP_RESOURCES_TOOL_NAME);
    expect(tools[0].description).toContain('server-a');
  });

  it('returns list_mcp_resources when a server has templates', async () => {
    mockListServerResourceTemplates.mockResolvedValue({
      resourceTemplates: [{ uriTemplate: 'file:///{path}', name: 'file', description: '', mimeType: 'text/plain' }],
    });
    const tools = await buildMCPResourceTools([mcpRef('server-b')]);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe(LIST_MCP_RESOURCES_TOOL_NAME);
  });

  it('applies enabledResources filter: only counts matching URIs', async () => {
    mockListServerResources.mockResolvedValue({
      resources: [sampleResource('file://a.txt'), sampleResource('file://b.txt')],
    });
    // Only 'file://a.txt' is in the allowlist
    const tools = await buildMCPResourceTools([mcpRef('server-a', ['file://a.txt'])]);
    expect(tools).toHaveLength(1);
  });

  it('returns [] when enabledResources filter excludes all resources', async () => {
    mockListServerResources.mockResolvedValue({
      resources: [sampleResource('file://a.txt')],
    });
    // No overlap
    const tools = await buildMCPResourceTools([mcpRef('server-a', ['file://other.txt'])]);
    expect(tools).toEqual([]);
  });

  it('tolerates listing errors gracefully', async () => {
    mockListServerResources.mockRejectedValue(new Error('network error'));
    const tools = await buildMCPResourceTools([mcpRef('server-a', 'all')]);
    // Should not throw; just return []
    expect(tools).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// executeMCPResourceTool — list_mcp_resources
// ---------------------------------------------------------------------------

describe('executeMCPResourceTool(list_mcp_resources)', () => {
  it('returns merged resources from two servers', async () => {
    mockListServerResources
      .mockResolvedValueOnce({ resources: [sampleResource('file://a.txt')] })
      .mockResolvedValueOnce({ resources: [sampleResource('asana://task/1')] });
    mockListServerResourceTemplates.mockResolvedValue({ resourceTemplates: [] });

    const ctx = {
      mcpNodes: [mcpRef('server-a', 'all'), mcpRef('server-b', 'all')],
    };
    const result = await executeMCPResourceTool(LIST_MCP_RESOURCES_TOOL_NAME, {}, ctx);

    expect(result.success).toBe(true);
    const data = result.data as { servers: Array<{ server: string; resources: unknown[] }> };
    expect(data.servers).toHaveLength(2);
    const serverA = data.servers.find((s) => s.server === 'server-a');
    const serverB = data.servers.find((s) => s.server === 'server-b');
    expect(serverA?.resources).toHaveLength(1);
    expect(serverB?.resources).toHaveLength(1);
  });

  it('applies server_filter arg', async () => {
    mockListServerResources.mockResolvedValue({ resources: [sampleResource('file://a.txt')] });
    mockListServerResourceTemplates.mockResolvedValue({ resourceTemplates: [] });

    const ctx = {
      mcpNodes: [mcpRef('server-a', 'all'), mcpRef('server-b', 'all')],
    };
    const result = await executeMCPResourceTool(LIST_MCP_RESOURCES_TOOL_NAME, { server_filter: 'server-a' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as { servers: Array<{ server: string }> };
    expect(data.servers.every((s) => s.server === 'server-a')).toBe(true);
  });

  it('applies enabledResources URI filter', async () => {
    mockListServerResources.mockResolvedValue({
      resources: [sampleResource('file://a.txt'), sampleResource('file://b.txt')],
    });
    mockListServerResourceTemplates.mockResolvedValue({ resourceTemplates: [] });

    const ctx = {
      mcpNodes: [mcpRef('server-a', ['file://a.txt'])],
    };
    const result = await executeMCPResourceTool(LIST_MCP_RESOURCES_TOOL_NAME, {}, ctx);

    expect(result.success).toBe(true);
    const data = result.data as { servers: Array<{ server: string; resources: Array<{ uri: string }> }> };
    expect(data.servers[0].resources).toHaveLength(1);
    expect(data.servers[0].resources[0].uri).toBe('file://a.txt');
  });

  it('skips nodes with enabledResources: []', async () => {
    const ctx = {
      mcpNodes: [mcpRef('server-a', [])],
    };
    const result = await executeMCPResourceTool(LIST_MCP_RESOURCES_TOOL_NAME, {}, ctx);
    expect(result.success).toBe(true);
    const data = result.data as { servers: unknown[] };
    expect(data.servers).toHaveLength(0);
    expect(mockListServerResources).not.toHaveBeenCalled();
  });

  it('returns error for unknown tool name', async () => {
    const ctx = { mcpNodes: [] };
    const result = await executeMCPResourceTool('unknown_tool', {}, ctx);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// executeNativeReadResource
// ---------------------------------------------------------------------------

describe('executeNativeReadResource', () => {
  it('returns inline text for small content', async () => {
    const smallText = 'hello world'; // Below 100-char threshold
    mockListServerResources.mockResolvedValue({ resources: [sampleResource('file://small.txt')] });
    mockReadResource.mockResolvedValue({
      success: true,
      data: { contents: [{ text: smallText }] },
    });

    const result = await executeNativeReadResource('file://small.txt', {
      mcpNodes: [mcpRef('server-a', 'all')],
      conversationId: 'conv-1',
    });

    expect(result.success).toBe(true);
    expect((result.data as { content: string }).content).toBe(smallText);
    expect(mockWriteRunResource).not.toHaveBeenCalled();
  });

  it('returns error when no bound server advertises the URI', async () => {
    mockListServerResources.mockResolvedValue({ resources: [] });

    const result = await executeNativeReadResource('file://unknown.txt', {
      mcpNodes: [mcpRef('server-a', 'all')],
      conversationId: 'conv-1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No bound MCP server');
  });

  it('returns error when URI is blocked by enabledResources: []', async () => {
    const result = await executeNativeReadResource('file://blocked.txt', {
      mcpNodes: [mcpRef('server-a', [])],
      conversationId: 'conv-1',
    });

    expect(result.success).toBe(false);
    expect(mockListServerResources).not.toHaveBeenCalled();
  });

  it('auto-captures large text and returns stub', async () => {
    const largeText = 'x'.repeat(200); // Above 100-char threshold
    mockListServerResources.mockResolvedValue({ resources: [sampleResource('file://large.txt')] });
    mockReadResource.mockResolvedValue({
      success: true,
      data: { contents: [{ text: largeText }] },
    });
    mockWriteRunResource.mockResolvedValue({
      uri: 'flujo://run/conv-1/res-1',
      size: 200,
      kind: 'text',
      mimeType: 'text/plain',
      name: undefined,
    });

    const result = await executeNativeReadResource('file://large.txt', {
      mcpNodes: [mcpRef('server-a', 'all')],
      conversationId: 'conv-1',
    });

    expect(result.success).toBe(true);
    expect(mockWriteRunResource).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conv-1',
      kind: 'text',
      data: { text: largeText },
      origin: { server: 'server-a', uri: 'file://large.txt' },
    }));
    // The result should contain the run-resource stub URI
    const data = result.data as { stub?: string; runUri?: string };
    expect(data.runUri).toBe('flujo://run/conv-1/res-1');
  });

  it('returns error from mcpService.readResource', async () => {
    mockListServerResources.mockResolvedValue({ resources: [sampleResource('file://err.txt')] });
    mockReadResource.mockResolvedValue({ success: false, error: 'access denied' });

    const result = await executeNativeReadResource('file://err.txt', {
      mcpNodes: [mcpRef('server-a', 'all')],
      conversationId: 'conv-1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('access denied');
  });
});
