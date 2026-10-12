jest.mock('@/backend/utils/resolveGlobalVars', () => ({
  resolveGlobalVars: jest.fn(async (value: unknown) => value),
}));
jest.mock('@/backend/services/mcp/config', () => ({
  loadServerConfigs: jest.fn(async () => [{ name: 'fixture', transport: 'streamable',
    serverUrl: 'https://pagination.example.test/mcp', disabled: false, enableMcpApps: true }]),
}));

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { callTool, listServerTools } from '@/backend/services/mcp/tools';

const tools = Array.from({ length: 128 }, (_, index) => ({
  name: `fixture_tool_${String(index + 1).padStart(3, '0')}`,
  title: `Fixture tool ${index + 1}`,
  description: 'A deterministic local fixture',
  inputSchema: { type: 'object' as const, properties: { options: { type: 'object' } } },
  outputSchema: { type: 'object' as const },
  annotations: { readOnlyHint: true },
  _meta: { ui: { resourceUri: 'ui://fixture', visibility: index === 127 ? ['app'] : ['model', 'app'] } },
}));

function paginatedClient() {
  const listTools = jest.fn(async (params?: { cursor?: string }) => {
    const offset = params?.cursor === undefined ? 0 : Number(params.cursor);
    return {
      tools: tools.slice(offset, offset + 32),
      ...(offset + 32 < tools.length ? { nextCursor: String(offset + 32) } : {}),
    };
  });
  const callTool = jest.fn(async () => ({ content: [{ type: 'text', text: 'fixture result' }] }));
  return { client: { listTools, callTool } as unknown as Client, listTools, callTool };
}

describe('complete MCP tool discovery', () => {
  it('returns all 128 definitions in order, retaining schemas and App metadata', async () => {
    const { client, listTools } = paginatedClient();
    const result = await listServerTools(client, 'fixture', 'all');

    expect(result.error).toBeUndefined();
    expect(result.tools).toEqual(tools);
    expect(listTools.mock.calls).toEqual([[], [{ cursor: '32' }], [{ cursor: '64' }], [{ cursor: '96' }]]);
  });

  it('filters audiences after complete discovery and authorizes a late-page App tool', async () => {
    const fixture = paginatedClient();
    const modelResult = await listServerTools(fixture.client, 'fixture', 'model');
    const appResult = await listServerTools(fixture.client, 'fixture', 'app');
    expect(modelResult.tools).toHaveLength(127);
    expect(appResult.tools).toHaveLength(128);

    const denied = await callTool(fixture.client, 'fixture', tools[127].name, {}, undefined, undefined, undefined, 'model');
    expect(denied.statusCode).toBe(403);
    expect(fixture.callTool).not.toHaveBeenCalled();
    const allowed = await callTool(fixture.client, 'fixture', tools[127].name, {}, undefined, undefined, undefined, 'app');
    expect(allowed.success).toBe(true);
    expect(fixture.callTool).toHaveBeenCalledTimes(1);
  });

  it('does not publish a successful partial list if a later page fails', async () => {
    const listTools = jest.fn()
      .mockResolvedValueOnce({ tools: tools.slice(0, 32), nextCursor: 'second' })
      .mockRejectedValueOnce(new Error('page unavailable'));
    const result = await listServerTools({ listTools } as unknown as Client, 'fixture', 'all');
    expect(result).toEqual({ tools: [], error: 'Failed to list tools: page unavailable' });
  });

  it('terminates a cursor cycle with a useful error instead of returning partial tools', async () => {
    const listTools = jest.fn()
      .mockResolvedValueOnce({ tools: tools.slice(0, 32), nextCursor: 'A' })
      .mockResolvedValueOnce({ tools: [], nextCursor: 'B' })
      .mockResolvedValueOnce({ tools: [], nextCursor: 'A' });
    const result = await listServerTools({ listTools } as unknown as Client, 'fixture', 'all');
    expect(listTools).toHaveBeenCalledTimes(3);
    expect(result.tools).toEqual([]);
    expect(result.error).toContain('repeated cursor');
  });

  it('treats an empty string as an opaque cursor rather than end of discovery', async () => {
    const listTools = jest.fn()
      .mockResolvedValueOnce({ tools: [], nextCursor: '' })
      .mockResolvedValueOnce({ tools: [tools[127]] });
    const result = await listServerTools({ listTools } as unknown as Client, 'fixture', 'all');
    expect(listTools).toHaveBeenLastCalledWith({ cursor: '' });
    expect(result.tools).toEqual([tools[127]]);
  });

  it('bounds a server producing endless distinct cursors', async () => {
    let page = 0;
    const listTools = jest.fn(async () => ({ tools: [], nextCursor: String(++page) }));
    const result = await listServerTools({ listTools } as unknown as Client, 'fixture', 'all');
    expect(listTools).toHaveBeenCalledTimes(1000);
    expect(result.tools).toEqual([]);
    expect(result.error).toContain('exceeded 1000 pages');
  });
});
