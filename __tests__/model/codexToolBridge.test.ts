import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startCodexToolBridge } from '@/backend/services/model/adapters/codexToolBridge';

describe('Codex tool bridge', () => {
  it('advertises host instructions during MCP initialization', async () => {
    const bridge = await startCodexToolBridge([], 'Use FLUJO tools as the filesystem authority.');
    const client = new Client({ name: 'codex-bridge-test', version: '1.0.0' });

    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url)));
      expect(client.getInstructions()).toBe('Use FLUJO tools as the filesystem authority.');
    } finally {
      await client.close().catch(() => undefined);
      await bridge.close();
    }
  });

  it('does not invent read-only annotations for tools with unknown side effects', async () => {
    const bridge = await startCodexToolBridge([{
      name: 'test__lookup',
      description: 'Looks something up',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    }]);
    const client = new Client({ name: 'codex-bridge-test', version: '1.0.0' });

    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url)));
      const result = await client.listTools();

      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].annotations).toBeUndefined();
    } finally {
      await client.close().catch(() => undefined);
      await bridge.close();
    }
  });

  it('preserves real annotations when the caller provides them', async () => {
    const annotations = {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    };
    const bridge = await startCodexToolBridge([{
      name: 'test__delete',
      description: 'Deletes something',
      inputSchema: { type: 'object', properties: {} },
      annotations,
      handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    }]);
    const client = new Client({ name: 'codex-bridge-test', version: '1.0.0' });

    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url)));
      const result = await client.listTools();

      expect(result.tools[0].annotations).toEqual(annotations);
    } finally {
      await client.close().catch(() => undefined);
      await bridge.close();
    }
  });

  it('passes the JSON-RPC callback identity to native tool handlers', async () => {
    const identities: Array<string | undefined> = [];
    const bridge = await startCodexToolBridge([{
      name: 'worker_search', description: 'Search', inputSchema: { type: 'object', properties: {} },
      handler: async (_args, identity) => {
        identities.push(identity);
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    }], undefined, true);
    const client = new Client({ name: 'codex-native-bridge-test', version: '1.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url)));
      await client.callTool({ name: 'worker_search', arguments: {} });
      expect(identities).toHaveLength(1);
      expect(identities[0]).toMatch(/^(number|string):/);
    } finally {
      await client.close().catch(() => undefined);
      await bridge.close();
    }
  });
});
