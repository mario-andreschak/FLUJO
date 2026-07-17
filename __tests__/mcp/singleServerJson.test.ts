import { buildSingleServerJson } from '@/utils/mcp/mcpFormats';
import { MCPServerConfig } from '@/shared/types/mcp';

/**
 * Covers the payload produced by the server card's "Copy MCP server JSON"
 * button (#110): a ready-to-paste, single-server MCP config JSON that reuses
 * the shared exporter and never leaks secrets for exposed servers.
 */
describe('buildSingleServerJson (#110 — copy server JSON)', () => {
  it('emits proxy-only JSON for an exposed server (no env/secrets)', () => {
    const server = {
      name: 'abap-mcp-flujo',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { SECRET: 'shh' },
      exposeAsMcpServer: true,
      disabled: false,
      autoApprove: [],
      rootPath: '',
      _buildCommand: '',
      _installCommand: '',
    } as unknown as MCPServerConfig;

    const json = buildSingleServerJson('abap-mcp-flujo', server, 'http://localhost:4200');
    const parsed = JSON.parse(json);

    expect(parsed).toEqual({
      mcpServers: {
        'abap-mcp-flujo': {
          type: 'http',
          url: 'http://localhost:4200/mcp-proxy/abap-mcp-flujo',
        },
      },
    });
    // The clipboard payload must not carry the secret.
    expect(json).not.toContain('shh');
    // Pretty-printed for direct pasting.
    expect(json).toContain('\n');
  });

  it('trims a trailing slash from the proxy base URL', () => {
    const server = {
      name: 'srv',
      transport: 'stdio',
      command: 'node',
      args: [],
      env: {},
      exposeAsMcpServer: true,
      disabled: false,
      autoApprove: [],
      rootPath: '',
      _buildCommand: '',
      _installCommand: '',
    } as unknown as MCPServerConfig;

    const parsed = JSON.parse(buildSingleServerJson('srv', server, 'http://localhost:4200/'));
    expect(parsed.mcpServers.srv.url).toBe('http://localhost:4200/mcp-proxy/srv');
  });

  it('falls back to the proxy-only shape when no config is supplied', () => {
    const parsed = JSON.parse(buildSingleServerJson('lonely', undefined, 'http://localhost:4200'));
    expect(parsed).toEqual({
      mcpServers: {
        lonely: { type: 'http', url: 'http://localhost:4200/mcp-proxy/lonely' },
      },
    });
  });

  it('exports the full transport entry for a non-exposed server', () => {
    const server = {
      name: 'api',
      transport: 'streamable',
      serverUrl: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
      env: {},
      disabled: false,
      autoApprove: [],
      rootPath: '',
      _buildCommand: '',
      _installCommand: '',
    } as unknown as MCPServerConfig;

    const parsed = JSON.parse(buildSingleServerJson('api', server, 'http://localhost:4200'));
    expect(parsed.mcpServers.api).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
    });
  });
});
