/**
 * Regression test for MCPService.testConnection masked-header hydration (issue #137).
 *
 * When a remote (streamable/sse) MCP server has a secret header (e.g. Authorization), the
 * value is MASKED (`********`) before the config is sent to the browser. On Test Connection
 * the browser sends that masked value back verbatim. Before this fix the literal `********`
 * was forwarded as the header and the remote server rejected it with
 * "Authorization Token badly formatted".
 *
 * testConnection must now hydrate a masked SECRET header from the stored, saved config
 * (looked up by name, or by options.storedName after a rename) BEFORE resolving/decrypting,
 * so the real stored value — never the mask — reaches resolveConfigHeaders/createTransport.
 */

import { EventEmitter } from 'events';
import { MASKED_API_KEY } from '@/shared/types/constants';
import type { MCPServerConfig } from '@/shared/types/mcp';
import { MCP_HEADER_DESTINATION_CHANGED } from '@/utils/mcp/headerDestination';

// stdio transport stand-in (not used by the streamable path, but connection.ts imports it).
jest.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  class StdioClientTransport {
    public stderr = new EventEmitter();
    public onerror: ((err: Error) => void) | undefined;
  }
  return { StdioClientTransport };
});

jest.mock('@modelcontextprotocol/sdk/client/websocket.js', () => ({
  WebSocketClientTransport: class {},
}));

jest.mock('@/backend/utils/resolveGlobalVars', () => ({
  resolveGlobalVars: jest.fn(async (v: unknown) => v),
}));

const mockLoadServerConfigs = jest.fn();
jest.mock('@/backend/services/mcp/config', () => ({
  loadServerConfigs: (...args: unknown[]) => mockLoadServerConfigs(...args),
  saveConfig: jest.fn(async () => ({ success: true })),
}));

// The connection layer is mocked: createTransport returns a plain object (NOT an
// instanceof StdioClientTransport, so the stderr branch is skipped for the HTTP probe).
// resolveConfigHeaders is a pass-through spy so we can assert exactly what config
// testConnection handed it AFTER hydration.
jest.mock('@/backend/services/mcp/connection', () => ({
  createNewClient: jest.fn(),
  createTransport: jest.fn(() => ({ onerror: undefined })),
  resolveConfigHeaders: jest.fn(async (config: unknown) => config),
  safelyCloseClient: jest.fn(async () => undefined),
  shouldRecreateClient: jest.fn(() => ({ needsNewClient: false })),
}));

import { MCPService } from '@/backend/services/mcp';
import * as connection from '@/backend/services/mcp/connection';

function armClient() {
  const client = {
    connect: jest.fn(async () => undefined),
    listTools: jest.fn(async () => ({ tools: [] })),
    close: jest.fn(async () => undefined),
  };
  (connection.createNewClient as jest.Mock).mockReturnValue(client);
  return client;
}

const storedServer = {
  name: 'gh',
  transport: 'streamable' as const,
  serverUrl: 'http://localhost:3001',
  headers: { Authorization: { value: 'encrypted:REALTOKEN', metadata: { isSecret: true } } },
  disabled: false,
} as unknown as MCPServerConfig;

/** The config the browser sends back, carrying the masked placeholder. */
function maskedIncomingConfig(name = 'gh'): MCPServerConfig {
  return {
    name,
    transport: 'streamable',
    serverUrl: 'http://localhost:3001',
    headers: { Authorization: { value: MASKED_API_KEY, metadata: { isSecret: true } } },
    disabled: false,
  } as unknown as MCPServerConfig;
}

/** The headers testConnection passed into resolveConfigHeaders (after hydration). */
function resolvedInputHeaders(): Record<string, unknown> | undefined {
  const call = (connection.resolveConfigHeaders as jest.Mock).mock.calls[0];
  return (call?.[0] as { headers?: Record<string, unknown> })?.headers;
}

describe('MCPService.testConnection masked-header hydration (#137)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('hydrates a masked Authorization header from the stored config (never forwards the mask)', async () => {
    armClient();
    mockLoadServerConfigs.mockResolvedValue([storedServer]);

    const result = await new MCPService().testConnection(maskedIncomingConfig());

    expect(result.success).toBe(true);
    const headers = resolvedInputHeaders();
    expect(headers?.Authorization).toEqual({ value: 'encrypted:REALTOKEN', metadata: { isSecret: true } });
    // The literal mask must NEVER reach the resolver / the wire.
    expect(JSON.stringify(headers)).not.toContain(MASKED_API_KEY);
  });

  it('hydrates from the pre-edit name (options.storedName) so rename + Test Connection works', async () => {
    armClient();
    mockLoadServerConfigs.mockResolvedValue([storedServer]);

    // Config sent under a NEW name, but storedName still points at the saved server.
    await new MCPService().testConnection(maskedIncomingConfig('gh-renamed'), undefined, { storedName: 'gh' });

    const headers = resolvedInputHeaders();
    expect(headers?.Authorization).toEqual({ value: 'encrypted:REALTOKEN', metadata: { isSecret: true } });
    expect(JSON.stringify(headers)).not.toContain(MASKED_API_KEY);
  });

  it('drops the masked header when there is no matching stored server (never sends the mask)', async () => {
    armClient();
    mockLoadServerConfigs.mockResolvedValue([]); // nothing stored to hydrate from

    await new MCPService().testConnection(maskedIncomingConfig());

    const headers = resolvedInputHeaders();
    expect(headers?.Authorization).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain(MASKED_API_KEY);
  });

  it('passes a freshly typed plaintext token through unchanged (new server flow)', async () => {
    armClient();
    mockLoadServerConfigs.mockResolvedValue([]);

    const fresh = {
      name: 'gh',
      transport: 'streamable',
      serverUrl: 'http://localhost:3001',
      headers: { Authorization: { value: 'Bearer plaintext', metadata: { isSecret: true } } },
      disabled: false,
    } as unknown as MCPServerConfig;

    await new MCPService().testConnection(fresh);

    const headers = resolvedInputHeaders();
    expect(headers?.Authorization).toEqual({ value: 'Bearer plaintext', metadata: { isSecret: true } });
  });

  it.each([
    { serverUrl: 'https://other.example/mcp' },
    { name: 'renamed', serverUrl: 'https://other.example/mcp' },
    { serverUrl: 'http://saved.example/mcp' },
    { serverUrl: 'https://saved.example:444/mcp' },
    { serverUrl: 'https://saved.example/other' },
    { serverUrl: 'https://saved.example/mcp?tenant=other' },
    { serverUrl: 'not a URL' },
    { serverUrl: 'file:///mcp' },
    { transport: 'sse' },
  ])('refuses automatic secret reuse for %j before resolution or construction', async (changes) => {
    const client = armClient();
    mockLoadServerConfigs.mockResolvedValue([{ ...storedServer, serverUrl: 'https://saved.example/mcp' }]);
    const incoming = { ...maskedIncomingConfig(), serverUrl: 'https://saved.example/mcp', ...changes } as MCPServerConfig;
    const before = structuredClone(incoming);
    const emit = jest.fn();

    const result = await new MCPService().testConnection(incoming, emit, { storedName: 'gh' });

    expect(result).toEqual({ success: false, error: MCP_HEADER_DESTINATION_CHANGED, statusCode: 400 });
    expect(connection.resolveConfigHeaders).not.toHaveBeenCalled();
    expect(connection.createNewClient).not.toHaveBeenCalled();
    expect(connection.createTransport).not.toHaveBeenCalled();
    expect(client.connect).not.toHaveBeenCalled();
    expect(connection.safelyCloseClient).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ type: 'result', success: false, error: MCP_HEADER_DESTINATION_CHANGED });
    expect(incoming).toEqual(before);
    expect(JSON.stringify(result)).not.toContain('REALTOKEN');
  });

  it('keeps normalization and rename working at the same HTTPS endpoint', async () => {
    armClient();
    mockLoadServerConfigs.mockResolvedValue([{ ...storedServer, serverUrl: 'https://saved.example/mcp' }]);
    const incoming = { ...maskedIncomingConfig('renamed'), serverUrl: 'https://SAVED.example:443/mcp#editor' } as MCPServerConfig;
    const result = await new MCPService().testConnection(incoming, undefined, { storedName: 'gh' });
    expect(result.success).toBe(true);
    expect(resolvedInputHeaders()?.Authorization).toEqual({ value: 'encrypted:REALTOKEN', metadata: { isSecret: true } });
  });

  it('allows a caller to supply a fresh explicit header for a changed destination', async () => {
    armClient();
    mockLoadServerConfigs.mockResolvedValue([storedServer]);
    const headers = { Authorization: { value: 'Bearer SYNTHETIC_FRESH', metadata: { isSecret: true } } };
    const incoming = {
      ...maskedIncomingConfig(), serverUrl: 'https://other.example/mcp',
      headers,
    } as MCPServerConfig;
    const result = await new MCPService().testConnection(incoming);
    expect(result.success).toBe(true);
    expect(resolvedInputHeaders()?.Authorization).toEqual(headers.Authorization);
  });

  it('rejects a legacy string mask when the saved destination is malformed', async () => {
    armClient();
    mockLoadServerConfigs.mockResolvedValue([{ ...storedServer, serverUrl: 'not a URL' }]);
    const incoming = { ...maskedIncomingConfig(), headers: { Authorization: MASKED_API_KEY } } as MCPServerConfig;
    const result = await new MCPService().testConnection(incoming);
    expect(result.success).toBe(false);
    expect(connection.resolveConfigHeaders).not.toHaveBeenCalled();
  });
});
