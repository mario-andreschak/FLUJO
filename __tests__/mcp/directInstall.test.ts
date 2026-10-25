const loadServerConfigsMock = jest.fn();
const updateServerConfigMock = jest.fn();
const listServerToolsMock = jest.fn();
const deleteServerConfigMock = jest.fn();
jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    loadServerConfigs: (...args: unknown[]) => loadServerConfigsMock(...args),
    updateServerConfig: (...args: unknown[]) => updateServerConfigMock(...args),
    listServerTools: (...args: unknown[]) => listServerToolsMock(...args),
    deleteServerConfig: (...args: unknown[]) => deleteServerConfigMock(...args),
  },
}));

const installGithubServerMock = jest.fn();
jest.mock('@/backend/services/mcp/githubInstall', () => {
  const actual = jest.requireActual('@/backend/services/mcp/githubInstall');
  return {
    ...actual,
    installGithubServer: (...args: unknown[]) => installGithubServerMock(...args),
  };
});

import {
  installResolvedDirectMcp,
  looksLikeRegistryName,
  parseMcpCommandLine,
  resolveDirectMcpInstall,
} from '@/backend/services/mcp/directInstall';

const fetchMock = jest.fn();
const originalFetch = global.fetch;

beforeAll(() => {
  global.fetch = fetchMock as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

beforeEach(() => {
  jest.clearAllMocks();
  loadServerConfigsMock.mockResolvedValue([]);
  updateServerConfigMock.mockResolvedValue({ name: 'saved' });
  listServerToolsMock.mockResolvedValue({ tools: [{ name: 'ping', description: 'Ping' }] });
  deleteServerConfigMock.mockResolvedValue(undefined);
  installGithubServerMock.mockResolvedValue({ installed: true, serverName: 'repo' });
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes('/commits/')) {
      return { ok: true, json: async () => ({ sha: 'a'.repeat(40) }) } as Response;
    }
    if (url.includes('/contents/package.json')) {
      const body = Buffer.from(JSON.stringify({
        main: 'dist/index.js',
        packageManager: 'npm@11',
        scripts: { build: 'tsc' },
      })).toString('base64');
      return { ok: true, json: async () => ({ content: body }) } as Response;
    }
    if (url.includes('/contents?')) {
      return { ok: true, json: async () => [{ name: 'package-lock.json' }] } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  });
});

describe('specific MCP source resolution', () => {
  it('uses the published PyPI package from a GitHub server.json before frontend package.json', async () => {
    const fallbackFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string) => {
      if (!url.includes('/contents/server.json')) return fallbackFetch(url);
      return { ok: true, json: async () => ({ content: Buffer.from(JSON.stringify({
        name: 'io.github.flujo-app/mcp-virtual-computer',
        packages: [{ registryType: 'pypi', identifier: 'mcp-virtual-computer', version: '0.2.11', runtimeHint: 'uvx',
          transport: { type: 'stdio' }, environmentVariables: [{ name: 'COMPUTER_ID', default: 'agent-workstation', isRequired: true }],
        }],
      })).toString('base64') }) };
    });
    const input = { source: 'https://github.com/flujo-app/mcp-virtual-computer' };
    const resolved = await resolveDirectMcpInstall(input);
    expect(resolved.kind).toBe('server-json');
    expect(resolved.plan.command).toBe('uvx');
    expect(resolved.plan.args?.join(' ')).toContain('mcp-virtual-computer');
    expect(resolved.missingInputs).toEqual([]);
    expect(resolved.config?.env).toEqual(expect.objectContaining({ COMPUTER_ID: 'agent-workstation' }));
    expect(fetchMock.mock.calls.some(([url]) => url.includes('/contents/package.json'))).toBe(false);
    const result = await installResolvedDirectMcp(resolved, input);
    expect(result.installed).toBe(true);
    expect(installGithubServerMock).not.toHaveBeenCalled();
  });

  it('keeps owner/name-shaped Registry ids distinct from GitHub URLs', () => {
    expect(looksLikeRegistryName('ai.keenable/web-search')).toBe(true);
    expect(looksLikeRegistryName('https://github.com/acme/mcp-server')).toBe(false);
  });

  it('turns an npx line into an exact argv plan without a shell', async () => {
    expect(parseMcpCommandLine('npx -y "@acme/mcp server" --stdio')).toEqual({
      command: 'npx',
      args: ['-y', '@acme/mcp server', '--stdio'],
    });
    const resolved = await resolveDirectMcpInstall({ source: 'npx -y @acme/mcp', serverName: 'acme' });
    expect(resolved).toEqual(expect.objectContaining({
      kind: 'command',
      plan: expect.objectContaining({ command: 'npx', args: ['-y', '@acme/mcp'], serverName: 'acme' }),
    }));
    expect(() => parseMcpCommandLine('npx -y a; whoami')).toThrow('Shell operators');
    await expect(resolveDirectMcpInstall({
      source: 'npx -y @acme/mcp --token secret-value',
      env: { API_TOKEN: 'secret-value' },
    })).rejects.toThrow('Credential values must be passed only through env or headers');
  });

  it.each([
    [String.raw`node server.js C:\Users\Moe\Documents`, ['server.js', String.raw`C:\Users\Moe\Documents`]],
    [String.raw`node server.js "C:\Users\Moe\My Documents"`, ['server.js', String.raw`C:\Users\Moe\My Documents`]],
    [String.raw`node server.js "\\server\share\My Documents"`, ['server.js', String.raw`\\server\share\My Documents`]],
    [String.raw`node server.js '\\server\share\folder'`, ['server.js', String.raw`\\server\share\folder`]],
    [String.raw`node server.js "C:\\"`, ['server.js', 'C:\\']],
    [String.raw`node server.js 'C:\'`, ['server.js', 'C:\\']],
    [String.raw`node server.js "\\server\share\\"`, ['server.js', '\\\\server\\share\\']],
    [String.raw`node server.js plain\ text "plain\ text"`, ['server.js', 'plain text', String.raw`plain\ text`]],
    [String.raw`node server.js "say \"hello\"" don\'t`, ['server.js', 'say "hello"', "don't"]],
    [String.raw`node server.js "a\\\"b"`, ['server.js', 'a\\"b']],
    [String.raw`node server.js "a\q" a\\b`, ['server.js', String.raw`a\q`, String.raw`a\\b`]],
    [String.raw`node server.js "" '' a""b`, ['server.js', '', '', 'ab']],
    ['node server.js trailing\\ ', ['server.js', 'trailing ']],
    ['node server.js C:\\', ['server.js', 'C:\\']],
    [String.raw`node server.js "a;&|<>b" a\;b`, ['server.js', 'a;&|<>b', 'a;b']],
  ])('preserves exact argv for %s', (source, args) => {
    expect(parseMcpCommandLine(source)).toEqual({ command: 'node', args });
  });

  it.each([';', '&', '&&', '|', '||', '<', '>'])('refuses unquoted shell operator %s', operator => {
    expect(() => parseMcpCommandLine(`node server.js left${operator}right`)).toThrow('Shell operators');
  });

  it('refuses an unfinished double-quoted path', () => {
    expect(() => parseMcpCommandLine(String.raw`node server.js "C:\"`)).toThrow('unfinished');
  });

  it('does not discard an empty executable and shift arguments', () => {
    expect(() => parseMcpCommandLine('"" node server.js')).toThrow('Unsupported direct MCP command');
  });

  it.each([
    [String.raw`npx -y @modelcontextprotocol/server-filesystem "C:\Users\Moe\Documents"`, 'npx',
      ['-y', '@modelcontextprotocol/server-filesystem', String.raw`C:\Users\Moe\Documents`]],
    ['node server.js ""', 'node', ['server.js', '']],
    ['node server.js trailing\\ ', 'node', ['server.js', 'trailing ']],
    [String.raw`"C:\Program Files\nodejs\node.exe" server.js`, String.raw`C:\Program Files\nodejs\node.exe`, ['server.js']],
  ])('keeps preview and saved argv identical for %s', async (source, command, args) => {
    const input = { source, serverName: 'exact-argv' };
    const resolved = await resolveDirectMcpInstall(input);
    expect(resolved.plan).toEqual(expect.objectContaining({ command, args }));
    expect(resolved.config).toEqual(expect.objectContaining({ command, args }));
    const result = await installResolvedDirectMcp(resolved, input);
    expect(result.installed).toBe(true);
    expect(updateServerConfigMock).toHaveBeenCalledWith('exact-argv', expect.objectContaining({ transport: 'stdio', command, args }));
  });

  it('accepts a hosted URL and a GitHub repository as distinct plans', async () => {
    const remote = await resolveDirectMcpInstall({
      source: 'https://mcp.example.com/v1',
      serverName: 'hosted',
      headers: { Authorization: '${global:TOKEN}' },
    });
    expect(remote).toEqual(expect.objectContaining({
      kind: 'remote',
      plan: expect.objectContaining({ transport: 'streamable', serverUrl: 'https://mcp.example.com/v1' }),
    }));

    const github = await resolveDirectMcpInstall({
      source: 'https://github.com/acme/mcp-server.git',
      serverName: 'acme-github',
      ref: 'v1.2.3',
    });
    expect(github).toEqual(expect.objectContaining({
      kind: 'github',
      plan: expect.objectContaining({
        command: 'git',
        serverName: 'acme-github',
        steps: expect.arrayContaining([
          expect.objectContaining({ label: 'install-dependencies', args: ['npm install --include=dev'] }),
          expect.objectContaining({ label: 'build', args: ['npm run build'] }),
          expect.objectContaining({ label: 'launch', command: 'node', args: ['dist/index.js'] }),
        ]),
      }),
    }));
  });

  it('accepts official server.json and Claude-style mcpServers config', async () => {
    const serverJson = await resolveDirectMcpInstall({
      source: {
        name: 'io.example/search',
        packages: [{
          registryType: 'npm',
          identifier: '@example/search-mcp',
          version: '1.0.0',
          environmentVariables: [{ name: 'SEARCH_KEY', isRequired: true, isSecret: true }],
        }],
      },
      env: { SEARCH_KEY: 'secret' },
    });
    expect(serverJson).toEqual(expect.objectContaining({
      kind: 'server-json',
      missingInputs: [],
      plan: expect.objectContaining({ command: 'npx', args: ['-y', '@example/search-mcp@1.0.0'] }),
    }));

    const config = await resolveDirectMcpInstall({
      source: {
        mcpServers: {
          local: { command: 'uvx', args: ['example-mcp'], env: { MODE: 'safe' } },
        },
      },
    });
    expect(config).toEqual(expect.objectContaining({
      kind: 'config',
      plan: expect.objectContaining({ serverName: 'local', command: 'uvx', args: ['example-mcp'] }),
    }));
  });

  it('requires serverName when a config document contains multiple servers', async () => {
    await expect(resolveDirectMcpInstall({
      source: { mcpServers: { one: { command: 'npx' }, two: { command: 'uvx' } } },
    })).rejects.toThrow('multiple servers');
    await expect(resolveDirectMcpInstall({
      source: { command: 'powershell', args: ['-Command', 'whoami'] },
      serverName: 'unsafe',
    })).rejects.toThrow('Unsupported direct MCP command');
  });

  it('normalizes VS Code servers documents and common HTTP transport aliases', async () => {
    const resolved = await resolveDirectMcpInstall({
      source: { servers: { hosted: { type: 'http', url: 'https://mcp.example.com/api' } } },
    });
    expect(resolved).toEqual(expect.objectContaining({
      kind: 'config',
      plan: expect.objectContaining({ serverName: 'hosted', transport: 'streamable' }),
    }));
  });
});

describe('specific MCP source installation', () => {
  it('passes explicit env secrecy through the existing GitHub installer without including values in the plan', async () => {
    const secret = 'synthetic-github-token';
    const input = {
      source: 'https://github.com/acme/mcp-server', serverName: 'github-test',
      env: { TOKEN: { value: secret, metadata: { isSecret: true } }, OTHER: 'synthetic-other-key', MODE: 'validation-mode' },
      secretEnvNames: ['OTHER'],
    };
    const resolved = await resolveDirectMcpInstall(input);
    const result = await installResolvedDirectMcp(resolved, input);
    expect(result.installed).toBe(true);
    expect(installGithubServerMock).toHaveBeenCalledWith(expect.objectContaining({
      env: { TOKEN: secret, OTHER: 'synthetic-other-key', MODE: 'validation-mode' },
      secretEnvNames: ['TOKEN', 'OTHER'],
      ref: 'a'.repeat(40),
    }));
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('synthetic-other-key');
  });

  it('preserves wrapped config values and secret flags when overriding env and headers', async () => {
    const input = {
      source: {
        name: 'hosted-secrets', url: 'https://mcp.example.com',
        env: { TOKEN: { value: 'old-env-secret', metadata: { isSecret: true } } },
        headers: { 'X-Custom': { value: 'old-header-secret', metadata: { isSecret: true } } },
      },
      env: { TOKEN: 'synthetic-env-secret', EXTRA: { value: 'synthetic-extra-secret', metadata: { isSecret: true } } },
      headers: { 'X-Custom': 'synthetic-header-secret' },
    };
    const resolved = await resolveDirectMcpInstall(input);
    await installResolvedDirectMcp(resolved, input);
    expect(updateServerConfigMock).toHaveBeenCalledWith('hosted-secrets', expect.objectContaining({
      env: {
        TOKEN: { value: 'synthetic-env-secret', metadata: { isSecret: true } },
        EXTRA: { value: 'synthetic-extra-secret', metadata: { isSecret: true } },
      },
      headers: { 'X-Custom': { value: 'synthetic-header-secret', metadata: { isSecret: true } } },
    }));
    expect(JSON.stringify(resolved.plan)).not.toContain('synthetic-');
  });

  it('rejects malformed value metadata without echoing its contents', async () => {
    await expect(resolveDirectMcpInstall({
      source: { command: 'npx', args: ['example'], env: { TOKEN: { value: 'synthetic-secret', metadata: { isSecret: 'yes' } } } },
    })).rejects.toThrow('boolean secret metadata');
    await expect(resolveDirectMcpInstall({
      source: 'npx example --token synthetic-secret',
      env: { TOKEN: { value: 'synthetic-secret', metadata: { isSecret: true } } },
    })).rejects.toThrow('Credential values must be passed only through env or headers');
  });

  it('saves, connects, and returns the tools for a direct command', async () => {
    const input = { source: 'npx -y @acme/mcp', serverName: 'acme' };
    const resolved = await resolveDirectMcpInstall(input);
    const result = await installResolvedDirectMcp(resolved, input);
    expect(result).toEqual(expect.objectContaining({
      installed: true,
      serverName: 'acme',
      tools: [{ name: 'ping', description: 'Ping' }],
    }));
    expect(updateServerConfigMock).toHaveBeenCalledWith('acme', expect.objectContaining({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@acme/mcp'],
    }));
  });

  it('rolls back a new config that starts with no tools', async () => {
    listServerToolsMock.mockResolvedValue({ tools: [], error: 'handshake failed' });
    const input = { source: 'https://mcp.example.com', serverName: 'dead' };
    const resolved = await resolveDirectMcpInstall(input);
    const result = await installResolvedDirectMcp(resolved, input);
    expect(result).toEqual(expect.objectContaining({ installed: false, worksGateRejected: true }));
    expect(deleteServerConfigMock).toHaveBeenCalledWith('dead');
  });
});
