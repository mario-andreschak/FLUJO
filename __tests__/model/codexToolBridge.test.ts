import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startCodexToolBridge } from '@/backend/services/model/adapters/codexToolBridge';

describe('Codex tool bridge', () => {
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
});
