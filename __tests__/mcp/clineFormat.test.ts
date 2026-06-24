import { toClineFormat, fromClineFormat } from '@/utils/mcp/clineFormat';
import { getMcpFormat, MCP_FORMATS } from '@/utils/mcp/mcpFormats';
import { MCPServerConfig } from '@/shared/types/mcp';

const baseFields = {
  env: {},
  disabled: false,
  autoApprove: [],
  rootPath: '',
  _buildCommand: '',
  _installCommand: '',
};

describe('clineFormat — export (toClineFormat)', () => {
  it('emits stdio servers with command/args/env, disabled, autoApprove, timeout and no type', () => {
    const servers = [
      { ...baseFields, name: 'fs', transport: 'stdio', command: 'node', args: ['s.js'], env: { K: 'v' } },
    ] as unknown as MCPServerConfig[];

    const out = toClineFormat(servers);
    expect(out.mcpServers.fs).toEqual({
      command: 'node',
      args: ['s.js'],
      env: { K: 'v' },
      disabled: false,
      autoApprove: [],
      timeout: 60,
    });
    expect('type' in out.mcpServers.fs).toBe(false);
  });

  it('maps FLUJO streamable -> Cline type:streamableHttp with url + headers', () => {
    const servers = [
      {
        name: 'abap-ses',
        transport: 'streamable',
        serverUrl: 'https://abap-mcp.example/mcp',
        headers: { Authorization: 'Basic xxx', 'X-Client': '100' },
        disabled: true,
        autoApprove: [],
        rootPath: '',
        env: {},
        _buildCommand: '',
        _installCommand: '',
      },
    ] as unknown as MCPServerConfig[];

    const out = toClineFormat(servers);
    expect(out.mcpServers['abap-ses']).toEqual({
      type: 'streamableHttp',
      url: 'https://abap-mcp.example/mcp',
      headers: { Authorization: 'Basic xxx', 'X-Client': '100' },
      disabled: true,
      autoApprove: [],
      timeout: 60,
    });
  });

  it('exports exposed servers as streamableHttp proxy URLs', () => {
    const servers = [
      {
        name: 'test-flujo',
        transport: 'stdio',
        command: 'node',
        args: [],
        exposeAsMcpServer: true,
        disabled: true,
        autoApprove: [],
        env: { SECRET: 'x' },
        rootPath: '',
        _buildCommand: '',
        _installCommand: '',
      },
    ] as unknown as MCPServerConfig[];

    const out = toClineFormat(servers, { proxyBaseUrl: 'http://localhost:4200' });
    expect(out.mcpServers['test-flujo']).toEqual({
      type: 'streamableHttp',
      url: 'http://localhost:4200/mcp-proxy/test-flujo',
      disabled: true,
      autoApprove: [],
      timeout: 60,
    });
  });
});

describe('clineFormat — import (fromClineFormat)', () => {
  it('imports the user-provided Cline example (streamableHttp + headers + disabled)', () => {
    const json = JSON.stringify({
      mcpServers: {
        'abap-ses': {
          disabled: true,
          timeout: 60,
          type: 'streamableHttp',
          url: 'https://abap-mcp.example/mcp',
          headers: { Authorization: 'Basic xxx', 'X-SAP-Client': '100' },
        },
        'test-flujo-everything': {
          autoApprove: [],
          disabled: false,
          timeout: 60,
          type: 'streamableHttp',
          url: 'http://localhost:4200/mcp-proxy/everything',
        },
      },
    });

    const { servers, errors } = fromClineFormat(json);
    expect(errors).toEqual([]);
    expect(servers).toHaveLength(2);

    const ses = servers.find((s) => s.name === 'abap-ses') as any;
    expect(ses.transport).toBe('streamable');
    expect(ses.serverUrl).toBe('https://abap-mcp.example/mcp');
    expect(ses.headers).toEqual({ Authorization: 'Basic xxx', 'X-SAP-Client': '100' });
    expect(ses.disabled).toBe(true);

    const everything = servers.find((s) => s.name === 'test-flujo-everything') as any;
    expect(everything.transport).toBe('streamable');
    expect(everything.disabled).toBe(false);
  });
});

describe('mcpFormats registry', () => {
  it('exposes both Claude and Cline formats', () => {
    expect(MCP_FORMATS.map((f) => f.id).sort()).toEqual(['claude', 'cline']);
  });

  it('getMcpFormat resolves by id and falls back to the first format', () => {
    expect(getMcpFormat('cline').label).toBe('Cline');
    expect(getMcpFormat('claude').fileName).toBe('mcp_config.json');
    // Unknown id falls back rather than throwing.
    expect(getMcpFormat('nope' as any).id).toBe(MCP_FORMATS[0].id);
  });

  it('cline export uses its own filename', () => {
    expect(getMcpFormat('cline').fileName).toBe('cline_mcp_settings.json');
  });
});
