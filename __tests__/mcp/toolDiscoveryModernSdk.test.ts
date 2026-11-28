import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { Server } from '@modelcontextprotocol/server';
import type { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js';
import { listServerTools } from '@/backend/services/mcp/tools';
import { rejectRepeatedToolCursors } from '@/backend/services/mcp/toolDiscovery';

class ModernServer extends Server {
  // Raw in-memory transports have no HTTP serving entry to bind the era.
  serveModern(): void { this._negotiatedProtocolVersion = '2026-07-28'; }
}

const tools = Array.from({ length: 128 }, (_, index) => ({ name: `fixture_tool_${index + 1}`, inputSchema: { type: 'object' as const } }));

/** Pages of 32; in "stuck" mode the second page points back to itself, like the browser fixture's cycle mode. */
async function connect(stuck: boolean, guarded: boolean) {
  const cursors: (string | undefined)[] = [];
  const server = new ModernServer({ name: 'paged-fixture', version: '1' }, {
    capabilities: { tools: {} }, supportedProtocolVersions: ['2026-07-28', '2025-11-25'],
  });
  server.serveModern();
  server.setRequestHandler('tools/list', (request) => {
    const cursor = request.params?.cursor;
    cursors.push(cursor);
    const offset = Number(cursor ?? 0);
    const next = stuck && offset === 32 ? '32' : offset + 32 < tools.length ? String(offset + 32) : undefined;
    return { tools: tools.slice(offset, offset + 32), ...(next ? { nextCursor: next } : {}) };
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const plain = new Client({ name: 'flujo-test', version: '1' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } });
  const client = guarded ? rejectRepeatedToolCursors(plain) : plain;
  await client.connect(clientSide);
  return { client, cursors, close: async () => { await client.close(); await server.close(); } };
}

describe('complete tool discovery with the modern SDK client (#572)', () => {
  it('still lists all 128 tools from a well-behaved server', async () => {
    const peer = await connect(false, true);
    try {
      const result = await peer.client.listTools();
      expect(result.tools.map((tool) => tool.name)).toEqual(tools.map((tool) => tool.name));
      expect(peer.cursors).toEqual([undefined, '32', '64', '96']);
    } finally { await peer.close(); }
  });

  it('shows why the guard exists: the SDK alone returns a shortened list for a stuck cursor', async () => {
    const peer = await connect(true, false);
    try {
      expect((await peer.client.listTools()).tools).toHaveLength(64);
    } finally { await peer.close(); }
  });

  it('fails discovery with a clear error instead of a shortened list', async () => {
    const peer = await connect(true, true);
    try {
      await expect(peer.client.listTools()).rejects.toThrow('repeated cursor');
      const result = await listServerTools(peer.client as unknown as V1Client, 'paged-fixture', 'all');
      expect(result.tools).toEqual([]);
      expect(result.error).toContain('repeated cursor');
    } finally { await peer.close(); }
  });
});
