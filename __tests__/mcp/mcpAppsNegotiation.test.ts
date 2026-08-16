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
import {
  STDIO_OAUTH_EXTENSION_CAPABILITY,
  STDIO_OAUTH_EXTENSION_ID,
} from 'mcp-stdio-oauth/protocol';
import type { MCPServerConfig, MCPStdioConfig } from '@/shared/types/mcp';

type ClientCapabilitiesSnapshot = {
  extensions?: Record<string, Record<string, unknown>>;
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
  rootPath: '',
  _buildCommand: '',
  _installCommand: '',
  ...(enableMcpApps === undefined ? {} : { enableMcpApps }),
  ...extra,
} as MCPStdioConfig);

function declaredCapabilities(client: Client): ClientCapabilitiesSnapshot {
  return (client as unknown as { _capabilities: ClientCapabilitiesSnapshot })._capabilities;
}

const remoteConfig = (): MCPServerConfig => ({
  name: 'remote-server',
  transport: 'streamable',
  serverUrl: 'https://mcp.example.test/mcp',
  headers: {},
  env: {},
  disabled: false,
  rootPath: '',
  _buildCommand: '',
  _installCommand: '',
} as MCPServerConfig);

describe('MCP Apps client capability negotiation', () => {
  it.each([
    ['stable v1', createNewClient],
    ['v2 beta', createNewBetaClient],
  ])('advertises mcp-stdio-oauth only to local stdio servers on %s clients', (_label, factory) => {
    expect(
      declaredCapabilities(factory(config())).extensions?.[STDIO_OAUTH_EXTENSION_ID],
    ).toEqual(STDIO_OAUTH_EXTENSION_CAPABILITY);
    expect(
      declaredCapabilities(factory(remoteConfig())).extensions?.[STDIO_OAUTH_EXTENSION_ID],
    ).toBeUndefined();
  });

  it.each([
    ['stable v1', createNewClient],
    ['v2 beta', createNewBetaClient],
  ])('advertises the stable UI extension for opted-in servers on %s clients', (_label, factory) => {
    const capabilities = declaredCapabilities(factory(config(true)));

    expect(capabilities.extensions).toEqual({
      [STDIO_OAUTH_EXTENSION_ID]: STDIO_OAUTH_EXTENSION_CAPABILITY,
      [MCP_APPS_EXTENSION_ID]: {
        mimeTypes: [MCP_APP_RESOURCE_MIME_TYPE],
      },
    });
  });

  it.each([
    ['stable v1', createNewClient],
    ['v2 beta', createNewBetaClient],
  ])('does not advertise MCP Apps for an unopted server on %s clients', (_label, factory) => {
    expect(
      declaredCapabilities(factory(config())).extensions?.[MCP_APPS_EXTENSION_ID],
    ).toBeUndefined();
    expect(
      declaredCapabilities(factory(config(false))).extensions?.[MCP_APPS_EXTENSION_ID],
    ).toBeUndefined();
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
