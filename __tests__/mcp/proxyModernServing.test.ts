/**
 * FLUJO's per-server proxy serves both protocol generations on one URL:
 * a 2026-07-28 client gets `server/discover` and stateless requests, an older
 * client keeps the classic `initialize` server. Both use the official SDK
 * clients over the real route; only the downstream forwarding is a fixture.
 */
import { Client as ModernClient, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

let modernProtocol = true;
jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/backend/services/mcp/betaClient', () => ({ isMcpBetaProtocolEnabled: async () => modernProtocol }));
jest.mock('@/backend/services/mcp/proxyForward', () => ({
  isLocalRequest: jest.requireActual('@/utils/http/localRequest').isLocalRequest,
  isServerExposed: jest.fn(async () => true),
  getProxyCapabilities: jest.fn(async () => ({})),
  proxyListTools: jest.fn(async () => ({ tools: [{ name: 'downstream_echo', inputSchema: { type: 'object' } }] })),
  proxyCallTool: jest.fn(async (_server: string, name: string, args: Record<string, unknown>,
    options?: { onProgress?: (progress: { progress: number; total?: number }) => void }) => {
    if (name === 'broken') throw new McpError(-32602, 'Downstream rejected the arguments', { field: 'text' });
    options?.onProgress?.({ progress: 1, total: 2 });
    return { content: [{ type: 'text', text: `forwarded:${String(args.text)}` }] };
  }),
  proxyListResources: jest.fn(async () => ({ resources: [{ uri: 'flujo://run/1', name: 'run' }] })),
  proxyListResourceTemplates: jest.fn(async () => ({ resourceTemplates: [] })),
  proxyReadResource: jest.fn(async (_server: string, uri: string) => ({ contents: [{ uri, text: 'resource body' }] })),
  proxyListSkills: jest.fn(), proxyGetSkill: jest.fn(), proxyReadSkillDirectory: jest.fn(),
}));

import { POST } from '@/app/mcp-proxy/[server]/route';
import { proxyCallTool } from '@/backend/services/mcp/proxyForward';

const url = 'http://localhost:4200/mcp-proxy/downstream';
const routeFetch = async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init);
  return POST(request, { params: Promise.resolve({ server: 'downstream' }) });
};
const local = { headers: { host: 'localhost:4200' } };

describe('per-server proxy serving both protocol generations', () => {
  beforeEach(() => { jest.clearAllMocks(); modernProtocol = true; });

  it('serves a 2026-07-28 client statelessly: discover, tools, progress, resources and error codes', async () => {
    const client = new ModernClient({ name: 'modern-proxy-test', version: '1' }, {
      capabilities: {}, versionNegotiation: { mode: { pin: '2026-07-28' } },
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: routeFetch, requestInit: local }));
    try {
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['downstream_echo']);
      const progress: number[] = [];
      expect(await client.callTool({ name: 'downstream_echo', arguments: { text: 'hi' } }, {
        onprogress: update => progress.push(update.progress),
      })).toMatchObject({ content: [{ type: 'text', text: 'forwarded:hi' }] });
      expect(progress).toEqual([1]);
      expect(jest.mocked(proxyCallTool).mock.calls[0][3]?.signal).toBeInstanceOf(AbortSignal);
      expect((await client.listResources()).resources).toEqual([{ uri: 'flujo://run/1', name: 'run' }]);
      expect((await client.readResource({ uri: 'flujo://run/1' })).contents).toEqual([{ uri: 'flujo://run/1', text: 'resource body' }]);
      await expect(client.callTool({ name: 'broken', arguments: {} })).rejects.toMatchObject({ code: -32602 });
    } finally { await client.close(); }
  });

  it('keeps an older client on the classic initialize server at the same URL', async () => {
    const client = new LegacyClient({ name: 'legacy-proxy-test', version: '1' }, { capabilities: {} });
    await client.connect(new LegacyTransport(new URL(url), { fetch: routeFetch, requestInit: local }));
    try {
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['downstream_echo']);
      expect(await client.callTool({ name: 'downstream_echo', arguments: { text: 'old' } }))
        .toMatchObject({ content: [{ type: 'text', text: 'forwarded:old' }] });
    } finally { await client.close(); }
  });

  it('lets a modern client fall back to the classic server when the owner forces the classic handshake', async () => {
    modernProtocol = false;
    const client = new ModernClient({ name: 'auto-proxy-test', version: '1' }, {
      capabilities: {}, versionNegotiation: { mode: 'auto' },
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: routeFetch, requestInit: local }));
    try {
      expect(client.getNegotiatedProtocolVersion()).not.toBe('2026-07-28');
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['downstream_echo']);
    } finally { await client.close(); }
  });
});
