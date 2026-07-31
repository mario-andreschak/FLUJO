import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  capabilityKey,
  createNewClient,
  shouldRecreateClient,
} from '@/backend/services/mcp/connection';
import { createNewBetaClient } from '@/backend/services/mcp/betaClient';
import {
  MCP_APPS_EXTENSION_ID,
  MCP_APP_RESOURCE_MIME_TYPE,
} from '@/backend/services/mcp/appsProtocol';
import type { MCPServerConfig, MCPStdioConfig } from '@/shared/types/mcp';

type ClientCapabilitiesSnapshot = {
  extensions?: Record<string, { mimeTypes?: string[] }>;
};

const config = (
  enableMcpApps?: boolean,
  extra: Partial<MCPStdioConfig> = {}
): MCPServerConfig => ({
  name: 'apps-server',
  transport: 'stdio',
  command: 'node',
  args: ['server.js'],
  env: {},
  disabled: false,
  autoApprove: [],
  rootPath: '',
  _buildCommand: '',
  _installCommand: '',
  ...(enableMcpApps === undefined ? {} : { enableMcpApps }),
  ...extra,
} as MCPStdioConfig);

function declaredCapabilities(client: Client): ClientCapabilitiesSnapshot {
  return (client as unknown as { _capabilities: ClientCapabilitiesSnapshot })._capabilities;
}

describe('MCP Apps client capability negotiation', () => {
  it.each([
    ['stable v1', createNewClient],
    ['v2 beta', createNewBetaClient],
  ])('advertises the stable UI extension for opted-in servers on %s clients', (_label, factory) => {
    const capabilities = declaredCapabilities(factory(config(true)));

    expect(capabilities.extensions).toEqual({
      [MCP_APPS_EXTENSION_ID]: {
        mimeTypes: [MCP_APP_RESOURCE_MIME_TYPE],
      },
    });
  });

  it.each([
    ['stable v1', createNewClient],
    ['v2 beta', createNewBetaClient],
  ])('does not advertise MCP Apps for an unopted server on %s clients', (_label, factory) => {
    expect(declaredCapabilities(factory(config())).extensions).toBeUndefined();
    expect(declaredCapabilities(factory(config(false))).extensions).toBeUndefined();
  });

  it('includes the MCP Apps opt-in in the reconnect capability key', () => {
    expect(capabilityKey(config(false))).not.toBe(capabilityKey(config(true)));

    const client = createNewClient(config(false));
    const result = shouldRecreateClient(client, config(true));

    expect(result).toEqual({
      needsNewClient: true,
      reason: 'Client capabilities (sampling/elicitation/MCP Apps) changed',
    });
  });
});
