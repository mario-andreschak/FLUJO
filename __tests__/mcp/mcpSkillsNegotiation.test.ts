import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
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
    expect(declaredExtensions(createNewClient(config(true)))?.[MCP_SKILLS_EXTENSION_ID])
      .toBeUndefined();
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
