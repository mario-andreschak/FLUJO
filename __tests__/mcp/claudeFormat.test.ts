import { toClaudeFormat, fromClaudeFormat } from '@/utils/mcp/claudeFormat';
import { MCPServerConfig } from '@/shared/types/mcp';

describe('claudeFormat — export (toClaudeFormat)', () => {
  it('emits stdio servers with command/args/env and no type field', () => {
    const servers = [
      {
        name: 'fs',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'server-filesystem'],
        env: { API_KEY: 'abc' },
        disabled: false,
        autoApprove: [],
        rootPath: '',
        _buildCommand: '',
        _installCommand: '',
      },
    ] as unknown as MCPServerConfig[];

    const out = toClaudeFormat(servers);
    expect(out.mcpServers.fs).toEqual({
      command: 'npx',
      args: ['-y', 'server-filesystem'],
      env: { API_KEY: 'abc' },
    });
    expect('type' in out.mcpServers.fs).toBe(false);
  });

  it('maps FLUJO streamable -> Claude type:http with url + headers', () => {
    const servers = [
      {
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
      },
    ] as unknown as MCPServerConfig[];

    const out = toClaudeFormat(servers);
    expect(out.mcpServers.api).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
    });
  });

  it('maps sse -> type:sse and websocket -> type:ws', () => {
    const servers = [
      {
        name: 'sse-srv',
        transport: 'sse',
        serverUrl: 'https://example.com/sse',
        env: {},
        disabled: false,
        autoApprove: [],
        rootPath: '',
        _buildCommand: '',
        _installCommand: '',
      },
      {
        name: 'ws-srv',
        transport: 'websocket',
        websocketUrl: 'wss://example.com/socket',
        env: {},
        disabled: false,
        autoApprove: [],
        rootPath: '',
        _buildCommand: '',
        _installCommand: '',
      },
    ] as unknown as MCPServerConfig[];

    const out = toClaudeFormat(servers);
    expect(out.mcpServers['sse-srv']).toEqual({ type: 'sse', url: 'https://example.com/sse' });
    expect(out.mcpServers['ws-srv']).toEqual({ type: 'ws', url: 'wss://example.com/socket' });
  });

  it('flattens secret env values ({value, metadata}) to plain strings', () => {
    const servers = [
      {
        name: 'fs',
        transport: 'stdio',
        command: 'node',
        args: [],
        env: { TOKEN: { value: 'sekret', metadata: { isSecret: true } } },
        disabled: false,
        autoApprove: [],
        rootPath: '',
        _buildCommand: '',
        _installCommand: '',
      },
    ] as unknown as MCPServerConfig[];

    const out = toClaudeFormat(servers);
    expect(out.mcpServers.fs.env).toEqual({ TOKEN: 'sekret' });
  });

  it('exports exposed servers as http URLs against the FLUJO mcp-proxy', () => {
    const servers = [
      {
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
      },
    ] as unknown as MCPServerConfig[];

    const out = toClaudeFormat(servers, { proxyBaseUrl: 'http://localhost:4200' });
    // The proxy URL replaces the real transport, and no secrets leak.
    expect(out.mcpServers['abap-mcp-flujo']).toEqual({
      type: 'http',
      url: 'http://localhost:4200/mcp-proxy/abap-mcp-flujo',
    });
  });
});

describe('claudeFormat — import (fromClaudeFormat)', () => {
  it('imports a stdio server with no type field', () => {
    const json = JSON.stringify({
      mcpServers: {
        fs: { command: 'npx', args: ['-y', 'srv'], env: { K: 'v' } },
      },
    });
    const { servers, errors } = fromClaudeFormat(json);
    expect(errors).toEqual([]);
    expect(servers).toHaveLength(1);
    const s = servers[0] as any;
    expect(s.transport).toBe('stdio');
    expect(s.command).toBe('npx');
    expect(s.args).toEqual(['-y', 'srv']);
    expect(s.env).toEqual({ K: 'v' });
    expect(s.disabled).toBe(false);
    expect(s.autoApprove).toEqual([]);
  });

  it('maps Claude type aliases (http, streamable-http) to streamable', () => {
    const json = JSON.stringify({
      mcpServers: {
        a: { type: 'http', url: 'https://a.example/mcp' },
        b: { type: 'streamable-http', url: 'https://b.example/mcp', headers: { X: '1' } },
      },
    });
    const { servers, errors } = fromClaudeFormat(json);
    expect(errors).toEqual([]);
    const a = servers.find((s) => s.name === 'a') as any;
    const b = servers.find((s) => s.name === 'b') as any;
    expect(a.transport).toBe('streamable');
    expect(a.serverUrl).toBe('https://a.example/mcp');
    expect(b.transport).toBe('streamable');
    expect(b.headers).toEqual({ X: '1' });
  });

  it('maps sse and ws/websocket types', () => {
    const json = JSON.stringify({
      mcpServers: {
        s: { type: 'sse', url: 'https://s.example/sse' },
        w: { type: 'ws', url: 'wss://w.example/socket' },
        w2: { type: 'websocket', url: 'wss://w2.example/socket' },
      },
    });
    const { servers, errors } = fromClaudeFormat(json);
    expect(errors).toEqual([]);
    expect((servers.find((s) => s.name === 's') as any).transport).toBe('sse');
    const w = servers.find((s) => s.name === 'w') as any;
    expect(w.transport).toBe('websocket');
    expect(w.websocketUrl).toBe('wss://w.example/socket');
    expect((servers.find((s) => s.name === 'w2') as any).transport).toBe('websocket');
  });

  it('reports an error for stdio entries missing a command, but imports the rest', () => {
    const json = JSON.stringify({
      mcpServers: {
        good: { command: 'node' },
        bad: { args: ['x'] },
      },
    });
    const { servers, errors } = fromClaudeFormat(json);
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('good');
    expect(errors.some((e) => e.includes('bad'))).toBe(true);
  });

  it('returns an error for invalid JSON', () => {
    const { servers, errors } = fromClaudeFormat('{ not json');
    expect(servers).toEqual([]);
    expect(errors[0]).toMatch(/Invalid JSON/);
  });

  it('accepts a bare server map without the mcpServers wrapper', () => {
    const json = JSON.stringify({ solo: { command: 'node' } });
    const { servers, errors } = fromClaudeFormat(json);
    expect(errors).toEqual([]);
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('solo');
  });

  it('round-trips a FLUJO export back into equivalent configs', () => {
    const original = [
      {
        name: 'fs',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'srv'],
        env: { K: 'v' },
        disabled: false,
        autoApprove: [],
        rootPath: '',
        _buildCommand: '',
        _installCommand: '',
      },
      {
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
      },
    ] as unknown as MCPServerConfig[];

    const exported = toClaudeFormat(original);
    const { servers, errors } = fromClaudeFormat(exported);
    expect(errors).toEqual([]);
    const fs = servers.find((s) => s.name === 'fs') as any;
    const api = servers.find((s) => s.name === 'api') as any;
    expect(fs.transport).toBe('stdio');
    expect(fs.command).toBe('npx');
    expect(api.transport).toBe('streamable');
    expect(api.serverUrl).toBe('https://example.com/mcp');
    expect(api.headers).toEqual({ Authorization: 'Bearer x' });
  });
});
