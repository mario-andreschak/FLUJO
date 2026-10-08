import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError, RequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  capabilityKey,
  createNewClient,
  shouldRecreateClient,
} from '@/backend/services/mcp/connection';
import { MCP_SKILLS_EXTENSION_ID } from '@/shared/types/mcp';
import type { MCPServerConfig, MCPStdioConfig } from '@/shared/types/mcp';

const config = (enableMcpSkills?: boolean): MCPServerConfig => ({
  name: 'skills-server',
  transport: 'stdio',
  command: 'node',
  args: ['server.js'],
  env: {},
  disabled: false,
  rootPath: '',
  _buildCommand: '',
  _installCommand: '',
  ...(enableMcpSkills === undefined ? {} : { enableMcpSkills }),
} as MCPStdioConfig);

function declaredExtensions(client: Client): Record<string, unknown> | undefined {
  return (client as unknown as {
    _capabilities: { extensions?: Record<string, unknown> };
  })._capabilities.extensions;
}

describe('MCP Skills negotiation', () => {
  it('is disabled by default and does not advertise a client-side extension', () => {
    expect(capabilityKey(config())).toContain('mcp-skills:off');
    expect(declaredExtensions(createNewClient(config()))?.[MCP_SKILLS_EXTENSION_ID])
      .toBeUndefined();
    expect(declaredExtensions(createNewClient(config(false)))?.[MCP_SKILLS_EXTENSION_ID])
      .toBeUndefined();
  });

  it('advertises the extension when enabled', () => {
    expect(declaredExtensions(createNewClient(config(true)))?.[MCP_SKILLS_EXTENSION_ID])
      .toEqual({});
  });

  it.each([true, false])('negotiates with a strict server when enabled=%s', async (enabled) => {
    const server = new Server(
      { name: 'strict-skills-reference', version: '1.0.0' },
      { capabilities: { resources: {}, extensions: { [MCP_SKILLS_EXTENSION_ID]: {} } } },
    );
    server.setRequestHandler(RequestSchema.extend({ method: z.literal('skills/list') }), async () => {
      if (!server.getClientCapabilities()?.extensions?.[MCP_SKILLS_EXTENSION_ID]) {
        throw new McpError(ErrorCode.MethodNotFound, 'Client did not advertise Skills');
      }
      return { resultType: 'complete', skills: [], ttlMs: 0, cacheScope: 'private' };
    });
    const client = createNewClient(config(enabled));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listing = client.request({ method: 'skills/list', params: {} }, z.object({ skills: z.array(z.unknown()) }));
      if (enabled) {
        await expect(listing).resolves.toEqual({ skills: [] });
      } else {
        await expect(listing).rejects.toThrow('Client did not advertise Skills');
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('recreates the client when the local Skills opt-in changes', () => {
    const disabled = config(false);
    const enabled = config(true);
    expect(capabilityKey(disabled)).not.toBe(capabilityKey(enabled));
    expect(shouldRecreateClient(createNewClient(disabled), enabled)).toEqual({
      needsNewClient: true,
      reason: 'Client capabilities (sampling/elicitation/MCP Apps/Skills) changed',
    });
  });
});
