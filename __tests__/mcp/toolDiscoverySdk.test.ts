import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CompleteToolDiscoveryClient } from '@/backend/services/mcp/toolDiscovery';

describe('complete discovery with the installed MCP SDK transport and validators', () => {
  it('retains 128 definitions, first/last output validation and task declarations', async () => {
    const tools = Array.from({ length: 128 }, (_, index) => ({
      name: `fixture_tool_${index + 1}`,
      inputSchema: { type: 'object' as const },
      outputSchema: {
        type: 'object' as const,
        required: ['ok'],
        properties: { ok: { type: 'boolean' } },
      },
      execution: { taskSupport: index === 0 || index === 127 ? 'required' as const : 'optional' as const },
      _meta: { ui: { resourceUri: 'ui://fixture' } },
    }));
    const cursors: (string | undefined)[] = [];
    const server = new Server({ name: '128-tool-fixture', version: '1' }, {
      capabilities: { tools: {}, tasks: { requests: { tools: { call: {} } } } },
    });
    server.setRequestHandler(ListToolsRequestSchema, async ({ params }) => {
      cursors.push(params?.cursor);
      const offset = Number(params?.cursor ?? 0);
      return {
        tools: tools.slice(offset, offset + 32),
        ...(offset + 32 < tools.length ? { nextCursor: String(offset + 32) } : {}),
      };
    });
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: 'text', text: 'invalid structured content' }],
      structuredContent: { ok: 'wrong type' },
    }));
    const client = new CompleteToolDiscoveryClient({ name: 'fixture-client', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.listTools();
      expect(result.tools).toEqual(tools);
      expect(result.nextCursor).toBeUndefined();
      expect(cursors).toEqual([undefined, '32', '64', '96']);
      // Assert public dispatch behavior, without inspecting SDK-private caches.
      await expect(client.callTool({ name: tools[0].name })).rejects.toThrow('task');
      await expect(client.callTool({ name: tools[127].name })).rejects.toThrow('task');
      await expect(client.callTool({ name: tools[1].name })).rejects.toThrow("tool's output schema");
      await expect(client.callTool({ name: tools[126].name })).rejects.toThrow("tool's output schema");

      // The explicit page API is still a page API for callers that supply a cursor.
      const page = await client.listTools({ cursor: '32' });
      expect(page.tools).toHaveLength(32);
      expect(page.nextCursor).toBe('64');
      expect(cursors).toHaveLength(5);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
